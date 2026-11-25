/**
 * Recent Imagery drapes two slots through the renderer's globe port, slot
 * `a` left of a swipe and slot `b` right. Each slot drapes up to two GIBS
 * layers, one per available part, on whichever surface the map stack draws.
 * Against the basemap slot `a` splits left and slot `b` stays empty. Tile
 * requests pass a small semaphore of our own, shared by both slots, through
 * each layer's admission hook; the renderer's own request limits stay
 * untouched.
 */
// The imagery drapes through the globe port and the box preview draws
// through `drawOf`, both on the renderer's ports: a viewer with no renderer
// bound gets them once its owner has loaded the package's
// `./render/cesium/unbound` export. A tileset host is marked as a base the
// globe port drapes on (`markBaseTileset`).
import { fromDegrees } from '../../geo/ellipsoid.js';
import { markBaseTileset } from '../../render/baseTilesets.js';
import { drawOf } from '../../render/rendererOf.js';
import {
  PRODUCTS,
  boxKey,
  gibsTemplate,
  lonSpanDeg,
  nonCrossingBoxes,
} from './model.js';

const SLOT_IDS = ['a', 'b'];
const SPLITS = new Set(['left', 'right', 'none']);
const NO_HOST = Object.freeze({ collection: null, kind: 'none', globe: null });

/** Render reason for a settled tile request. */
export const TILE_RENDER_REASON = 'recent-imagery-tiles';

function clampAlpha(value) {
  const alpha = Number(value);
  return Number.isFinite(alpha) ? Math.max(0, Math.min(1, alpha)) : 1;
}

/** One comparable key for a slot's draped parts. */
const partsKey = (parts) => parts.map(boxKey).sort().join(';');

/**
 * The parts of a box a slot drapes. The VIIRS JPEG has no alpha and would
 * draw an empty side black, so it drapes only parts Worldview confirmed
 * present, and no part of a dateline box before the probe answers. A PNG
 * drapes every part not confirmed empty.
 */
function drapedParts(candidate, box, { availableBoxes, emptyBoxes }) {
  const parts = nonCrossingBoxes(box);
  const keys = (list) => new Set(list.map(boxKey));
  if (PRODUCTS[candidate.product]?.format !== 'jpg') {
    if (!Array.isArray(emptyBoxes)) return parts;
    const empty = keys(emptyBoxes);
    return parts.filter((part) => !empty.has(boxKey(part)));
  }
  if (!Array.isArray(availableBoxes)) return parts.length > 1 ? [] : parts;
  const proven = keys(availableBoxes);
  return parts.filter((part) => proven.has(boxKey(part)));
}

/**
 * Admit a tile request while the semaphore has room. A request that finds
 * it full is deferred and asks for no frame itself: the request holding the
 * slot asks for one as it settles. One the renderer itself defers frees its
 * slot at once, and the renderer asks again on a later frame.
 */
function admitTileRequests(admission, requestRender) {
  return (_tile, issue) => {
    if (admission.inFlight >= admission.limit) return undefined;
    admission.inFlight += 1;
    const release = () => {
      admission.inFlight -= 1;
    };
    let promise;
    try {
      promise = issue();
    } catch (error) {
      release();
      throw error;
    }
    if (!promise) {
      release();
      return undefined;
    }
    return Promise.resolve(promise).finally(() => {
      release();
      requestRender(TILE_RENDER_REASON);
    });
  };
}

/**
 * Create the renderer. The host it is bound to (`rebind`) carries the
 * viewer's globe port.
 * @param {{ tileTemplate?: Function, credit?: string, maxTileRequests?: number, requestRender?: (reason: string) => void }} [options]
 */
export function createRecentImageryRenderer({
  tileTemplate = gibsTemplate,
  credit = 'NASA GIBS',
  maxTileRequests = 6,
  requestRender = () => {},
} = {}) {
  let host = NO_HOST;
  let destroyed = false;
  const admission = { limit: maxTileRequests, inFlight: 0 };
  /** @type {Record<'a'|'b', null | { layers: Array<object>, globe: object, candidate: object, parts: Array<object>, alpha: number, split: string }>} */
  const owned = { a: null, b: null };
  const admit = admitTileRequests(admission, requestRender);

  function specFor(candidate, box) {
    const product = PRODUCTS[candidate.product];
    return {
      kind: 'xyz',
      url: tileTemplate(candidate.product, candidate.day),
      subdomains: ['a', 'b', 'c'],
      tiling: 'webMercator',
      minLevel: 0,
      maxLevel: product.maxLevel,
      rectangle: {
        west: box.west,
        south: box.south,
        east: box.east,
        north: box.north,
      },
      credit: { text: credit },
      admit,
    };
  }

  function removeOwned(slotId) {
    const record = owned[slotId];
    if (!record) return false;
    owned[slotId] = null;
    for (const layer of record.layers) layer.remove();
    return true;
  }

  function applyLook(record) {
    for (const layer of record.layers) {
      layer.alpha = record.alpha;
      layer.split = SPLITS.has(record.split) ? record.split : 'none';
    }
  }

  function mount(slotId, { candidate, parts, alpha, split }) {
    if (!parts.length) return false;
    owned[slotId] = {
      layers: parts.map((part) =>
        host.globe.imagery.add(specFor(candidate, part)),
      ),
      globe: host.globe,
      candidate,
      parts,
      alpha,
      split,
    };
    applyLook(owned[slotId]);
    return true;
  }

  return {
    /**
     * Drape the parts of a candidate's box that the evidence allows (see drapedParts).
     * The same candidate on the same port keeps the layer of each unchanged part.
     * @param {'a'|'b'} slotId
     * @param {object} candidate
     * @param {object} box Degrees box.
     * @param {{ alpha?: number, splitDirection?: 'left'|'right'|'none', availableBoxes?: object[] | null, emptyBoxes?: object[] | null }} [look]
     * @returns {boolean} Whether a layer is now draped for the slot.
     */
    showSlot(
      slotId,
      candidate,
      box,
      {
        alpha = 1,
        splitDirection = 'none',
        availableBoxes = null,
        emptyBoxes = null,
      } = {},
    ) {
      if (destroyed || !candidate?.key || !box) return false;
      if (!host.globe) {
        removeOwned(slotId);
        return false;
      }
      const current = owned[slotId];
      const look = { alpha: clampAlpha(alpha), split: splitDirection };
      const parts = drapedParts(candidate, box, { availableBoxes, emptyBoxes });
      if (
        current &&
        current.globe === host.globe &&
        current.candidate.key === candidate.key &&
        parts.length
      ) {
        if (partsKey(current.parts) !== partsKey(parts)) {
          const previous = new Map(
            current.parts.map((part, i) => [boxKey(part), current.layers[i]]),
          );
          // A new half goes right above the slot's surviving half, so both
          // halves keep the same place against the other slot.
          const survivor = parts
            .map((part) => previous.get(boxKey(part)))
            .find(Boolean);
          const at = survivor
            ? host.globe.imagery.list().indexOf(survivor) + 1
            : undefined;
          const layers = parts.map((part) => {
            const key = boxKey(part);
            const layer = previous.get(key);
            previous.delete(key);
            return (
              layer ?? host.globe.imagery.add(specFor(candidate, part), at)
            );
          });
          for (const layer of previous.values()) layer.remove();
          Object.assign(current, { layers, parts, ...look });
          applyLook(current);
          requestRender('recent-imagery-show');
        } else if (
          current.alpha !== look.alpha ||
          current.split !== look.split
        ) {
          Object.assign(current, look);
          applyLook(current);
          requestRender('recent-imagery-look');
        }
        return true;
      }
      const removed = removeOwned(slotId);
      if (!mount(slotId, { candidate, parts, ...look })) {
        if (removed) requestRender('recent-imagery-hide');
        return false;
      }
      requestRender('recent-imagery-show');
      return true;
    },

    /** @param {'a'|'b'} slotId */
    hideSlot(slotId) {
      if (removeOwned(slotId)) requestRender('recent-imagery-hide');
    },

    /**
     * @param {'a'|'b'} slotId
     * @param {number} alpha 0–1
     */
    setAlpha(slotId, alpha) {
      const record = owned[slotId];
      const next = clampAlpha(alpha);
      if (!record || record.alpha === next) return;
      record.alpha = next;
      applyLook(record);
      requestRender('recent-imagery-alpha');
    },

    /**
     * Follow the map stack's host. The globe port moves the owned layers
     * between the globe and the 3D tiles itself; without a host they go,
     * and a new globe port gets them rebuilt.
     * @param {{ collection: object | null, kind: string, globe?: object | null, tileset?: object | null }} nextHost
     */
    rebind(nextHost) {
      const previous = host;
      host =
        nextHost && nextHost.kind !== 'none' && nextHost.globe
          ? nextHost
          : NO_HOST;
      if (host.kind === 'tileset') markBaseTileset(host.tileset);
      let changed = host.kind !== previous.kind && Boolean(owned.a || owned.b);
      for (const slotId of SLOT_IDS) {
        const record = owned[slotId];
        if (!record || record.globe === host.globe) continue;
        removeOwned(slotId);
        changed = true;
        if (host.globe && !destroyed) mount(slotId, record);
      }
      if (changed) requestRender('recent-imagery-rebind');
    },

    /** What is draped right now, per slot. */
    getOwned() {
      const out = {};
      for (const slotId of SLOT_IDS) {
        const record = owned[slotId];
        out[slotId] = record
          ? {
              key: record.candidate.key,
              kind: host.kind,
              alpha: record.alpha,
              split: record.split,
            }
          : null;
      }
      return out;
    },

    /** Number of slots this renderer owns (never above two). A dateline box uses up to two imagery layers in its slot. */
    ownedCount() {
      return SLOT_IDS.filter((slotId) => owned[slotId]).length;
    },

    /** Remove everything and refuse further work. */
    destroy() {
      if (destroyed) return;
      destroyed = true;
      let changed = false;
      for (const slotId of SLOT_IDS) changed = removeOwned(slotId) || changed;
      host = NO_HOST;
      if (changed) requestRender('recent-imagery-destroy');
    },
  };
}

const PREVIEW_STROKE = Object.freeze([139 / 255, 233 / 255, 1]);
/** Fill alpha and outline alpha of the box being dragged. */
const PREVIEW_FILL_ALPHA = 0.12;
const PREVIEW_LINE_ALPHA = 0.95;
/** Each preview's draw sets have ids of their own. */
let previewSeq = 0;

/** A box with no area has no fill: a press, or a drag along one axis. */
const hasArea = (box) =>
  Boolean(box) && lonSpanDeg(box.west, box.east) > 0 && box.north > box.south;

/** A box with no extent draws nothing: a press that has not moved yet. */
const hasExtent = (box) =>
  Boolean(box) && (lonSpanDeg(box.west, box.east) > 0 || box.north > box.south);

/**
 * The box tool's preview: the box being dragged, a translucent fill and a
 * dashed outline on the ground, drawn through the draw port. Each change
 * moves them where they are (the port draws a moved ground fill and a moved
 * draped line in the frame they move), so the box shows every frame of a
 * drag.
 * @param {object} viewer
 * @param {() => ({west: number, south: number, east: number, north: number}|null)} dragBox
 *   Degrees, or null while no drag is live.
 * @param {{draw?: import('../../render/contract/draw').DrawPort}} [options]
 *   The draw port (tests pass a double); the viewer's by default.
 * @returns {{setVisible: (visible: boolean) => void, changed: () => void, destroy: () => Promise<void>}}
 */
export function createImageryBoxPreview(
  viewer,
  dragBox,
  { draw = drawOf(viewer) } = {},
) {
  previewSeq += 1;
  const fills = draw.shapes({
    id: `recent-imagery-box:${previewSeq}:fill`,
    pickable: false,
  });
  const outlines = draw.lines({
    id: `recent-imagery-box:${previewSeq}:outline`,
    pickable: false,
  });
  let visible = false;
  let destroyed = false;
  // The sets go at once; every caller gets the same settled promise.
  const gone = Promise.resolve();
  // The last box drawn, and the last with an area: a box without one keeps
  // it, hidden, so the next one moves it rather than draw it anew.
  let drawn = null;
  let filled = null;

  function drawFill(box, show) {
    const { west, south, east, north } = box;
    fills.upsert([
      {
        id: 'box',
        geometry: { kind: 'rectangle', rect: { west, south, east, north } },
        fill: [...PREVIEW_STROKE, PREVIEW_FILL_ALPHA],
        height: 'clampGround',
        clampTo: 'both',
        show,
      },
    ]);
  }

  function drawEdge(box, show) {
    const { west, south, east, north } = box;
    // A rectangle has no dashed edge on the ground, so the outline is a
    // draped line traced round the same corners; a drag along one axis
    // draws it as a line along the drag, as the fill has no area.
    outlines.upsert([
      {
        id: 'edge',
        positions: [
          fromDegrees(west, south),
          fromDegrees(east, south),
          fromDegrees(east, north),
          fromDegrees(west, north),
          fromDegrees(west, south),
        ],
        widthPx: 2,
        mode: 'draped',
        clampTo: 'both',
        style: {
          kind: 'dash',
          color: [...PREVIEW_STROKE, PREVIEW_LINE_ALPHA],
          length: 12,
        },
        show,
      },
    ]);
  }

  function update() {
    if (destroyed) return;
    const box = visible ? dragBox() : null;
    if (hasArea(box)) {
      filled = { ...box };
      drawFill(filled, true);
    } else if (filled) drawFill(filled, false);
    if (hasExtent(box)) {
      drawn = { ...box };
      drawEdge(drawn, true);
    } else if (drawn) drawEdge(drawn, false);
  }

  return {
    setVisible(on) {
      visible = Boolean(on);
      update();
    },
    /** The box moved: draw it again. */
    changed: update,
    /** Take the preview away; resolves once it is gone. */
    destroy() {
      if (!destroyed) {
        destroyed = true;
        fills.dispose();
        outlines.dispose();
      }
      return gone;
    },
  };
}
