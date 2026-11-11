// The Recent Imagery drawing on the globe contract, the same on every
// engine: at most two GIBS tile layers (slot `a`, left of a swipe; slot `b`,
// right) on engine.imagery, bounded to the box and split at the swipe; the
// box tool's transient preview as one ground cell. The engine drapes the
// layers on the surface the map shows (globe or 3D tiles) and follows it;
// a slot shown again with the same day and box only restyles its layer, any
// other day or box replaces its source in place. Tile requests are capped
// per layer (`maxTileRequests`).

import * as geo from '../../../geo/index.js';
import { PRODUCTS, fitViewHeightM, gibsTemplate } from '../model.js';

const SLOT_IDS = ['a', 'b'];
const PREVIEW = Object.freeze({
  fill: [0.545, 0.914, 1, 0.12],
  outline: { color: [0.545, 0.914, 1, 0.95], widthPx: 2 },
});
// The host kinds exposed by engine imagery.
const HOST_KIND = { globe: 'globe', tiles: 'tileset', none: 'none' };

const boxKey = (box) =>
  [box.west, box.south, box.east, box.north].map(Number).join(',');
const alphaOf = (value) => {
  const alpha = Number(value);
  return Number.isFinite(alpha) ? Math.max(0, Math.min(1, alpha)) : 1;
};
const hasArea = (box) =>
  box != null &&
  [box.west, box.south, box.east, box.north].every(Number.isFinite) &&
  box.west < box.east &&
  box.south < box.north &&
  box.south >= -90 &&
  box.north <= 90;
const sideOf = (direction) =>
  direction === 'left' || direction === 'right' ? direction : 'none';

/**
 * The renderer the Recent Imagery layer draws through (index.js).
 * @param {import('../../../globe/contract.js').GlobeEngine} engine
 * @param {{ tileTemplate?: (product: string, day: string) => string,
 *   credit?: string, maxTileRequests?: number }} [options]
 */
export function createRecentImageryDisplay(
  engine,
  {
    tileTemplate = gibsTemplate,
    credit = 'NASA GIBS',
    maxTileRequests = 6,
  } = {},
) {
  /** @type {Record<'a'|'b', null | { layer: object, candidate: object, box: object, alpha: number, split: string }>} */
  const owned = { a: null, b: null };
  let host = { identity: null, kind: 'none' };
  let preview = null;
  let destroyed = false;

  function sourceFor(candidate, box) {
    const spec = PRODUCTS[candidate.product];
    return {
      kind: 'tiles',
      url: tileTemplate(candidate.product, candidate.day),
      subdomains: ['a', 'b', 'c'],
      minLevel: 0,
      maxLevel: spec.maxLevel,
      rectangle: {
        west: box.west,
        south: box.south,
        east: box.east,
        north: box.north,
      },
      credit,
      opaque: spec.format !== 'png',
      maxRequests: maxTileRequests,
    };
  }

  function hideSlot(slotId) {
    const record = owned[slotId];
    if (!record) return;
    owned[slotId] = null;
    record.layer.destroy();
  }

  return {
    /** Where the engine drapes imagery now, as the layer names hosts. */
    resolveHost: () => {
      const kind = HOST_KIND[engine.imagery.surface()] ?? 'none';
      return { identity: kind === 'none' ? null : engine, kind };
    },
    /** The engine follows the surface itself; the host is the layer's view of it. */
    rebind(next) {
      host = next ?? { identity: null, kind: 'none' };
    },
    /**
     * Drape a candidate into a slot. The same candidate and box only
     * restyle it; anything else draws the new source in its place.
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
      if (
        destroyed ||
        !SLOT_IDS.includes(slotId) ||
        !candidate?.key ||
        !PRODUCTS[candidate.product] ||
        !box
      )
        return false;
      if (host.kind === 'none') {
        hideSlot(slotId);
        return false;
      }
      const look = { alpha: alphaOf(alpha), split: sideOf(splitDirection) };
      const record = owned[slotId];
      if (!record) {
        owned[slotId] = {
          layer: engine.imagery.createLayer({
            id: `recent-imagery:${slotId}`,
            source: sourceFor(candidate, box),
            ...look,
          }),
          candidate: { ...candidate },
          box: { ...box },
          ...look,
        };
        return true;
      }
      if (
        record.candidate.key !== candidate.key ||
        boxKey(record.box) !== boxKey(box)
      ) {
        record.layer.setSource(sourceFor(candidate, box));
        record.candidate = { ...candidate };
        record.box = { ...box };
      }
      if (record.alpha !== look.alpha) record.layer.setAlpha(look.alpha);
      if (record.split !== look.split) record.layer.setSplit(look.split);
      Object.assign(record, look);
      return true;
    },
    /** @param {'a'|'b'} slotId */
    hideSlot,
    /**
     * @param {'a'|'b'} slotId
     * @param {number} alpha 0–1
     */
    setAlpha(slotId, alpha) {
      const record = owned[slotId];
      const next = alphaOf(alpha);
      if (!record || record.alpha === next) return;
      record.alpha = next;
      record.layer.setAlpha(next);
    },
    /** The swipe line, a fraction of the canvas width from the left. */
    setSplit(value) {
      if (destroyed) return;
      const fraction = Number(value);
      if (Number.isFinite(fraction))
        engine.imagery.setSplitPosition(Math.max(0, Math.min(1, fraction)));
    },
    /**
     * The box tool's transient ground preview, or none; a box without area
     * yet (the press before a drag) shows nothing.
     */
    setBoxPreview(box) {
      if (destroyed) return;
      if (!hasArea(box)) {
        preview?.show(false);
        return;
      }
      preview ??= engine.ground.createSet({
        id: 'recent-imagery:preview',
        kind: 'cell',
        order: 10,
      });
      preview.replace([
        {
          west: box.west,
          south: box.south,
          east: box.east,
          north: box.north,
          ...PREVIEW,
        },
      ]);
      preview.commit();
      preview.show(true);
    },
    viewCentre() {
      const { width, height } = engine.host.size(),
        hit = engine.camera.pickEllipsoid({ x: width / 2, y: height / 2 });
      const c = hit && geo.cartographic.fromCartesian(hit, geo.ellipsoid.WGS84);
      return c
        ? {
            lon: (c.longitude * 180) / Math.PI,
            lat: (c.latitude * 180) / Math.PI,
          }
        : null;
    },
    zoomToFit(target) {
      const height = fitViewHeightM({
        ...engine.host.size(),
        fovy: engine.camera.pose().fovy,
      });
      engine.camera.flyTo({
        destination: geo.cartesian3.fromDegrees(target.lon, target.lat, height),
        orientation: { heading: 0, pitch: -Math.PI / 2, roll: 0 },
        duration: 1.2,
      });
      return height;
    },
    /** What is draped right now, per slot. */
    getOwned: () =>
      Object.fromEntries(
        SLOT_IDS.map((slotId) => {
          const record = owned[slotId];
          return [
            slotId,
            record
              ? {
                  key: record.candidate.key,
                  kind: host.kind,
                  alpha: record.alpha,
                  split: record.split,
                }
              : null,
          ];
        }),
      ),
    /** Number of layers this display owns (never above two). */
    ownedCount: () => SLOT_IDS.filter((slotId) => owned[slotId]).length,
    /** Remove everything and refuse further work. */
    destroy() {
      if (destroyed) return;
      destroyed = true;
      for (const slotId of SLOT_IDS) hideSlot(slotId);
      preview?.destroy();
      preview = null;
      host = { identity: null, kind: 'none' };
    },
  };
}
