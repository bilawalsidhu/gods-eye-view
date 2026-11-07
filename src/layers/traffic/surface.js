import { phaseTiming } from '../../sources/phaseTiming.js';
import * as Cesium from 'cesium';
import { DOT_HEIGHT_OFFSET, MAX_WAYPOINTS_PER_ROAD } from './policy.js';

function surfaceTilesReady(scene) {
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

const renderedFrames = new WeakMap();
/** Observe completed frames only while an enabled traffic consumer owns them. */
export function observeTrafficSurface(scene) {
  if (!scene.postRender?.addEventListener || !scene.camera?.viewMatrix)
    return () => {};
  let frame = renderedFrames.get(scene);
  if (!frame) {
    frame = {
      view: new Cesium.Matrix4(),
      projection: new Cesium.Matrix4(),
      owners: 0,
    };
    renderedFrames.set(scene, frame);
    frame.remove = scene.postRender.addEventListener(() => {
      Cesium.Matrix4.clone(scene.camera.viewMatrix, frame.view);
      Cesium.Matrix4.clone(
        scene.camera.frustum.projectionMatrix,
        frame.projection,
      );
      frame.surface = trafficSurfaceKey(scene);
      frame.ready = surfaceTilesReady(scene);
    });
  }
  frame.owners++;
  let released = false;
  return () => {
    if (released) return;
    released = true;
    if (--frame.owners === 0) {
      frame.remove();
      renderedFrames.delete(scene);
    }
  };
}

function currentRenderedFrame(scene) {
  if (!scene.postRender?.addEventListener || !scene.camera?.viewMatrix)
    return { ready: surfaceTilesReady(scene) };
  const frame = renderedFrames.get(scene);
  return frame &&
    frame.surface === trafficSurfaceKey(scene) &&
    Cesium.Matrix4.equals(frame.view, scene.camera.viewMatrix) &&
    Cesium.Matrix4.equals(
      frame.projection,
      scene.camera.frustum.projectionMatrix,
    )
    ? frame
    : null;
}

/** Only a completed render of this camera can certify cached surface heights. */
export function trafficSurfaceReady(scene) {
  return currentRenderedFrame(scene)?.ready === true;
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
 * or hillside projected onto a different geographic point. Translucent traffic
 * is absent from Cesium's default pickPosition depth pass.
 */
export function renderedRoadHeight(scene, lon, lat, estimate) {
  if (
    !scene.pickPositionSupported ||
    scene.pickTranslucentDepth ||
    !currentRenderedFrame(scene) ||
    !scene.canvas?.clientWidth ||
    !scene.frameState
  )
    return undefined;
  let height = validHeight(estimate) ? estimate : 0;
  const point = new Cesium.Cartesian3();
  const screen = new Cesium.Cartesian2();
  for (let attempt = 0; attempt < 4; attempt++) {
    Cesium.Cartesian3.fromDegrees(lon, lat, height, undefined, point);
    if (
      !Cesium.SceneTransforms.worldToWindowCoordinates(scene, point, screen) ||
      screen.x < 0 ||
      screen.y < 0 ||
      screen.x >= scene.canvas.clientWidth ||
      screen.y >= scene.canvas.clientHeight
    )
      return undefined;
    let hit;
    try {
      hit = scene.pickPosition(screen);
    } catch {
      return undefined;
    }
    if (!hit) return undefined;
    const location = Cesium.Cartographic.fromCartesian(hit);
    if (!location || !validHeight(location.height)) return undefined;
    const dx =
      (Cesium.Math.toDegrees(location.longitude) - lon) *
      Math.cos((lat * Math.PI) / 180) *
      111320;
    const dy = (Cesium.Math.toDegrees(location.latitude) - lat) * 111320;
    if (Math.hypot(dx, dy) <= 2) return location.height;
    height = location.height;
  }
  return undefined;
}

// Per-scene, coordinate-keyed LRU. Never writes raw samples into shared ground floors.
const sceneCaches = new WeakMap();

// Stable ids for the objects heights are sampled from (tilesets, terrain).
const surfaceIds = new WeakMap();
let nextSurfaceId = 1;
const surfaceId = (object) => {
  if (!object || typeof object !== 'object') return 0;
  if (!surfaceIds.has(object)) surfaceIds.set(object, nextSurfaceId++);
  return surfaceIds.get(object);
};

/**
 * Name what heights are sampled against: the terrain provider when the globe
 * is shown, otherwise the set of visible 3D tilesets. A map-provider switch
 * changes it and invalidates every cached height.
 */
const surfaceKeys = new WeakMap();
export function trafficSurfaceKey(scene) {
  let state = surfaceKeys.get(scene);
  if (!state) {
    state = { globe: null, terrain: null, tiles: [], key: '' };
    surfaceKeys.set(scene, state);
  }
  const globe = Boolean(scene.globe?.show);
  const terrain = globe ? scene.globe.terrainProvider : null;
  let changed = state.globe !== globe || state.terrain !== terrain;
  let count = 0;
  if (!globe) {
    for (let i = 0; i < (scene.primitives?.length || 0); i++) {
      const primitive = scene.primitives.get(i);
      if (!primitive?.show || typeof primitive.tilesLoaded !== 'boolean')
        continue;
      if (state.tiles[count] !== primitive) {
        state.tiles[count] = primitive;
        changed = true;
      }
      count++;
    }
  }
  if (count !== state.tiles.length) {
    state.tiles.length = count;
    changed = true;
  }
  if (changed) {
    state.globe = globe;
    state.terrain = terrain;
    // Allocate only when the actual map surface changes, never per frame.
    state.key = globe
      ? `globe:${surfaceId(terrain)}`
      : `tiles:${state.tiles.map(surfaceId).join(',')}`;
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
  scene,
  ground,
  excluded,
  signal,
  { onReady, onMetrics, frameBudgetMs = 12, revalidate = false } = {},
) {
  // Cached heights are only as good as the surface and detail they came
  // from: a provider switch drops them all, and a point now seen from a
  // closer band than its sample is re-sampled against the finer mesh.
  const surface = trafficSurfaceKey(scene);
  let cache = sceneCaches.get(scene);
  if (!cache || cache.surface !== surface) {
    cache = { surface, heights: new Map() };
    sceneCaches.set(scene, cache);
  }
  const cameraCarto = scene.camera?.positionCartographic;
  const cameraLon = cameraCarto
    ? Cesium.Math.toDegrees(cameraCarto.longitude)
    : 0;
  const cameraLat = cameraCarto
    ? Cesium.Math.toDegrees(cameraCarto.latitude)
    : 0;
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
  const carto = new Cesium.Cartographic();
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
      const settled = trafficSurfaceReady(scene);
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
        carto.longitude = Cesium.Math.toRadians(lon);
        carto.latitude = Cesium.Math.toRadians(lat);
        carto.height = 0;
        const floor = ground?.cachedGroundFloor?.(lat, lon);
        let sampled;
        // sampleHeight reads the locally rendered mesh, not unresolved/offscreen
        // tiles. Global tilesLoaded can stay false while this street is usable.
        if (scene.globe?.show) sampled = scene.globe.getHeight?.(carto);
        else {
          const estimate = Cesium.Cartographic.fromCartesian(
            road.waypoints[i],
          )?.height;
          sampled = renderedRoadHeight(scene, lon, lat, estimate);
          if (validHeight(sampled)) metrics.depthHits++;
        }
        if (
          !scene.globe?.show &&
          !validHeight(sampled) &&
          scene.sampleHeightSupported
        ) {
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
      Cesium.Cartesian3.fromDegrees(
        lon,
        lat,
        (validHeight(floor) ? Math.max(height, floor) : height) +
          DOT_HEIGHT_OFFSET,
        undefined,
        road.waypoints[i],
      );
    }
    for (let i = 0; i < road.segmentDist.length; i++)
      road.segmentDist[i] = Cesium.Cartesian3.distance(
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
