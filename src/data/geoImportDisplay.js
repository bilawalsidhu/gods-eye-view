// One imported file (UTILITIES ▸ Import) drawn on the globe contract, the
// same on every engine, from its plain records (src/data/geoImportRecords.js),
// with Cesium's look as the reference:
// - polygons: one ground 'polygon' set of their fills; a raised polygon
//   (KML absolute or relative) also gets its outline as lines at its
//   heights, as Cesium drew it (its fill drapes: the ground has no heights);
// - ground lines: one ground 'corridor' set in pixels, over the fills;
// - lines in the air: one engine line each;
// - points: one sprite set per look, each sprite a square centred on its
//   point holding the billboard where Cesium placed it (src/data/
//   geoImportPins.js); points on the ground draw over the scene and are
//   hidden beyond the horizon instead, as Cesium's clamped billboards
//   ignored the depth test;
// - ground overlays: one image imagery layer each over its rectangle.
// Nothing is pickable: an imported file has no card. Ground heights under
// the points come from engine.surface, sampled again by refreshGround().

import * as geo from '../geo/index.js';
import { normalizeGroundItem } from '../globe/ground.js';
import { composeIcon } from './geoImportPins.js';

const POLYGON_ORDER = 0;
const LINE_ORDER = 1;
// Over the layers' rasters, as Cesium's ground rectangle drew over imagery.
const OVERLAY_ORDER = 30;
// The horizon test lifts each point by this much (as GhostMaps does):
// ground can lie below the ellipsoid.
const HORIZON_LIFT_M = 2000;
// Under this camera height, points on 3D tiles are clamped to the tiles
// drawn now; higher up the terrain answers (Cesium's 250 km).
const CLAMP_TILES_BELOW_M = 250_000;
const BATCH = 256;
let serial = 0;

const imageFromUrl = async (url) => {
  const image = new Image();
  image.src = url;
  await image.decode();
  return image;
};

// A ground item the contract accepts, or null (a degenerate ring or line).
function checked(kind, item) {
  try {
    normalizeGroundItem(kind, item);
    return item;
  } catch {
    return null;
  }
}

const flat = (positions) => positions.map(([lon, lat]) => [lon, lat]);
const cartesian = ([lon, lat, height = 0]) =>
  geo.cartesian3.fromDegrees(lon, lat, height);

/** One key per drawn look of an icon, so equal pins share a sprite set. */
const lookKey = (icon, depth) =>
  JSON.stringify([
    icon.image,
    icon.widthPx,
    icon.heightPx,
    icon.scale,
    icon.origin,
    icon.offsetPx,
    icon.subRegion,
    icon.scaleByDistance,
    depth,
  ]);

/**
 * Draw one imported file's records on `engine`. Resolves once its icons
 * are decoded and every set is committed.
 * @param {import('../globe/contract.js').GlobeEngine} engine
 * @param {import('./geoImportRecords.js').ImportedRecords} records
 * @param {{ visible?: boolean, loadImage?: (url: string) => Promise<object>,
 *   createCanvas?: () => object, pixelRatio?: number }} [options]
 *   `loadImage` and `createCanvas` are test seams (icon decoding and the
 *   sprite canvases).
 * @returns {Promise<{ report: { drawn: number, undrawn: number,
 *   kinds: Object<string, number> }, setShow: (visible: boolean) => void,
 *   refreshGround: (signal?: AbortSignal) => Promise<void>,
 *   destroy: () => void }>}
 */
export async function drawImportedFile(
  engine,
  records,
  {
    visible = true,
    loadImage = imageFromUrl,
    createCanvas = () => document.createElement('canvas'),
    pixelRatio = Math.max(1, Math.min(2, globalThis.devicePixelRatio || 1)),
  } = {},
) {
  if (!engine?.ground || !engine?.movers || !engine?.lines)
    throw new TypeError('The imported file display needs a globe engine');
  const prefix = `geo-import-${++serial}`;
  const request = () => engine.render.request('geo-import');
  let shown = visible;
  let destroyed = false;
  let removeCull = null;
  const groundSets = [];
  const lines = [];
  const layers = [];
  const looks = new Map();
  let drawn = 0;

  function release() {
    destroyed = true;
    removeCull?.();
    removeCull = null;
    for (const set of groundSets.splice(0)) set.destroy();
    for (const line of lines.splice(0)) line.destroy();
    for (const layer of layers.splice(0)) layer.destroy();
    for (const look of looks.values()) look.set?.destroy();
    looks.clear();
  }

  try {
    // Fills under ground lines; a plain-colour overlay is a fill too.
    const fills = [];
    for (const polygon of records.polygons) {
      let any = false;
      if (polygon.fill) {
        const item = checked('polygon', {
          rings: polygon.rings.map(flat),
          fill: polygon.fill,
        });
        if (item) {
          fills.push(item);
          any = true;
        }
      }
      if (polygon.raised && polygon.outline)
        for (const ring of polygon.rings) {
          if (ring.length < 2) continue;
          const closed = [...ring, ring[0]].map(cartesian);
          const line = engine.lines.createLine({
            id: `${prefix}-outline-${lines.length}`,
            widthPx: 1,
            color: polygon.outline.color,
          });
          line.setPositions(closed);
          line.show(shown);
          lines.push(line);
          any = true;
        }
      if (any) drawn++;
    }
    for (const overlay of records.overlays) {
      if (overlay.url) {
        layers.push(
          engine.imagery.createLayer({
            id: `${prefix}-overlay-${layers.length}`,
            source: {
              kind: 'image',
              url: overlay.url,
              rectangle: overlay.rectangle,
            },
            // Cesium's transparent image material: at most 0.99.
            alpha: Math.min(0.99, overlay.color[3]),
            show: shown,
            order: OVERLAY_ORDER,
          }),
        );
        drawn++;
        continue;
      }
      const { west, south, east, north } = overlay.rectangle;
      const item = checked('cell', { west, south, east, north });
      if (!item) continue;
      const rings = [
        [
          [west, south],
          [east < west ? east + 360 : east, south],
          [east < west ? east + 360 : east, north],
          [west, north],
        ],
      ];
      fills.push({ rings, fill: overlay.color });
      drawn++;
    }
    if (fills.length) {
      const set = engine.ground.createSet({
        id: `${prefix}-polygons`,
        kind: 'polygon',
        order: POLYGON_ORDER,
      });
      set.replace(fills);
      set.commit();
      set.show(shown);
      groundSets.push(set);
    }

    const corridors = [];
    for (const record of records.lines) {
      if (record.ground) {
        const item = checked('corridor', {
          positions: flat(record.positions),
          color: record.color,
          widthPx: record.widthPx,
        });
        if (!item) continue;
        corridors.push(item);
      } else {
        const line = engine.lines.createLine({
          id: `${prefix}-line-${lines.length}`,
          widthPx: record.widthPx,
          color: record.color,
        });
        line.setPositions(record.positions.map(cartesian));
        line.show(shown);
        lines.push(line);
      }
      drawn++;
    }
    if (corridors.length) {
      const set = engine.ground.createSet({
        id: `${prefix}-lines`,
        kind: 'corridor',
        order: LINE_ORDER,
      });
      set.replace(corridors);
      set.commit();
      set.show(shown);
      groundSets.push(set);
    }

    for (const point of records.points) {
      const depth = point.altitude === 'absolute' ? 'normal' : 'always';
      const key = lookKey(point.icon, depth);
      let look = looks.get(key);
      if (!look)
        looks.set(
          key,
          (look = { icon: point.icon, depth, pins: [], set: null, count: 0 }),
        );
      const [lon, lat, height = 0] = point.position;
      look.pins.push({
        lon,
        lat,
        offset: point.altitude === 'relative' ? height : 0,
        height: point.altitude === 'absolute' ? height : null,
        ground: undefined,
        position: null,
        horizon: null,
        show: true,
        color: point.icon.color ?? [1, 1, 1, 1],
        rotation: point.icon.rotation ?? 0,
      });
    }
    await Promise.all(
      [...looks.values()].map(async (look) => {
        const url = look.icon.image?.url;
        let image;
        if (url) {
          try {
            image = await loadImage(url);
          } catch {
            // An icon that does not decode draws nothing, as a billboard
            // without an image.
            return;
          }
        }
        if (destroyed) return;
        const { canvas, side } = composeIcon(look.icon, {
          image,
          createCanvas,
          ratio: pixelRatio,
        });
        look.set = engine.movers.createSet({
          id: `${prefix}-pins-${look.depth}-${looks.size}-${++serial}`,
          kind: 'sprite',
          capacity: look.pins.length,
          depthTest: look.depth,
          pickable: false,
          sprite: {
            sizePx: side,
            atlas: { canvas, cells: { icon: [0, 0, 1, 1] } },
            ...(look.icon.scaleByDistance
              ? { scaleByDistance: [...look.icon.scaleByDistance] }
              : {}),
          },
        });
        drawn += look.pins.length;
      }),
    );
    if (destroyed) throw new Error('The imported file was removed');
    settle(heightContext());
    for (const look of looks.values()) writePins(look);
    syncCull();
  } catch (error) {
    release();
    throw error;
  }
  request();

  // Where heights come from now: the terrain, or the 3D tiles under a low
  // camera when they are the drawn surface.
  function heightContext() {
    const surface = engine.surface;
    const tiles =
      engine.imagery?.surface?.() === 'tiles' &&
      surface.clampToHeightSupported &&
      engine.camera.height() < CLAMP_TILES_BELOW_M;
    const exclude = [...looks.values()].map((look) => look.set).filter(Boolean);
    return { surface, tiles, exclude };
  }

  // The ground under a pin, falling back to the last known one.
  function groundUnder(pin, { surface, tiles, exclude }) {
    const at = geo.cartographic.fromDegrees(pin.lon, pin.lat, 0);
    const terrain = surface.terrainHeightSupported
      ? surface.terrainHeight(at)
      : undefined;
    // A coarse ellipsoid mesh under 3D tiles can answer far below zero.
    let ground = Number.isFinite(terrain)
      ? tiles
        ? Math.max(0, terrain)
        : terrain
      : (pin.ground ?? 0);
    if (tiles) {
      const top = surface.clampToHeight(
        geo.cartesian3.fromDegrees(pin.lon, pin.lat, Math.max(0, ground)),
        exclude,
      );
      const height = top && geo.cartographic.fromCartesian(top)?.height;
      ground = Number.isFinite(height) ? height : (pin.ground ?? ground);
    }
    return ground;
  }

  function settle(context, from = 0, to = Infinity) {
    let at = 0;
    for (const look of looks.values())
      for (const pin of look.pins) {
        if (at++ < from || at > to) continue;
        if (pin.height === null) pin.ground = groundUnder(pin, context);
        const height = pin.height ?? pin.ground + pin.offset;
        pin.position = geo.cartesian3.fromDegrees(pin.lon, pin.lat, height);
        pin.horizon = geo.cartesian3.fromDegrees(
          pin.lon,
          pin.lat,
          height + HORIZON_LIFT_M,
        );
      }
  }

  function writePins(look) {
    const { set, pins } = look;
    if (!set) return;
    const culled = look.depth === 'always';
    pins.forEach((pin, index) => {
      if (culled) pin.show = engine.projector.horizonVisible(pin.horizon);
      set.set(index, {
        position: pin.position,
        cell: 'icon',
        color: pin.color,
        rotation: pin.rotation,
        show: pin.show,
      });
    });
    look.count = pins.length;
    set.setCount(shown ? look.count : 0);
    set.commit();
  }

  // Hides the ground points beyond the horizon; true when any show changed.
  function cull(look) {
    let changed = false;
    look.pins.forEach((pin, index) => {
      const show = engine.projector.horizonVisible(pin.horizon);
      if (show === pin.show) return;
      pin.show = show;
      look.set.set(index, { show });
      changed = true;
    });
    if (changed) look.set.commit();
    return changed;
  }
  function syncCull() {
    const culled = [...looks.values()].filter(
      (look) => look.set && look.depth === 'always',
    );
    if (!culled.length || !shown) {
      removeCull?.();
      removeCull = null;
      return;
    }
    const lastCamera = geo.cartesian3.create(Number.NaN, 0, 0);
    removeCull ??= engine.frames.preRender.addEventListener(() => {
      const live = engine.camera.livePosition;
      if (geo.cartesian3.equals(live, lastCamera)) return;
      geo.cartesian3.clone(live, lastCamera);
      let changed = false;
      for (const look of culled) changed = cull(look) || changed;
      if (changed) request();
    });
  }

  const undrawn = Object.values(records.undrawn).reduce((n, c) => n + c, 0);
  return {
    report: { drawn, undrawn, kinds: { ...records.undrawn } },
    setShow(visibleNow) {
      visibleNow = Boolean(visibleNow);
      if (destroyed || visibleNow === shown) return;
      shown = visibleNow;
      for (const set of groundSets) set.show(shown);
      for (const line of lines) line.show(shown);
      for (const layer of layers) layer.show(shown);
      for (const look of looks.values()) {
        look.set?.setCount(shown ? look.count : 0);
        look.set?.commit();
      }
      syncCull();
      request();
    },
    /** Sample the ground under the points again (a map or the terrain changed). */
    async refreshGround(signal) {
      const total = [...looks.values()].reduce((n, l) => n + l.pins.length, 0);
      for (let from = 0; from < total; from += BATCH) {
        signal?.throwIfAborted();
        if (destroyed) return;
        settle(heightContext(), from, from + BATCH);
        if (from + BATCH < total)
          await new Promise((resolve) => setTimeout(resolve, 0));
      }
      signal?.throwIfAborted();
      if (destroyed) return;
      for (const look of looks.values()) writePins(look);
      request();
    },
    destroy() {
      if (destroyed) return;
      release();
      request();
    },
  };
}
