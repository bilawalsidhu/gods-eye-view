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
//   a ground fill.
// Nothing is pickable: an imported file has no card. Ground heights under
// the points come from engine.surface, sampled again by refreshGround():
// the terrain where the globe is drawn, else (3D tiles) the scene drawn
// under a low camera, never an imported point (as Cesium's import kept its
// pins out of height queries).

import * as geo from '../geo/index.js';
import { normalizeGroundItem } from '../globe/ground.js';
import { polygonShape, rectangleShape } from '../scenes/dataPacks/shapes.js';
import { composeIcon } from './geoImportPins.js';
import { recordFootprint } from './geoImportRecords.js';

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
// Canvas pixels every imported icon look shares (64 MiB of RGBA).
const ICON_PIXEL_BUDGET = 16 * 1024 * 1024;
// Canvas pixels every tinted or turned ground overlay of a file shares.
const OVERLAY_PIXEL_BUDGET = 16 * 1024 * 1024;
// The longest side of a tinted or turned ground overlay's canvas.
const MAX_OVERLAY_SIDE = 4096;
// Bound main-thread triangulation stalls and the number of raised outlines.
// Median polygonShape times (three runs on a fast laptop): 32,768 vertices
// took 58 ms (37 ms in 128 rings), versus 198 ms for 65,536 vertices.
// Holes make earcut quadratic: 1,000 took 110 ms and 10,000 took 4.8 s.
// Past the vertex limit only outlines draw; past the ring limit nothing draws.
const MAX_RAISED_RINGS = 128;
const MAX_RAISED_VERTICES = 32_768;
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

// A ground item the contract accepts, or null (a degenerate ring or line).
function checked(kind, item) {
  try {
    normalizeGroundItem(kind, item);
    return item;
  } catch {
    return null;
  }
}

// A ground overlay's box with east past west across 180°, and how a corner
// turns by its rotation: KML's degrees counter-clockwise about the centre,
// in longitude and latitude (Cesium's rectangle rotation).
function overlayBox({ rectangle, rotation = 0 }) {
  const { west, south, north } = rectangle;
  const east = rectangle.east < west ? rectangle.east + 360 : rectangle.east;
  const box = { west, south, east, north };
  const center = [(west + east) / 2, (south + north) / 2];
  const angle = (rotation * Math.PI) / 180;
  const [cos, sin] = [Math.cos(angle), Math.sin(angle)];
  const turn = ([lon, lat]) => {
    const [x, y] = [lon - center[0], lat - center[1]];
    return [center[0] + x * cos - y * sin, center[1] + x * sin + y * cos];
  };
  return { box, center, angle, turn };
}

// What a ground overlay's image layer draws: its image tinted by the
// overlay's colour and turned by its rotation onto the box around the
// turned image (transparent outside it). Null when that box passes a pole.
async function overlayImage(overlay, loadImage, createCanvas, maxSide, cache) {
  const tint = overlay.color.slice(0, 3);
  const { box, center, angle } = overlayBox(overlay);
  if (tint.every((value) => value === 1) && !angle)
    return { url: overlay.url, rectangle: overlay.rectangle };
  const [width, height] = [box.east - box.west, box.north - box.south];
  const [cos, sin] = [Math.abs(Math.cos(angle)), Math.abs(Math.sin(angle))];
  const [spanX, spanY] = [
    width * cos + height * sin,
    width * sin + height * cos,
  ];
  const rectangle = {
    west: center[0] - spanX / 2,
    south: center[1] - spanY / 2,
    east: center[0] + spanX / 2,
    north: center[1] + spanY / 2,
  };
  if (angle && (rectangle.south < -90 || rectangle.north > 90 || spanX >= 360))
    return null;
  const wrap = (lon) => (lon > 180 ? lon - 360 : lon < -180 ? lon + 360 : lon);
  const bounds = angle
    ? { ...rectangle, west: wrap(rectangle.west), east: wrap(rectangle.east) }
    : overlay.rectangle;
  const key = JSON.stringify([overlay.url, tint, angle, width / height]);
  if (cache.has(key)) return { image: cache.get(key), rectangle: bounds };
  let image;
  try {
    image = await loadImage(overlay.url);
  } catch {
    // An image that does not decode draws nothing, as on the plain path.
    return { url: overlay.url, rectangle: overlay.rectangle };
  }
  const natural = [
    image.naturalWidth || image.width,
    image.naturalHeight || image.height,
  ];
  // Pixels per degree: one scale on both axes when turned, so the image
  // turns in degrees as Cesium's does (the canvas budget bounds its size).
  let [scaleX, scaleY] = [natural[0] / width, natural[1] / height];
  if (angle) scaleX = scaleY = Math.max(scaleX, scaleY);
  const fit = Math.min(
    1,
    maxSide / (spanX * scaleX),
    maxSide / (spanY * scaleY),
  );
  [scaleX, scaleY] = [scaleX * fit, scaleY * fit];
  const canvas = createCanvas();
  canvas.width = Math.max(1, Math.round(spanX * scaleX));
  canvas.height = Math.max(1, Math.round(spanY * scaleY));
  const context = canvas.getContext('2d');
  context.translate(canvas.width / 2, canvas.height / 2);
  // The canvas's y runs south: a counter-clockwise turn is a negative one.
  context.rotate(-angle);
  context.drawImage(
    image,
    (-width * scaleX) / 2,
    (-height * scaleY) / 2,
    width * scaleX,
    height * scaleY,
  );
  if (tint.some((value) => value !== 1)) {
    const pixels = context.getImageData(0, 0, canvas.width, canvas.height);
    for (let i = 0; i < pixels.data.length; i += 4)
      for (let channel = 0; channel < 3; channel++)
        pixels.data[i + channel] *= tint[channel];
    context.putImageData(pixels, 0, 0);
  }
  cache.set(key, canvas);
  return { image: canvas, rectangle: bounds };
}

// KML headings are from north (Cesium's billboard on the Earth's axis):
// the sprite turns on screen with the camera's heading.
const turnsWithCamera = (look) => look.pins.some((pin) => pin.rotation);
const onScreen = (pin, heading) => (pin.rotation ? pin.rotation + heading : 0);

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
    pixelRatio = Math.max(1, Math.min(2, globalThis.devicePixelRatio || 1)),
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
  const kinds = { ...records.undrawn };
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
    // Fills under ground lines; a plain-colour overlay is a fill too.
    const fills = [];
    let lastYield = now();
    for (const polygon of records.polygons) {
      if (now() - lastYield > 8) {
        await new Promise((resolve) => setTimeout(resolve, 0));
        checkActive();
        lastYield = now();
      }
      let any = false;
      if (polygon.raised && polygon.rings.length > MAX_RAISED_RINGS) {
        kinds.complexPolygon = (kinds.complexPolygon ?? 0) + 1;
        continue;
      }
      if (polygon.fill && polygon.raised) {
        const vertices = polygon.rings.reduce((n, ring) => n + ring.length, 0);
        const shape =
          vertices <= MAX_RAISED_VERTICES && polygonShape(polygon.rings);
        if (vertices > MAX_RAISED_VERTICES)
          kinds.complexPolygon = (kinds.complexPolygon ?? 0) + 1;
        if (shape) {
          meshes.push(
            engine.meshes.createMesh({
              id: `${prefix}-fill-${meshes.length}`,
              positions: shape.attributes.position.values,
              indices: shape.indices,
              color: polygon.fill,
              show: shown,
            }),
          );
          any = true;
        }
      } else if (polygon.fill) {
        const item = checked('polygon', {
          rings: polygon.rings.map(flat),
          fill: polygon.fill,
        });
        if (item) {
          fills.push(item);
          any = true;
        } else kinds.polygon = (kinds.polygon ?? 0) + 1;
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
    const overlayCache = new Map();
    const overlayImages = new Map();
    const overlaySide = Math.min(
      MAX_OVERLAY_SIDE,
      Math.floor(
        Math.sqrt(OVERLAY_PIXEL_BUDGET / Math.max(1, records.overlays.length)),
      ),
    );
    // KML drawOrder, then the document's: equal layer orders draw in
    // creation order, and a file imported later over this one.
    const overlays = [...records.overlays].sort(
      (a, b) => (a.drawOrder ?? 0) - (b.drawOrder ?? 0),
    );
    for (const overlay of overlays) {
      // Cesium raises only an absolute overlay, to its altitude.
      const raise =
        overlay.altitudeMode === 'absolute' && overlay.altitude > 0
          ? overlay.altitude
          : undefined;
      if (overlay.url) {
        const prepared = await overlayImage(
          overlay,
          loadImage,
          createCanvas,
          overlaySide,
          overlayCache,
        );
        checkActive();
        if (!prepared) {
          kinds.rotatedOverlay = (kinds.rotatedOverlay ?? 0) + 1;
          continue;
        }
        if (raise) {
          let image = prepared.image ?? overlayImages.get(overlay.url);
          if (!image) {
            try {
              image = await loadImage(overlay.url);
              overlayImages.set(overlay.url, image);
            } catch {
              checkActive();
              kinds.raisedOverlay = (kinds.raisedOverlay ?? 0) + 1;
              continue;
            }
            checkActive();
          }
          const { west, south, east, north } = prepared.rectangle;
          const shape = rectangleShape([west, south, east, north], raise);
          meshes.push(
            engine.meshes.createMesh({
              id: `${prefix}-overlay-${meshes.length}`,
              positions: shape.attributes.position.values,
              indices: shape.indices,
              uv: shape.attributes.st.values,
              image,
              color: [1, 1, 1, Math.min(0.99, overlay.color[3])],
              show: shown,
            }),
          );
          drawn++;
          continue;
        }
        layers.push(
          engine.imagery.createLayer({
            id: `${prefix}-overlay-${layers.length}`,
            source: { kind: 'image', ...prepared },
            // Cesium's transparent image material: at most 0.99.
            alpha: Math.min(0.99, overlay.color[3]),
            show: shown,
            order: OVERLAY_ORDER,
          }),
        );
        drawn++;
        continue;
      }
      // A plain colour draws as a ground fill.
      if (raise) {
        kinds.raisedOverlay = (kinds.raisedOverlay ?? 0) + 1;
        continue;
      }
      const { west, south, east, north } = overlay.rectangle;
      const item = checked('cell', { west, south, east, north });
      if (!item) continue;
      const { box, turn } = overlayBox(overlay);
      const rings = [
        [
          [box.west, box.south],
          [box.east, box.south],
          [box.east, box.north],
          [box.west, box.north],
        ].map(turn),
      ];
      const fill = checked('polygon', { rings, fill: overlay.color });
      if (!fill) {
        kinds.rotatedOverlay = (kinds.rotatedOverlay ?? 0) + 1;
        continue;
      }
      fills.push(fill);
      drawn++;
    }
    if (fills.length) {
      const set = engine.ground.createSet({
        id: `${prefix}-polygons`,
        kind: 'polygon',
        order: POLYGON_ORDER,
      });
      groundSets.push(set);
      set.replace(fills);
      set.commit();
      set.show(shown);
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
      groundSets.push(set);
      set.replace(corridors);
      set.commit();
      set.show(shown);
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
    pins.push(...[...looks.values()].flatMap((look) => look.pins));
    const maxSide = Math.min(
      512,
      Math.floor(Math.sqrt(ICON_PIXEL_BUDGET / Math.max(1, looks.size))),
    );
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
        checkActive();
        const { canvas, side } = composeIcon(look.icon, {
          image,
          createCanvas,
          ratio: pixelRatio,
          maxSide,
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
        drawn += look.pins.length;
      }),
    );
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
