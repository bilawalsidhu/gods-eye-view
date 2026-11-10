// One imported file (UTILITIES ▸ Import) drawn on the globe contract, the
// same on every engine, from its plain records (src/data/geoImportRecords.js),
// with Cesium's look as the reference:
// - polygons: ground fills, or meshes and outlines at the vertices' heights;
// - ground lines: one ground 'corridor' set in pixels, over the fills;
// - lines in the air: one engine line each;
// - points: one sprite set per look, each sprite a square centred on its
//   point holding the billboard where Cesium placed it (src/data/
//   geoImportPins.js); points on the ground draw over the scene and are
//   hidden beyond the horizon instead, as Cesium's clamped billboards
//   ignored the depth test;
// - ground overlays: image layers, or textured meshes at absolute altitudes,
//   tinted and turned on a canvas when the KML says so; a plain colour is
//   a ground fill or a mesh at an absolute altitude.
// Nothing is pickable: an imported file has no card. Ground heights under
// the points come from engine.surface, sampled again by refreshGround():
// the terrain where the globe is drawn, else (3D tiles) the scene drawn
// under a low camera, never an imported point (as Cesium's import kept its
// pins out of height queries).

import * as geo from '../geo/index.js';
import { planImport } from './geoImportPlan.js';
import {
  BATCH,
  HORIZON_LIFT_M,
  CLAMP_TILES_BELOW_M,
  MAX_ICON_PIXEL_RATIO,
  POLYGON_YIELD_MS,
} from './geoImportLimits.js';
import { composeIcon } from './geoImportPins.js';
import { emptyRecords, recordFootprint } from './geoImportRecords.js';

let serial = 0;
// Each engine's imported point sets, left out of each other's ground.
const pointSets = new WeakMap();
const pointSetsOf = (engine) => {
  let sets = pointSets.get(engine);
  if (!sets) pointSets.set(engine, (sets = new Set()));
  return sets;
};

const imageFromUrl = async (url) => {
  const image = new Image();
  image.src = url;
  await image.decode();
  return image;
};

// Execute the canvas recipe; geometry and pixel budgets are decided by the plan.
function overlayImage(entry, images, createCanvas, cache) {
  const recipe = entry.canvas;
  if (!recipe) return images.get(entry.url);
  if (cache.has(recipe.key)) return cache.get(recipe.key);
  const canvas = createCanvas();
  canvas.width = recipe.width;
  canvas.height = recipe.height;
  const context = canvas.getContext('2d');
  context.translate(canvas.width / 2, canvas.height / 2);
  context.rotate(-recipe.angle);
  context.drawImage(images.get(entry.url), ...recipe.draw);
  if (recipe.tint.some((value) => value !== 1)) {
    const pixels = context.getImageData(0, 0, canvas.width, canvas.height);
    for (let i = 0; i < pixels.data.length; i += 4)
      for (let channel = 0; channel < 3; channel++)
        pixels.data[i + channel] *= recipe.tint[channel];
    context.putImageData(pixels, 0, 0);
  }
  cache.set(recipe.key, canvas);
  return canvas;
}

// KML headings are from north (Cesium's billboard on the Earth's axis):
// the sprite turns on screen with the camera's heading.
const turnsWithCamera = (look) => look.pins.some((pin) => pin.rotation);
const onScreen = (pin, heading) => (pin.rotation ? pin.rotation + heading : 0);

/**
 * Draw one imported file's records on `engine`. Resolves once its icons
 * are decoded and every set is committed.
 * @param {import('../globe/contract.js').GlobeEngine} engine
 * @param {import('./geoImportRecords.js').ImportedRecords} records
 * @param {{ visible?: boolean, loadImage?: (url: string) => Promise<object>,
 *   createCanvas?: () => object, pixelRatio?: number, now?: () => number,
 *   signal?: AbortSignal, isCurrent?: () => boolean }} [options]
 *   `loadImage` and `createCanvas` are test seams (icon decoding and the
 *   sprite canvases). `now` measures polygon work in milliseconds;
 *   `signal` and `isCurrent` cancel work when the draw loses its owner.
 * @returns {Promise<{ report: { drawn: number, undrawn: number,
 *   kinds: Object<string, number> }, setShow: (visible: boolean) => void,
 *   refreshGround: (signal?: AbortSignal) => Promise<void>,
 *   footprint: () => Array<[number, number, number]>,
 *   destroy: () => void }>}
 */
export async function drawImportedFile(
  engine,
  records,
  {
    visible = true,
    loadImage = imageFromUrl,
    createCanvas = () => document.createElement('canvas'),
    pixelRatio = Math.max(
      1,
      Math.min(MAX_ICON_PIXEL_RATIO, globalThis.devicePixelRatio || 1),
    ),
    now = () => performance.now(),
    signal,
    isCurrent = () => true,
  } = {},
) {
  const prefix = `geo-import-${++serial}`;
  const request = () => engine.render.request('geo-import');
  let shown = visible;
  let destroyed = false;
  let removeCull = null;
  const groundSets = [];
  const lines = [];
  const meshes = [];
  const pins = [];
  const kinds = {};
  const layers = [];
  const looks = new Map();
  let drawn = 0;

  function checkActive() {
    signal?.throwIfAborted();
    if (destroyed || !isCurrent())
      throw new Error('The imported file was removed');
  }

  function release() {
    destroyed = true;
    removeCull?.();
    removeCull = null;
    for (const set of groundSets.splice(0)) set.destroy();
    for (const line of lines.splice(0)) line.destroy();
    for (const mesh of meshes.splice(0)) mesh.destroy();
    for (const layer of layers.splice(0)) layer.destroy();
    for (const look of looks.values()) {
      pointSetsOf(engine).delete(look.set);
      look.set?.destroy();
    }
    looks.clear();
    pins.length = 0;
  }

  try {
    checkActive();
    const ground = [];
    const images = new Map();
    const metadata = new Map();
    const overlayCache = new Map();
    function drawPlan(plan) {
      drawn += plan.report.drawn;
      for (const [kind, count] of Object.entries(plan.report.kinds))
        kinds[kind] = (kinds[kind] ?? 0) + count;
      ground.push(...plan.ground);
      for (const entry of plan.meshes) {
        const { positions, indices, color, uv } = entry;
        meshes.push(
          engine.meshes.createMesh({
            id: `${prefix}-mesh-${meshes.length}`,
            positions,
            indices,
            color,
            show: shown,
            ...(uv
              ? {
                  uv,
                  image: overlayImage(
                    entry,
                    images,
                    createCanvas,
                    overlayCache,
                  ),
                }
              : {}),
          }),
        );
      }
      for (const entry of plan.lines) {
        const line = engine.lines.createLine({
          id: `${prefix}-line-${lines.length}`,
          widthPx: entry.widthPx,
          color: entry.color,
        });
        line.setPositions(entry.positions);
        line.show(shown);
        lines.push(line);
      }
      for (const entry of plan.overlays) {
        const image =
          entry.canvas &&
          overlayImage(entry, images, createCanvas, overlayCache);
        layers.push(
          engine.imagery.createLayer({
            id: `${prefix}-overlay-${layers.length}`,
            source: {
              kind: 'image',
              rectangle: entry.rectangle,
              ...(image ? { image } : { url: entry.url }),
            },
            alpha: entry.alpha,
            show: shown,
            order: entry.order,
          }),
        );
      }
    }
    let lastYield = now();
    for (const polygon of records.polygons) {
      if (now() - lastYield > POLYGON_YIELD_MS) {
        await new Promise((resolve) => setTimeout(resolve, 0));
        checkActive();
        lastYield = now();
      }
      drawPlan(planImport({ ...emptyRecords(), polygons: [polygon] }));
    }
    const remaining = { ...records, polygons: [] };
    const pending = planImport(remaining);
    await Promise.all(
      pending.images.map(async (url) => {
        try {
          const image = await loadImage(url);
          images.set(url, image);
          metadata.set(url, {
            width: image.naturalWidth || image.width,
            height: image.naturalHeight || image.height,
          });
        } catch {
          metadata.set(url, null);
        }
        checkActive();
      }),
    );
    checkActive();
    const plan = planImport(remaining, undefined, { images: metadata });
    drawPlan(plan);
    for (const kind of ['polygon', 'corridor']) {
      const entries = ground.filter((entry) => entry.kind === kind);
      if (!entries.length) continue;
      const set = engine.ground.createSet({
        id: `${prefix}-${kind}`,
        kind,
        order: entries[0].order,
      });
      groundSets.push(set);
      set.replace(entries.map((entry) => entry.item));
      set.commit();
      set.show(shown);
    }
    for (const planned of plan.pins) {
      const look = { ...planned, set: null, count: 0 };
      looks.set(looks.size, look);
      pins.push(...look.pins);
      if (!look.draw) continue;
      const { canvas, side } = composeIcon(look.icon, {
        image: images.get(look.icon.image?.url),
        createCanvas,
        ratio: pixelRatio,
        maxSide: look.maxSide,
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
      pointSetsOf(engine).add(look.set);
    }
    checkActive();
    for (let from = 0; from < pins.length; from += BATCH) {
      settle(heightContext(), from, from + BATCH);
      if (from + BATCH < pins.length) {
        await new Promise((resolve) => setTimeout(resolve, 0));
        checkActive();
      }
    }
    for (const look of looks.values()) writePins(look);
    syncCull();
  } catch (error) {
    release();
    throw error;
  }
  request();

  // Where heights come from now: the terrain, or the scene drawn under a
  // low camera when the globe is not (3D tiles).
  function heightContext() {
    const surface = engine.surface;
    const tiles =
      (engine.imagery?.surface?.() ?? 'globe') !== 'globe' &&
      surface.clampToHeightSupported &&
      engine.camera.height() < CLAMP_TILES_BELOW_M;
    return {
      surface,
      tiles,
      exclude: [...pointSetsOf(engine)],
      size: tiles ? engine.host.size() : null,
    };
  }

  // Whether a position is in the window now: clamping to 3D tiles reads
  // the tiles drawn, and a point elsewhere would only cost the query.
  function inWindow(position, { width, height }) {
    if (!engine.projector.horizonVisible(position)) return false;
    const screen = engine.projector.worldToWindow(position);
    return (
      Boolean(screen) &&
      screen.x >= 0 &&
      screen.y >= 0 &&
      screen.x <= width &&
      screen.y <= height
    );
  }

  // The ground under a pin, falling back to the last known one.
  function groundUnder(pin, { surface, tiles, exclude, size }) {
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
    // On tiles the last height found stays until the tiles answer again:
    // the terrain under them is not where the pin stands.
    if (tiles) ground = pin.ground ?? ground;
    if (
      tiles &&
      inWindow(geo.cartesian3.fromDegrees(pin.lon, pin.lat, ground), size)
    ) {
      const top = surface.clampToHeight(
        geo.cartesian3.fromDegrees(pin.lon, pin.lat, Math.max(0, ground)),
        exclude,
      );
      const height = top && geo.cartographic.fromCartesian(top)?.height;
      ground = Number.isFinite(height) ? height : (pin.ground ?? ground);
    }
    return ground;
  }

  function settle(context, from = 0, to = pins.length) {
    for (let i = from; i < Math.min(to, pins.length); i++) {
      const pin = pins[i];
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
    const heading = turnsWithCamera(look) ? engine.camera.pose().heading : 0;
    pins.forEach((pin, index) => {
      if (culled) pin.show = engine.projector.horizonVisible(pin.horizon);
      pin.drawnRotation = onScreen(pin, heading);
      set.set(index, {
        position: pin.position,
        cell: 'icon',
        color: pin.color,
        rotation: pin.drawnRotation,
        show: pin.show,
      });
    });
    look.count = pins.length;
    set.setCount(shown ? look.count : 0);
    set.commit();
  }

  // Hides the ground points beyond the horizon and turns the headed ones
  // with the camera; true when any changed.
  function cull(look, heading) {
    let changed = false;
    look.pins.forEach((pin, index) => {
      const show =
        look.depth !== 'always' || engine.projector.horizonVisible(pin.horizon);
      const rotation = onScreen(pin, heading);
      if (show === pin.show && rotation === pin.drawnRotation) return;
      pin.show = show;
      pin.drawnRotation = rotation;
      look.set.set(index, { show, rotation });
      changed = true;
    });
    if (changed) look.set.commit();
    return changed;
  }
  function syncCull() {
    const culled = [...looks.values()].filter(
      (look) => look.set && (look.depth === 'always' || turnsWithCamera(look)),
    );
    if (!culled.length || !shown) {
      removeCull?.();
      removeCull = null;
      return;
    }
    const turning = culled.some(turnsWithCamera);
    const lastCamera = geo.cartesian3.create(Number.NaN, 0, 0);
    let lastHeading = Number.NaN;
    removeCull ??= engine.frames.preRender.addEventListener(() => {
      const live = engine.camera.livePosition;
      const heading = turning ? engine.camera.pose().heading : 0;
      if (geo.cartesian3.equals(live, lastCamera) && heading === lastHeading)
        return;
      lastHeading = heading;
      geo.cartesian3.clone(live, lastCamera);
      let changed = false;
      for (const look of culled) changed = cull(look, heading) || changed;
      if (changed) request();
    });
  }

  const undrawn = Object.values(kinds).reduce((n, c) => n + c, 0);
  return {
    report: { drawn, undrawn, kinds },
    setShow(visibleNow) {
      visibleNow = Boolean(visibleNow);
      if (destroyed || visibleNow === shown) return;
      shown = visibleNow;
      for (const set of groundSets) set.show(shown);
      for (const line of lines) line.show(shown);
      for (const mesh of meshes) mesh.show(shown);
      for (const layer of layers) layer.show(shown);
      for (const look of looks.values()) {
        look.set?.setCount(shown ? look.count : 0);
        look.set?.commit();
      }
      syncCull();
      request();
    },
    /**
     * What the file covers (recordFootprint), its points at the heights
     * they draw at: on the ground sampled under them.
     */
    footprint() {
      const out = recordFootprint({ ...records, points: [] });
      for (const look of looks.values())
        for (const pin of look.pins)
          out.push([
            pin.lon,
            pin.lat,
            pin.height ?? (pin.ground ?? 0) + pin.offset,
          ]);
      return out;
    },
    /** Sample the ground under the points again (a map or the terrain changed). */
    async refreshGround(signal) {
      const total = pins.length;
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
