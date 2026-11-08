import { phaseTiming } from '../../sources/phaseTiming.js';
import { DOT_HEIGHT_OFFSET, MAX_WAYPOINTS_PER_ROAD } from './policy.js';
import { heightsOf } from '../../queries/heights.js';
import { fromDegreesInto, toLonLatH } from '../../geo/ellipsoid.js';
import { distanceSquared } from '../../geo/vector.js';
import {
  canvasOf,
  findCamera,
  findFrame,
  findGlobe,
  findQuery,
} from '../../render/rendererOf.js';
import { surfaceTilesReady, trafficSurfaceKey } from './rendering.js';

export { trafficSurfaceKey };

/** Whether the globe surface is drawn (else tiles alone are). */
const globeShown = (viewer) => findGlobe(viewer)?.isGlobeVisible?.() === true;

/** The camera's view and projection now, when the renderer reports them. */
function cameraMatrices(viewer) {
  const camera = findCamera(viewer);
  return typeof camera?.matrices === 'function'
    ? (camera.matrices() ?? null)
    : null;
}

const sameMatrix = (a, b) =>
  a.length === b.length && a.every((value, i) => value === b[i]);

const renderedFrames = new WeakMap();
/** Observe completed frames only while an enabled traffic consumer owns them. */
export function observeTrafficSurface(viewer) {
  const frame = findFrame(viewer);
  if (!frame || !cameraMatrices(viewer)) return () => {};
  let rendered = renderedFrames.get(viewer);
  if (!rendered) {
    rendered = { view: null, projection: null, owners: 0 };
    renderedFrames.set(viewer, rendered);
    rendered.remove = frame.on('postRender', () => {
      const matrices = cameraMatrices(viewer);
      rendered.view = matrices?.view ?? null;
      rendered.projection = matrices?.projection ?? null;
      rendered.surface = trafficSurfaceKey(viewer);
      rendered.ready = surfaceTilesReady(viewer);
    });
  }
  rendered.owners++;
  let released = false;
  return () => {
    if (released) return;
    released = true;
    if (--rendered.owners === 0) {
      rendered.remove();
      renderedFrames.delete(viewer);
    }
  };
}

/**
 * The completed frame drawn from the camera as it is now, of the surface
 * drawn now; null when the camera has moved or the surface changed since.
 * Without a frame port or camera matrices, the surface's readiness alone.
 */
function currentRenderedFrame(viewer) {
  if (!findFrame(viewer)) return { ready: surfaceTilesReady(viewer) };
  const matrices = cameraMatrices(viewer);
  if (!matrices) return { ready: surfaceTilesReady(viewer) };
  const frame = renderedFrames.get(viewer);
  return frame?.view &&
    frame.surface === trafficSurfaceKey(viewer) &&
    sameMatrix(frame.view, matrices.view) &&
    sameMatrix(frame.projection, matrices.projection)
    ? frame
    : null;
}

/**
 * Whether the frame being drawn has its surface loaded, read while it
 * finishes (from a frame-port `postRender` listener). It answers what the
 * rendered-frame observer is recording for this same frame, which a frame
 * listener may run before.
 */
export function drawnSurfaceReady(viewer) {
  return surfaceTilesReady(viewer);
}

/** Only a completed render of this camera can certify cached surface heights. */
export function trafficSurfaceReady(viewer) {
  return currentRenderedFrame(viewer)?.ready === true;
}

/**
 * The surface reads here over what `viewer` draws, through its renderer's
 * ports.
 * @param {object|undefined} viewer
 */
export function viewerRoadSurface(viewer) {
  return {
    drawnReady: () => drawnSurfaceReady(viewer),
    ready: () => trafficSurfaceReady(viewer),
    prepare: (roads, ...rest) => prepareRoadSurfaces(roads, viewer, ...rest),
    loadedHeight: (location) => loadedSurfaceHeight(viewer, location),
  };
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
 * One loaded-surface height at a point, for the view-height estimate road
 * selection starts from: terrain while the globe is shown, otherwise what is
 * drawn where the renderer can sample it (draw sets, the layer's own dots
 * among them, are seen through). Undefined when it cannot say.
 * @param {object|undefined} viewer
 * @param {{lon: number, lat: number}} location Degrees.
 * @returns {number|null|undefined}
 */
export function loadedSurfaceHeight(viewer, location) {
  if (!viewer) return undefined;
  const heights = heightsOf(viewer);
  return globeShown(viewer)
    ? heights.now(location, { against: 'terrain' })
    : heights.supported().surface
      ? heights.now(location)
      : undefined;
}

/**
 * Reuse the rendered depth buffer instead of drawing a new pick frustum per
 * station. Iteration corrects the projection's height estimate. A depth hit
 * is accepted only at this road coordinate (2 m), never on a foreground roof
 * or hillside projected onto a different geographic point. The query port's
 * depth pick answers against tiles and terrain, never the translucent dots.
 * `rendered` is the completed frame of this camera, as `prepareRoadSurfaces`
 * read it for its current slice.
 */
export function renderedRoadHeight(
  viewer,
  lon,
  lat,
  estimate,
  rendered = currentRenderedFrame(viewer),
) {
  const query = findQuery(viewer);
  const canvas = canvasOf(viewer);
  if (!query || !rendered || !canvas?.clientWidth) return undefined;
  let height = validHeight(estimate) ? estimate : 0;
  const point = { x: 0, y: 0, z: 0 };
  for (let attempt = 0; attempt < 4; attempt++) {
    fromDegreesInto(lon, lat, height, point);
    const screen = query.project(point);
    if (
      !screen ||
      !(screen.x >= 0) ||
      !(screen.y >= 0) ||
      screen.x >= canvas.clientWidth ||
      screen.y >= canvas.clientHeight
    )
      return undefined;
    let hit;
    try {
      hit = query.pickPosition(screen.x, screen.y);
    } catch {
      return undefined;
    }
    if (!hit) return undefined;
    const location = toLonLatH(hit);
    if (!location || !validHeight(location.height)) return undefined;
    const dx = (location.lon - lon) * Math.cos((lat * Math.PI) / 180) * 111320;
    const dy = (location.lat - lat) * 111320;
    if (Math.hypot(dx, dy) <= 2) return location.height;
    height = location.height;
  }
  return undefined;
}

// Per-viewer, coordinate-keyed LRU. Never writes raw samples into shared ground floors.
const sceneCaches = new WeakMap();

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
  viewer,
  ground,
  signal,
  { onReady, onMetrics, frameBudgetMs = 12, revalidate = false } = {},
) {
  // Cached heights are only as good as the surface and detail they came
  // from: a provider switch drops them all, and a point now seen from a
  // closer band than its sample is re-sampled against the finer mesh.
  const surface = trafficSurfaceKey(viewer);
  let cache = sceneCaches.get(viewer);
  if (!cache || cache.surface !== surface) {
    cache = { surface, heights: new Map() };
    sceneCaches.set(viewer, cache);
  }
  const eye = findCamera(viewer)?.pose()?.position;
  const cameraAt = eye ? toLonLatH(eye) : null;
  const cameraLon = cameraAt ? cameraAt.lon : 0;
  const cameraLat = cameraAt ? cameraAt.lat : 0;
  const cameraHeight = cameraAt ? cameraAt.height : NaN;
  const heights = heightsOf(viewer);
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
  // What the view holds can only change between slices (no frame draws
  // within one), so each slice reads it once.
  let rendered, settled, globe;
  const readView = () => {
    rendered = currentRenderedFrame(viewer);
    settled = rendered?.ready === true;
    globe = globeShown(viewer);
  };
  readView();
  const location = { lon: 0, lat: 0 };
  const ready = [],
    pending = [];
  for (const road of roads) {
    let resolved = true;
    let settledRoad = true;
    const { indices, distances } = roadHeightStations(road.coords);
    const stationHeights = new Array(road.coords.length);
    for (const i of indices) {
      signal?.throwIfAborted();
      const [lon, lat] = road.coords[i];
      const key = `${lon.toFixed(6)},${lat.toFixed(6)}`;
      const cached = cache.heights.get(key);
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
        location.lon = lon;
        location.lat = lat;
        const floor = ground?.cachedGroundFloor?.(lat, lon);
        let sampled;
        // A height now reads the locally rendered mesh, not unresolved or
        // offscreen tiles. Global readiness can stay false while this street
        // is usable.
        if (globe) sampled = heights.now(location, { against: 'terrain' });
        else {
          const estimate = toLonLatH(road.waypoints[i])?.height;
          sampled = renderedRoadHeight(viewer, lon, lat, estimate, rendered);
          if (validHeight(sampled)) metrics.depthHits++;
        }
        if (!globe && !validHeight(sampled) && heights.supported().surface) {
          const sampleStart = performance.now();
          metrics.sampleCount++;
          // A miss is the local mesh still missing. Draw sets, the dots
          // among them, are seen through.
          sampled = heights.now(location);
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
      stationHeights[i] = height;
      const elapsed = performance.now() - sliceStart;
      if (elapsed >= frameBudgetMs) {
        metrics.maxSliceMs = Math.max(metrics.maxSliceMs, elapsed);
        // Before the first local mesh exists, give its tile/worker tasks the
        // normal queue priority instead of repeatedly probing an empty scene.
        await nextSlice(metrics.cacheHits + metrics.depthHits > 0);
        readView();
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
      const height =
        stationHeights[a] + (stationHeights[b] - stationHeights[a]) * t;
      const [lon, lat] = road.coords[i];
      const floor = ground?.cachedGroundFloor?.(lat, lon);
      fromDegreesInto(
        lon,
        lat,
        (validHeight(floor) ? Math.max(height, floor) : height) +
          DOT_HEIGHT_OFFSET,
        road.waypoints[i],
      );
    }
    for (let i = 0; i < road.segmentDist.length; i++)
      road.segmentDist[i] = Math.sqrt(
        distanceSquared(road.waypoints[i], road.waypoints[i + 1]),
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
