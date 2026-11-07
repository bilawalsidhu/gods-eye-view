/**
 * Draped-imagery renderer for the Recent Imagery layer: at most two GIBS
 * imagery layers (slot `a`, left of a swipe; slot `b`, right) through the
 * renderer's globe port, draped on whichever surface the map stack draws.
 * Against the basemap slot `a` splits left and slot `b` stays empty. Tile
 * requests pass a small semaphore of our own, shared by both slots, through
 * each layer's admission hook; the renderer's own request limits stay
 * untouched.
 */
// The layer flies through `cameraOf` and drapes through `findGlobe`; this
// renderer is its Cesium side, so it brings the factories a viewer with no
// renderer bound gets those ports from, and marks a tileset host as a base
// the globe port drapes on.
import * as Cesium from 'cesium';
import '../../render/cesium/camera.js';
import { markBaseTileset } from '../../render/cesium/globe.js';
import { PRODUCTS, gibsTemplate } from './model.js';

const SLOT_IDS = ['a', 'b'];
const SPLITS = new Set(['left', 'right', 'none']);
const NO_HOST = Object.freeze({ collection: null, kind: 'none', globe: null });

/** Render reason for a settled tile request. */
export const TILE_RENDER_REASON = 'recent-imagery-tiles';

function clampAlpha(value) {
  const alpha = Number(value);
  return Number.isFinite(alpha) ? Math.max(0, Math.min(1, alpha)) : 1;
}

const boxKey = (box) =>
  [box.west, box.south, box.east, box.north].map(Number).join(',');

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
  /** @type {Record<'a'|'b', null | { layer: object, globe: object, candidate: object, box: object, alpha: number, split: string }>} */
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
    record.layer.remove();
    return true;
  }

  function applyLook(record) {
    record.layer.alpha = record.alpha;
    record.layer.split = SPLITS.has(record.split) ? record.split : 'none';
  }

  function mount(slotId, { candidate, box, alpha, split }) {
    const layer = host.globe.imagery.add(specFor(candidate, box));
    owned[slotId] = { layer, globe: host.globe, candidate, box, alpha, split };
    applyLook(owned[slotId]);
  }

  return {
    /**
     * Drape a candidate into a slot. The same candidate on the same host only
     * updates its look; anything else replaces the slot's layer.
     * @param {'a'|'b'} slotId
     * @param {object} candidate
     * @param {object} box Degrees box.
     * @param {{ alpha?: number, splitDirection?: 'left'|'right'|'none' }} [look]
     * @returns {boolean} Whether a layer is now draped for the slot.
     */
    showSlot(
      slotId,
      candidate,
      box,
      { alpha = 1, splitDirection = 'none' } = {},
    ) {
      if (destroyed || !candidate?.key || !box) return false;
      if (!host.globe) {
        removeOwned(slotId);
        return false;
      }
      const current = owned[slotId];
      const look = { alpha: clampAlpha(alpha), split: splitDirection };
      if (
        current &&
        current.globe === host.globe &&
        current.candidate.key === candidate.key &&
        boxKey(current.box) === boxKey(box)
      ) {
        if (current.alpha !== look.alpha || current.split !== look.split) {
          Object.assign(current, look);
          applyLook(current);
          requestRender('recent-imagery-look');
        }
        return true;
      }
      removeOwned(slotId);
      mount(slotId, { candidate, box, ...look });
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

    /** Number of layers this renderer owns (never above two). */
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

/**
 * The box tool's preview: the box being dragged, a translucent fill and a
 * dashed outline on the ground (the draw port draws no dashed draped
 * lines), read from `dragBox()` each frame it draws.
 * @param {object} viewer
 * @param {() => ({west: number, south: number, east: number, north: number}|null)} dragBox
 *   Degrees, or null while no drag is live.
 * @param {{cesium?: object}} [options] The Cesium namespace (tests pass a double).
 * @returns {{setVisible: (visible: boolean) => void, changed: () => void, destroy: () => Promise<void>}}
 */
export function createImageryBoxPreview(
  viewer,
  dragBox,
  { cesium = Cesium } = {},
) {
  const dataSource = new cesium.CustomDataSource(
    'gev-recent-imagery-box-preview',
  );
  let attaching = Promise.resolve(viewer.dataSources.add(dataSource)).catch(
    () => null,
  );
  let destroyed = false;
  const stroke = cesium.Color.fromCssColorString('#8be9ff');
  const previewRectangle = () => {
    const box = dragBox();
    return box
      ? cesium.Rectangle.fromDegrees(box.west, box.south, box.east, box.north)
      : undefined;
  };
  const previewOutline = () => {
    const box = dragBox();
    if (!box) return [];
    return cesium.Cartesian3.fromDegreesArray([
      box.west,
      box.south,
      box.east,
      box.south,
      box.east,
      box.north,
      box.west,
      box.north,
      box.west,
      box.south,
    ]);
  };
  const fill = dataSource.entities.add({
    show: false,
    rectangle: {
      coordinates: new cesium.CallbackProperty(previewRectangle, false),
      material: stroke.withAlpha(0.12),
      classificationType: cesium.ClassificationType.BOTH,
    },
  });
  // A rectangle graphic cannot draw a dashed edge on the ground, so the
  // outline is its own draped polyline traced round the same corners.
  const outline = dataSource.entities.add({
    show: false,
    polyline: {
      positions: new cesium.CallbackProperty(previewOutline, false),
      width: 2,
      clampToGround: true,
      classificationType: cesium.ClassificationType.BOTH,
      material: new cesium.PolylineDashMaterialProperty({
        color: stroke.withAlpha(0.95),
        dashLength: 12,
      }),
    },
  });
  const requestRender = () => viewer.scene.requestRender?.();
  return {
    setVisible(visible) {
      fill.show = visible;
      outline.show = visible;
      requestRender();
    },
    /** The box moved: draw it again. */
    changed: requestRender,
    /** Detach the preview; resolves once it is gone. */
    destroy() {
      if (destroyed) return attaching;
      destroyed = true;
      dataSource.entities.removeAll();
      attaching = attaching.then(() => {
        try {
          viewer.dataSources.remove(dataSource, true);
        } catch {
          /* viewer already disposed */
        }
      });
      return attaching;
    },
  };
}
