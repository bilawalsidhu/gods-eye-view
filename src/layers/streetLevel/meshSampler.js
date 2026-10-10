import * as Cesium from 'cesium';
import { metresBetween, whenIdle } from './view.js';

/**
 * Google 3D surface heights for ground casting (groundCast.js refineHeights):
 * one cached `scene.sampleHeight` probe per ~11 m cell. Each probe renders a
 * pick pass (1–3 ms), so probes run in budgeted idle slices, nearest the
 * camera first and only within MESH_SAMPLE_RADIUS_M. Like the application's
 * mesh floor, a probe waits for the visible tileset to finish streaming and a
 * sample counts only within the shared window around a real bare-earth height;
 * anything else is a miss, retried later. Probes hit 3D tilesets only.
 */

/** Cell size, in degrees (~11 m): samples are shared within a cell. */
export const MESH_CELL_DEG = 0.0001;
/** Cells farther than this from the point under the camera are not probed. */
export const MESH_SAMPLE_RADIUS_M = 900;
/** Main-thread time per idle slice, taking requests in and ranking included. */
export const MESH_SAMPLE_BUDGET_MS = 6;
/** The queue is re-ranked once the camera has moved this far, in metres. */
export const MESH_RERANK_M = 100;
/** A cell whose probe missed is tried again after this long. */
export const MESH_MISS_RETRY_MS = 8000;
/** While the visible tileset is streaming, the next probe waits this long. */
export const MESH_STREAMING_WAIT_MS = 500;
/**
 * A sampled cell is probed again once the camera is half as far from it as at
 * its last probe (finer tiles have loaded by then), down to this distance:
 * at most a handful of probes per cell.
 */
export const MESH_REFRESH_MIN_M = 40;
/** A refreshed sample that moved less than this is not redrawn. */
const MESH_REFRESH_CHANGE_M = 0.5;
/** Cached cells (and remembered misses) before they are dropped and refilled. */
const MESH_CACHE_MAX = 80_000;
/** Listeners hear about new samples at most this often. */
const MESH_NOTIFY_MS = 700;

const cellOf = (value) => Math.round(value / MESH_CELL_DEG);

/** Numeric key of the cell holding a point (exact within 2^53; no per-point string). */
export const meshCellKey = (lon, lat) =>
  (cellOf(lon) + 1_800_001) * 2_000_000 + cellOf(lat) + 1_000_000;

/** Add a queued cell to a min-heap on `distance`. */
function heapPush(heap, cell) {
  let i = heap.push(cell) - 1;
  while (i > 0) {
    const parent = (i - 1) >> 1;
    if (heap[parent].distance <= cell.distance) break;
    heap[i] = heap[parent];
    i = parent;
  }
  heap[i] = cell;
}

/** Restore the heap below `i` after its cell was replaced. */
function siftDown(heap, i) {
  const cell = heap[i];
  const n = heap.length;
  for (;;) {
    let child = 2 * i + 1;
    if (child >= n) break;
    if (child + 1 < n && heap[child + 1].distance < heap[child].distance)
      child++;
    if (heap[child].distance >= cell.distance) break;
    heap[i] = heap[child];
    i = child;
  }
  heap[i] = cell;
}

function heapPop(heap) {
  const top = heap[0];
  const last = heap.pop();
  if (heap.length) {
    heap[0] = last;
    siftDown(heap, 0);
  }
  return top;
}

/** Every top-level primitive that is not a 3D tileset: what a probe skips. */
function overlays(scene) {
  const out = [];
  const primitives = scene.primitives;
  for (let i = 0; i < primitives.length; i++) {
    const primitive = primitives.get(i);
    if (!(primitive instanceof Cesium.Cesium3DTileset)) out.push(primitive);
  }
  return out;
}

/**
 * `groundAt(lon, lat)` is the bare-earth height or null, `withinPrior(height,
 * prior)` the application's mesh window, and `tilesReady(scene)` whether the
 * visible tileset has finished streaming.
 * @param {{getViewer: () => object|null, groundAt?: Function, withinPrior?: Function, tilesReady?: Function, budgetMs?: number, radiusM?: number, cacheMax?: number, now?: () => number}} options
 */
export function createMeshSampler({
  getViewer,
  groundAt = null,
  withinPrior = null,
  tilesReady = null,
  budgetMs = MESH_SAMPLE_BUDGET_MS,
  radiusM = MESH_SAMPLE_RADIUS_M,
  cacheMax = MESH_CACHE_MAX,
  now = () => performance.now(),
}) {
  /** cell key → sampled mesh height (ellipsoidal metres). */
  const heights = new Map();
  /** cell key → camera distance (m) at the cell's last probe. */
  const probedFrom = new Map();
  /** cell key → retry time for probes that hit nothing; bounded like the height cache. */
  const misses = new Map();
  /** cell key → queued cell, so a cell is queued once. */
  const wanted = new Map();
  /** Queued {key, lon, lat, distance} cells, a min-heap on distance from `rankedFrom`. */
  let queue = [];
  /** Requests not yet taken in: {points, next, centre} (centre: the camera then). */
  let intake = [];
  /** Where the camera was when the queue was ranked. */
  let rankedFrom = null;
  /** Running estimate of one probe's cost, so a slice stops before overrunning. */
  let probeMs = 1;
  const listeners = new Set();
  let enabled = false;
  let running = false;
  let fresh = [];
  let notifyTimer = null;

  /** The sampled mesh height for a point, or undefined when not sampled. */
  function meshAt(lon, lat) {
    return heights.get(meshCellKey(lon, lat));
  }

  /** The point under the camera, with the camera's height, or null. */
  function cameraCentre() {
    const carto = getViewer()?.camera?.positionCartographic;
    if (!carto) return null;
    return {
      lon: Cesium.Math.toDegrees(carto.longitude),
      lat: Cesium.Math.toDegrees(carto.latitude),
      height: carto.height,
    };
  }

  /** Camera distance (m) to a cell at `height`, from its ground distance. */
  function cameraDistance(ground, centre, height) {
    const above = (centre.height ?? 0) - (height ?? 0);
    return Number.isFinite(above)
      ? Math.hypot(ground, Math.max(0, above))
      : ground;
  }

  /** A sampled cell is probed again once the camera is half as far as before. */
  function dueForRefresh(key, distance) {
    const last = probedFrom.get(key);
    return last > MESH_REFRESH_MIN_M && distance < last / 2;
  }

  /** A probe result the application would accept, or undefined. */
  function validated(height, lon, lat) {
    if (!Number.isFinite(height)) return undefined;
    if (!groundAt) return height;
    const prior = groundAt(lon, lat);
    if (!Number.isFinite(prior)) return undefined;
    return !withinPrior || withinPrior(height, prior) ? height : undefined;
  }

  /**
   * Ask for the cells under [lon, lat] points; the list is read later, so do
   * not mutate it. Out-of-range cells are dropped; callers ask again on move.
   */
  function request(points) {
    if (!enabled || !points?.length) return;
    const centre = cameraCentre();
    if (!centre) return;
    intake.push({ points, next: 0, centre });
    schedule();
  }

  /** Queue requested cells, oldest request first, until the slice reaches `until`. */
  function takeIn(until) {
    const time = Date.now();
    while (intake.length) {
      const pending = intake[0];
      const { points, centre } = pending;
      while (pending.next < points.length) {
        if ((pending.next & 255) === 255 && now() > until) return;
        const [lon, lat] = points[pending.next++];
        if (!Number.isFinite(lon) || !Number.isFinite(lat)) continue;
        const key = meshCellKey(lon, lat);
        if (wanted.has(key)) continue;
        const cell = {
          key,
          lon: cellOf(lon) * MESH_CELL_DEG,
          lat: cellOf(lat) * MESH_CELL_DEG,
          distance: 0,
        };
        const ground = metresBetween(cell, centre);
        if (ground > radiusM) continue;
        if (
          heights.has(key) &&
          !dueForRefresh(key, cameraDistance(ground, centre, heights.get(key)))
        )
          continue;
        const retryAt = misses.get(key);
        if (retryAt !== undefined) {
          if (retryAt > time) continue;
          misses.delete(key);
        }
        cell.distance = metresBetween(cell, rankedFrom);
        wanted.set(key, cell);
        heapPush(queue, cell);
      }
      intake.shift();
    }
  }

  /**
   * Rank the queue from where the camera is now, dropping cells it has left
   * out of range: one linear heapify, run only after the camera has moved.
   */
  function rerank(centre) {
    rankedFrom = centre;
    const kept = [];
    for (const cell of queue) {
      cell.distance = metresBetween(cell, centre);
      if (cell.distance > radiusM) wanted.delete(cell.key);
      else kept.push(cell);
    }
    queue = kept;
    for (let i = (queue.length >> 1) - 1; i >= 0; i--) siftDown(queue, i);
  }

  function clearQueue() {
    intake = [];
    wanted.clear();
    queue = [];
    rankedFrom = null;
  }

  function schedule() {
    if (running || !enabled || !(queue.length || intake.length)) return;
    running = true;
    whenIdle(step, 300);
  }

  function emit() {
    notifyTimer = null;
    const batch = fresh;
    fresh = [];
    for (const listener of [...listeners]) {
      try {
        listener(batch);
      } catch (error) {
        console.warn('[Data:StreetLevel] mesh listener error:', error);
      }
    }
  }

  function step(deadline) {
    running = false;
    // The slice starts now: taking requests in and ranking count too.
    const started = now();
    const until =
      started +
      Math.min(budgetMs, Math.max(1, deadline?.timeRemaining?.() ?? budgetMs));
    const scene = getViewer()?.scene;
    const centre = cameraCentre();
    if (!enabled || !scene?.sampleHeightSupported || !centre) return;
    // Mid-stream tiles answer with coarse heights: wait for the stream.
    if (tilesReady && !tilesReady(scene)) {
      running = true;
      setTimeout(() => {
        running = false;
        schedule();
      }, MESH_STREAMING_WAIT_MS);
      return;
    }
    // Nearest first, ranked from where the camera was; out-of-range cells
    // are dropped (they stay bare earth).
    let worked = false;
    if (!rankedFrom || metresBetween(rankedFrom, centre) > MESH_RERANK_M) {
      rerank(centre);
      worked = true;
    }
    if (intake.length) {
      // Leave room for a probe, so a stream of requests cannot starve them.
      takeIn(until - probeMs);
      worked = true;
    }
    const exclude = overlays(scene);
    let probed = 0;
    while (queue.length) {
      // Stop before a probe would overrun the slice. A slice that did
      // nothing else always probes once, so the queue drains.
      if ((probed || worked) && now() + probeMs > until) break;
      const { key, lon, lat } = heapPop(queue);
      wanted.delete(key);
      // Ranked from up to MESH_RERANK_M away: check the range from here.
      const ground = metresBetween({ lon, lat }, centre);
      if (ground > radiusM) continue;
      probed++;
      const probeStarted = now();
      let height;
      try {
        height = scene.sampleHeight(
          Cesium.Cartographic.fromDegrees(lon, lat),
          exclude,
        );
      } catch {
        height = undefined;
      }
      probeMs = probeMs * 0.75 + (now() - probeStarted) * 0.25;
      height = validated(height, lon, lat);
      const previous = heights.get(key);
      if (height === undefined) {
        // A miss, or a failed refresh: the old sample (if any) and the
        // distance it was taken from stay, and the probe is retried after
        // the same cooldown.
        if (misses.size >= cacheMax) misses.clear();
        misses.set(key, Date.now() + MESH_MISS_RETRY_MS);
        continue;
      }
      if (previous === undefined && heights.size >= cacheMax) forget();
      misses.delete(key);
      heights.set(key, height);
      probedFrom.set(key, cameraDistance(ground, centre, height));
      if (
        previous === undefined ||
        Math.abs(height - previous) >= MESH_REFRESH_CHANGE_M
      )
        fresh.push([lon, lat]);
    }
    if (fresh.length && !notifyTimer)
      notifyTimer = setTimeout(emit, MESH_NOTIFY_MS);
    schedule();
  }

  function forget() {
    heights.clear();
    probedFrom.clear();
    misses.clear();
  }

  /** Probe only while overlays are cast (Google 3D at street zoom). */
  function setEnabled(on) {
    enabled = on === true;
    if (!enabled) clearQueue();
    else schedule();
  }

  /** Hear about newly sampled cells, as [lon, lat] cell centres. */
  function onSampled(listener) {
    listeners.add(listener);
    return () => listeners.delete(listener);
  }

  function destroy() {
    enabled = false;
    forget();
    clearQueue();
    listeners.clear();
    clearTimeout(notifyTimer);
    notifyTimer = null;
  }

  return { meshAt, request, setEnabled, onSampled, destroy };
}
