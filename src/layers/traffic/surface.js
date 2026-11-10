import { readSurface } from '../../globe/surfacePlacement.js';
import { phaseTiming } from '../../sources/phaseTiming.js';
import * as geo from '../../geo/index.js';
import { DOT_HEIGHT_OFFSET, MAX_WAYPOINTS_PER_ROAD } from './policy.js';

// Every surface read here goes through the globe contract (engine.surface,
// engine.picker, engine.projector, engine.maps), the same on every engine.

const renderedFrames = new WeakMap();
/** Observe completed frames only while an enabled traffic consumer owns them. */
export function observeTrafficSurface(engine) {
  if (!engine?.frames?.postRender?.addEventListener) return () => {};
  let frame = renderedFrames.get(engine);
  if (!frame) {
    frame = {
      viewProjection: geo.matrix4.create(),
      owners: 0,
    };
    renderedFrames.set(engine, frame);
    frame.remove = engine.frames.postRender.addEventListener(() => {
      engine.projector.viewProjection(frame.viewProjection);
      frame.surface = trafficSurfaceKey(engine);
      frame.ready = engine.surface.tilesLoaded();
    });
  }
  frame.owners++;
  let released = false;
  return () => {
    if (released) return;
    released = true;
    if (--frame.owners === 0) {
      frame.remove();
      renderedFrames.delete(engine);
    }
  };
}

const scratchViewProjection = geo.matrix4.create();
function currentRenderedFrame(engine) {
  const frame = renderedFrames.get(engine);
  return frame &&
    frame.surface === trafficSurfaceKey(engine) &&
    geo.matrix4.equals(
      frame.viewProjection,
      engine.projector.viewProjection(scratchViewProjection),
    )
    ? frame
    : null;
}

/** Only a completed render of this camera can certify cached surface heights. */
export function trafficSurfaceReady(engine) {
  return currentRenderedFrame(engine)?.ready === true;
}

/** Preserve bends and insert height samples at most 150 m apart, splitting long roads. */
export function roadSurfaceChunks(coordinates) {
  const chunks = [];
  let chunk = [coordinates[0]];
  let chunkMetres = 0;
  for (let i = 1; i < coordinates.length; i++) {
    const a = coordinates[i - 1],
      b = coordinates[i];
    const metres =
      Math.hypot(
        (b[0] - a[0]) * Math.cos((a[1] * Math.PI) / 180),
        b[1] - a[1],
      ) * 111320;
    const steps = Math.max(1, Math.ceil(metres / 150));
    for (let j = 1; j <= steps; j++) {
      const point =
        j === steps
          ? b
          : [
              a[0] + ((b[0] - a[0]) * j) / steps,
              a[1] + ((b[1] - a[1]) * j) / steps,
            ];
      const stepMetres = metres / steps;
      if (chunk.length > 1 && chunkMetres + stepMetres > 600) {
        chunks.push(chunk);
        chunk = [chunk.at(-1)];
        chunkMetres = 0;
      }
      chunk.push(point);
      chunkMetres += stepMetres;
      if (chunk.length === MAX_WAYPOINTS_PER_ROAD) {
        chunks.push(chunk);
        chunk = [point];
        chunkMetres = 0;
      }
    }
  }
  if (chunk.length > 1) chunks.push(chunk);
  return chunks;
}

/** Height stations remain at most 150 m apart without sampling every short bend. */
export function roadHeightStations(coords) {
  const distances = [0];
  const indices = [0];
  let anchor = 0;
  for (let i = 1; i < coords.length; i++) {
    const a = coords[i - 1],
      b = coords[i];
    const metres =
      Math.hypot(
        (b[0] - a[0]) * Math.cos((a[1] * Math.PI) / 180),
        b[1] - a[1],
      ) * 111320;
    distances.push(distances[i - 1] + metres);
    if (distances[i] - distances[anchor] > 150.001 && i - 1 > anchor) {
      anchor = i - 1;
      indices.push(anchor);
    }
  }
  if (indices.at(-1) !== coords.length - 1) indices.push(coords.length - 1);
  return { indices, distances };
}

const validHeight = (height) =>
  Number.isFinite(height) && Math.abs(height) <= 9000;

/**
 * Reuse the rendered depth buffer instead of drawing a new pick frustum per
 * station. Iteration corrects the projection's height estimate. A depth hit
 * is accepted only at this road coordinate (2 m), never on a foreground roof
 * or hillside projected onto a different geographic point. Traffic itself is
 * translucent and absent from the depth that pickPosition reads.
 */
export function renderedRoadHeight(engine, lon, lat, estimate) {
  const size = engine.host.size();
  if (
    !engine.picker.pickPositionSupported ||
    !currentRenderedFrame(engine) ||
    !size.width
  )
    return undefined;
  let height = validHeight(estimate) ? estimate : 0;
  const point = geo.cartesian3.create();
  const screen = geo.cartesian2.create();
  for (let attempt = 0; attempt < 4; attempt++) {
    geo.cartesian3.fromDegrees(lon, lat, height, undefined, point);
    if (
      !engine.projector.worldToWindow(point, screen) ||
      screen.x < 0 ||
      screen.y < 0 ||
      screen.x >= size.width ||
      screen.y >= size.height
    )
      return undefined;
    let hit;
    try {
      hit = engine.picker.pickPosition(screen);
    } catch {
      return undefined;
    }
    if (!hit) return undefined;
    const location = geo.cartographic.fromCartesian(hit);
    if (!location || !validHeight(location.height)) return undefined;
    const dx =
      (geo.math.toDegrees(location.longitude) - lon) *
      Math.cos((lat * Math.PI) / 180) *
      111320;
    const dy = (geo.math.toDegrees(location.latitude) - lat) * 111320;
    if (Math.hypot(dx, dy) <= 2) return location.height;
    height = location.height;
  }
  return undefined;
}

// Per-engine, coordinate-keyed LRU. Never writes raw samples into shared ground floors.
const heightCaches = new WeakMap();

// Stable ids for the map sources heights are sampled from.
const surfaceIds = new WeakMap();
let nextSurfaceId = 1;
const surfaceId = (object) => {
  if (!object || typeof object !== 'object') return 0;
  if (!surfaceIds.has(object)) surfaceIds.set(object, nextSurfaceId++);
  return surfaceIds.get(object);
};

/**
 * Name what heights are sampled against: the photoreal tiles shown, or the
 * globe under its base imagery and terrain (a terrain that loads after a
 * failure keeps the imagery). A map-provider or terrain switch changes it and
 * invalidates every cached height.
 */
const surfaceKeys = new WeakMap();
export function trafficSurfaceKey(engine) {
  let state = surfaceKeys.get(engine);
  if (!state) {
    state = { tiles: false, source: null, terrain: 0, key: '' };
    surfaceKeys.set(engine, state);
  }
  const tiles = engine.maps.photorealActive();
  const current = engine.maps.current();
  const source = tiles ? current.photoreal : current.baseImagery;
  const terrain = tiles ? 0 : engine.maps.terrainRevision();
  if (
    state.tiles !== tiles ||
    state.source !== source ||
    state.terrain !== terrain ||
    !state.key
  ) {
    state.tiles = tiles;
    state.source = source;
    state.terrain = terrain;
    // Allocate only when the actual map surface changes, never per frame.
    state.key = `${tiles ? 'tiles' : `globe:${terrain}`}:${surfaceId(source)}`;
  }
  return state.key;
}

/**
 * Level-of-detail band for a point seen from the camera: log2 of the
 * camera-to-point distance in 100 m steps. Streamed meshes refine roughly
 * one level per halving of distance, so a sample taken from a higher band
 * came from coarser geometry than the view now shows.
 */
export function detailBand(cameraLon, cameraLat, cameraHeight, lon, lat) {
  if (!Number.isFinite(cameraHeight)) return 0;
  const dx = (lon - cameraLon) * Math.cos((lat * Math.PI) / 180) * 111320;
  const dy = (lat - cameraLat) * 111320;
  const distance = Math.sqrt(dx * dx + dy * dy + cameraHeight * cameraHeight);
  return Math.max(0, Math.floor(Math.log2(distance / 100)));
}
// Yield to rendering/input between bounded work slices without reserving
// every slice for a separate vsync (which idles the remaining frame budget).
const nextSlice = (hasSurface) =>
  hasSurface && globalThis.scheduler?.yield
    ? globalThis.scheduler.yield()
    : new Promise((resolve) => setTimeout(resolve, 0));

/** Prepare only admitted roads in bounded slices; locally missing surfaces defer that road. */
export async function prepareRoadSurfaces(
  roads,
  engine,
  ground,
  excluded,
  signal,
  { onReady, onMetrics, frameBudgetMs = 12, revalidate = false } = {},
) {
  // Cached heights are only as good as the surface and detail they came
  // from: a provider switch drops them all, and a point now seen from a
  // closer band than its sample is re-sampled against the finer mesh.
  const surface = trafficSurfaceKey(engine);
  let cache = heightCaches.get(engine);
  if (!cache || cache.surface !== surface) {
    cache = { surface, heights: new Map() };
    heightCaches.set(engine, cache);
  }
  const cameraCarto = engine.camera.pose().cartographic;
  const cameraLon = cameraCarto ? geo.math.toDegrees(cameraCarto.longitude) : 0;
  const cameraLat = cameraCarto ? geo.math.toDegrees(cameraCarto.latitude) : 0;
  const cameraHeight = cameraCarto ? cameraCarto.height : NaN;
  const start = performance.now();
  const metrics = {
    sampleCount: 0,
    sampleMs: 0,
    cacheHits: 0,
    depthHits: 0,
    roads: roads.length,
    pending: 0,
    maxSliceMs: 0,
  };
  let sliceStart = performance.now();
  const carto = geo.cartographic.create();
  const ready = [],
    pending = [];
  for (const road of roads) {
    let resolved = true;
    let settledRoad = true;
    const { indices, distances } = roadHeightStations(road.coords);
    const heights = new Array(road.coords.length);
    for (const i of indices) {
      signal?.throwIfAborted();
      const [lon, lat] = road.coords[i];
      const key = `${lon.toFixed(6)},${lat.toFixed(6)}`;
      const cached = cache.heights.get(key);
      const settled = trafficSurfaceReady(engine);
      const band = detailBand(cameraLon, cameraLat, cameraHeight, lon, lat);
      let height =
        cached &&
        (!revalidate || cached.refined) &&
        (cached.settled || !settled) &&
        band >= cached.band
          ? cached.height
          : undefined;
      if (height !== undefined) {
        if (!cached.settled) settledRoad = false;
        metrics.cacheHits++;
        cache.heights.delete(key);
        cache.heights.set(key, cached);
      } else {
        if (!settled) settledRoad = false;
        carto.longitude = geo.math.toRadians(lon);
        carto.latitude = geo.math.toRadians(lat);
        carto.height = 0;
        const floor = ground?.cachedGroundFloor?.(lat, lon);
        let sampled;
        // The globe answers from its terrain. Photoreal tiles answer from the
        // rendered depth first, then from sampleHeight, which reads the
        // locally rendered mesh, not unresolved/offscreen tiles: global
        // tilesLoaded can stay false while this street is usable.
        const photoreal = engine.maps.photorealActive();
        if (!photoreal)
          sampled = readSurface(engine, carto, {
            prefer: 'terrain',
            minHeight: -9000,
          });
        else {
          const estimate = geo.cartographic.fromCartesian(
            road.waypoints[i],
          )?.height;
          sampled = renderedRoadHeight(engine, lon, lat, estimate);
          if (validHeight(sampled)) metrics.depthHits++;
        }
        if (photoreal && !validHeight(sampled)) {
          const sampleStart = performance.now();
          metrics.sampleCount++;
          try {
            sampled = readSurface(engine, carto, {
              exclude: excluded,
              prefer: 'tiles',
              minHeight: -9000,
            });
          } catch {
            /* local mesh missing */
          }
          metrics.sampleMs += performance.now() - sampleStart;
        }
        // A shared floor is a safe provisional waypoint, but not permission to
        // display a photoreal road: only local measured mesh heights admit it.
        if (!validHeight(sampled)) {
          // A coarser measured height still beats an unresolved road; the
          // finer sample is retried on the next pass.
          if (cached) height = cached.height;
          else {
            resolved = false;
            height = validHeight(floor) ? floor : 0;
          }
        } else {
          height = validHeight(floor) ? Math.max(sampled, floor) : sampled;
          cache.heights.delete(key);
          cache.heights.set(key, {
            height,
            settled,
            band,
            refined: revalidate,
          });
          while (cache.heights.size > 40000)
            cache.heights.delete(cache.heights.keys().next().value);
        }
      }
      heights[i] = height;
      const elapsed = performance.now() - sliceStart;
      if (elapsed >= frameBudgetMs) {
        metrics.maxSliceMs = Math.max(metrics.maxSliceMs, elapsed);
        // Before the first local mesh exists, give its tile/worker tasks the
        // normal queue priority instead of repeatedly probing an empty scene.
        await nextSlice(metrics.cacheHits + metrics.depthHits > 0);
        sliceStart = performance.now();
      }
    }
    let station = 1;
    for (let i = 0; i < road.coords.length; i++) {
      while (station < indices.length - 1 && i > indices[station]) station++;
      const a = indices[station - 1],
        b = indices[station];
      const span = distances[b] - distances[a];
      const t = span > 0 ? (distances[i] - distances[a]) / span : 0;
      const height = heights[a] + (heights[b] - heights[a]) * t;
      const [lon, lat] = road.coords[i];
      const floor = ground?.cachedGroundFloor?.(lat, lon);
      geo.cartesian3.fromDegrees(
        lon,
        lat,
        (validHeight(floor) ? Math.max(height, floor) : height) +
          DOT_HEIGHT_OFFSET,
        undefined,
        road.waypoints[i],
      );
    }
    for (let i = 0; i < road.segmentDist.length; i++)
      road.segmentDist[i] = geo.cartesian3.distance(
        road.waypoints[i],
        road.waypoints[i + 1],
      );
    road.surfaceReady = resolved;
    road.surfaceSettled = settledRoad;
    if (resolved) {
      ready.push(road);
      onReady?.(road);
    } else pending.push(road);
  }
  metrics.pending = pending.length;
  metrics.maxSliceMs = Math.max(
    metrics.maxSliceMs,
    performance.now() - sliceStart,
  );
  phaseTiming('surface', start, metrics);
  onMetrics?.(metrics);
  signal?.throwIfAborted();
  return { ready, pending, metrics };
}
