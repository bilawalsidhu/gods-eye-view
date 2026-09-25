import { phaseTiming } from '../../sources/phaseTiming.js';
import * as Cesium from 'cesium';
import { DOT_HEIGHT_OFFSET, MAX_WAYPOINTS_PER_ROAD } from './policy.js';

/** Detect a settled surface for background revalidation, never as a first-paint barrier. */
export function trafficSurfaceReady(scene) {
  if (scene.globe?.show) return scene.globe.tilesLoaded !== false;
  let found = false;
  for (let i = 0; i < (scene.primitives?.length || 0); i++) {
    const primitive = scene.primitives.get(i);
    if (!primitive.show || typeof primitive.tilesLoaded !== 'boolean') continue;
    found = true;
    if (!primitive.tilesLoaded) return false;
  }
  return found;
}

/** Preserve bends and insert height samples at most 150 m apart, splitting long roads. */
export function roadSurfaceChunks(coordinates) {
  const chunks = [];
  let chunk = [coordinates[0]];
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
      chunk.push(point);
      if (chunk.length === MAX_WAYPOINTS_PER_ROAD) {
        chunks.push(chunk);
        chunk = [point];
      }
    }
  }
  if (chunk.length > 1) chunks.push(chunk);
  return chunks;
}

const validHeight = (height) =>
  Number.isFinite(height) && Math.abs(height) <= 9000;

// Per-scene, coordinate-keyed LRU. Never writes raw samples into shared ground floors.
const sceneCaches = new WeakMap();
const nextFrame = () =>
  new Promise((resolve) =>
    typeof requestAnimationFrame === 'function'
      ? requestAnimationFrame(resolve)
      : setTimeout(resolve, 0),
  );

/** Prepare only admitted roads in bounded slices; locally missing surfaces defer that road. */
export async function prepareRoadSurfaces(
  roads,
  scene,
  ground,
  excluded,
  signal,
  { onReady, onMetrics, frameBudgetMs = 6 } = {},
) {
  let cache = sceneCaches.get(scene);
  if (!cache || cache.globe !== scene.globe?.show) {
    cache = { globe: scene.globe?.show, heights: new Map() };
    sceneCaches.set(scene, cache);
  }
  const start = performance.now();
  const metrics = {
    sampleCount: 0,
    sampleMs: 0,
    cacheHits: 0,
    roads: roads.length,
    pending: 0,
    maxSliceMs: 0,
  };
  let sliceStart = performance.now();
  const carto = new Cesium.Cartographic();
  const ready = [],
    pending = [];
  for (const road of roads) {
    let resolved = true;
    for (let i = 0; i < road.coords.length; i++) {
      signal?.throwIfAborted();
      const [lon, lat] = road.coords[i];
      const key = `${lon.toFixed(6)},${lat.toFixed(6)}`;
      const cached = cache.heights.get(key);
      const settled = trafficSurfaceReady(scene);
      let height =
        cached && (cached.settled || !settled) ? cached.height : undefined;
      if (height !== undefined) {
        metrics.cacheHits++;
        cache.heights.delete(key);
        cache.heights.set(key, cached);
      } else {
        carto.longitude = Cesium.Math.toRadians(lon);
        carto.latitude = Cesium.Math.toRadians(lat);
        carto.height = 0;
        const floor = ground?.cachedGroundFloor?.(lat, lon);
        let sampled;
        // sampleHeight reads the locally rendered mesh, not unresolved/offscreen
        // tiles. Global tilesLoaded can stay false while this street is usable.
        if (scene.globe?.show) sampled = scene.globe.getHeight?.(carto);
        else if (scene.sampleHeightSupported) {
          const sampleStart = performance.now();
          metrics.sampleCount++;
          const shown = (excluded || []).filter((p) => p?.show);
          for (const primitive of shown) primitive.show = false;
          try {
            sampled = scene.sampleHeight(carto, excluded);
          } catch {
            /* local mesh missing */
          } finally {
            for (const primitive of shown) primitive.show = true;
          }
          metrics.sampleMs += performance.now() - sampleStart;
        }
        // A shared floor is a safe provisional waypoint, but not permission to
        // display a photoreal road: only local measured mesh heights admit it.
        if (!validHeight(sampled)) {
          resolved = false;
          height = validHeight(floor) ? floor : 0;
        } else {
          height = validHeight(floor) ? Math.max(sampled, floor) : sampled;
          cache.heights.set(key, { height, settled });
          while (cache.heights.size > 40000)
            cache.heights.delete(cache.heights.keys().next().value);
        }
      }
      Cesium.Cartesian3.fromDegrees(
        lon,
        lat,
        height + DOT_HEIGHT_OFFSET,
        undefined,
        road.waypoints[i],
      );
      const elapsed = performance.now() - sliceStart;
      if (elapsed >= frameBudgetMs) {
        metrics.maxSliceMs = Math.max(metrics.maxSliceMs, elapsed);
        await nextFrame();
        sliceStart = performance.now();
      }
    }
    for (let i = 0; i < road.segmentDist.length; i++)
      road.segmentDist[i] = Cesium.Cartesian3.distance(
        road.waypoints[i],
        road.waypoints[i + 1],
      );
    road.surfaceReady = resolved;
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
