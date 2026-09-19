/**
 * @module syntheticTraffic
 * @description TomTom-flow-driven synthetic vehicle fallback.
 *
 * Real GTFS-RT transit vehicles are available only in Boston, the
 * Netherlands, and the Twin Cities. Outside those service areas, this
 * layer reads TomTom flow tiles and animates "phantom" vehicles along the
 * flow polylines. Speeds track the TomTom `trafficLevel` so a jammed
 * motorway visibly slows while a free-flowing minor street runs fast.
 *
 * Gating: the layer is bbox-aware. If any registered GTFS-RT service box
 * covers the visible rect, synthetics stay silent — the real feed is the
 * source of truth there, and we'd otherwise double-up on vehicles. The user
 * toggles this layer independently of `transitVehicles`; either, both, or
 * neither may be enabled at a time.
 *
 * Layer contract (same as `transitVehicles`):
 *   init(viewer)         — wire up the point collection + state
 *   enable(viewer)       — start polling, attach camera gate
 *   disable(viewer)      — stop polling, hide points, abort inflight
 *   async update()       — one poll cycle (also fired by layer manager tick)
 *   destroy(viewer)      — release primitives + listeners
 *   getDetectableObjects — for HUD detection overlay
 *   getStats()           — { count, lastUpdate, loading, error, ... }
 *
 * Animation: each phantom's position is a `CallbackProperty` that advances
 * along its segment polyline at a constant speed. The set is rebuilt on
 * every flow-tile refresh — phantoms are cheap to allocate, and the bbox
 * set can shift between viewports.
 */

import * as Cesium from 'cesium';
import { fetchFlowForBounds, getFlowSessionStats } from './flowTiles.js';
import { gtfsRtAnyFeedCoversRect } from './gtfsRtPolicy.js';
import { governorRequestRender } from '../renderGovernor.js';
import { registerSpriteCollection, restoreSpriteOrder } from './spriteOrder.js';
import { registerDynamicCredit, TOMTOM_CREDIT } from './dataCredits.js';

// ---------------------------------------------------------------------------
// Tuning constants
// ---------------------------------------------------------------------------

/** Camera-altitude gate: same band as transitVehicles — vehicles are
 * unreadable from space. */
const ACTIVATION_ENTER_ALTITUDE_M = 80_000;
const ACTIVATION_EXIT_ALTITUDE_M = 100_000;

/** Polling cadence for the camera-driven tile reload. The TomTom flow tiles
 * themselves cache for 120s; faster polling just confirms "no change here". */
const POLL_INTERVAL_MS = 35_000;

/** Network timeout (ms) per flow-tiles fetch — same budget the GTFS-RT
 * feeds use; a healthy proxy responds well inside it. */
const FETCH_TIMEOUT_MS = 8_000;

/** Maximum phantom vehicles rendered at once. Real segments in a busy city
 * viewport can exceed 5k polylines; 350 is well below the noise floor and
 * matches the visibility budget for a "traffic shows motion" overlay. */
const MAX_PHANTOM_VEHICLES = 350;

/** Stride through the segment list when picking which segments get a
 * vehicle. Larger stride → sparser fleet; 1 = one per segment. */
const SEGMENT_STRIDE = 6;

/** Phantom speed table (m/s) by TomTom `road_type`. Tuning these against
 * real-world free-flow means a clear highway actually moves fast and a
 * residential street moves slow. trafficLevel is multiplicative on top.
 *
 * @type {{[roadType: string]: number}}
 */
const FREE_FLOW_SPEED_MPS = Object.freeze({
  'motorway':      30.5,   // ~110 km/h
  'trunk':         22.0,   // ~80 km/h
  'primary':       16.5,   // ~60 km/h
  'secondary':     13.0,
  'tertiary':      10.0,
  'residential':    8.0,
  'service':        6.0,
});

/** Default speed when road_type is missing or unrecognized (m/s). */
const UNKNOWN_ROAD_SPEED_MPS = 11.0;

/** When TomTom reports `trafficLevel === 1` we drive at the free-flow
 * speed. At `trafficLevel === 0` (jam) we crawl. Below 0.05 the level is
 * clamped to a 0.05 minimum so a phantom never fully stalls in place —
 * motionless glyphs render as confusing dots, not traffic. */
const MIN_TRAFFIC_LEVEL = 0.05;

/** Vertical offset (m) above ground for phantoms. Above the road surface so
 * terrain never occludes them at oblique camera angles. */
const PHANTOM_HEIGHT_OFFSET_M = 5.0;

/** Detection cohort cap for HUD overlay. */
const MAX_DETECTABLE_OBJECTS = 240;

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

/** @type {Cesium.Viewer|null} */
let _viewer = null;
/** @type {Cesium.PointPrimitiveCollection|null} */
let _pointCollection = null;
/** @type {Map<string, Cesium.PointPrimitive>} Active phantoms keyed by composite id. */
let _phantoms = new Map();
/** @type {boolean} */
let _enabled = false;
/** @type {boolean} */
let _altitudeGateOpen = false;
/** @type {number|null} */
let _lastUpdate = null;
/** @type {string|null} */
let _lastError = null;
/** @type {number} */
let _loadingOps = 0;
/** @type {Set<AbortController>} */
const _inflight = new Set();
/** @type {boolean} */
let _limitWarned = false;
/** @type {boolean} */
let _tomTomCreditRegistered = false;
/** @type {number} Monotonic counter, bumped on every flow refresh. Used in
 * render keys so a phantom from generation N never collides with one from N+1. */
let _generation = 0;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Build the composite render key for a phantom. Namespaces by `${segmentIdx}`,
 * `${vehicleIdx}`, and a generation counter so reloading the segment list
 * doesn't leak old phantoms into the new frame.
 * @param {number} segmentIdx - Index into the segments array.
 * @param {number} vehicleIdx - Which phantom on this segment (0..n).
 * @param {number} generation - Bumped on every refresh.
 * @returns {string} Render key.
 */
function renderKey(segmentIdx, vehicleIdx, generation) {
  return `synth/${segmentIdx}/${vehicleIdx}/${generation}`;
}

/**
 * Resolve a free-flow speed for a TomTom road_type string. Falls back to
 * UNKNOWN_ROAD_SPEED_MPS for missing/unknown types. The lookup is
 * case-insensitive — TomTom's `road_type` is usually lowercase but the
 * schema doesn't guarantee that.
 * @param {string} roadType - TomTom's `road_type` property.
 * @returns {number} Free-flow speed in m/s.
 */
function freeFlowSpeed(roadType) {
  if (typeof roadType !== 'string') return UNKNOWN_ROAD_SPEED_MPS;
  const speed = FREE_FLOW_SPEED_MPS[roadType.toLowerCase()];
  return Number.isFinite(speed) ? speed : UNKNOWN_ROAD_SPEED_MPS;
}

/**
 * Precompute a polyline's cumulative-length table. Built ONCE per phantom
 * (at spawn); the per-frame sampler is then a binary search + degree-space
 * lerp with zero allocations beyond the returned Cartesian3 — never a
 * per-vertex `EllipsoidGeodesic` construction (that ran iterative geodesic
 * math per phantom per frame in the original design).
 *
 * Metric: equirectangular scaling (111.32 km/deg lat, cos-lat-scaled lon).
 * City-scale error vs. true geodesic is <0.5% — irrelevant for pacing an
 * animated glyph, and it keeps the build pass free of trig iteration.
 * Non-finite vertices contribute zero length; the sampler skips them.
 *
 * @param {Array<[number, number]>} coords - Polyline in [lon, lat] degrees.
 * @returns {{coords: Array<[number, number]>, cum: Float64Array, total: number}|null}
 *   Cached polyline (cum[i] = metres from coords[0] to coords[i]), or null
 *   when the polyline is unusable (fewer than 2 finite endpoints or ~zero length).
 */
function buildPolylineCache(coords) {
  if (!Array.isArray(coords) || coords.length < 2) return null;
  const n = coords.length;
  const cum = new Float64Array(n);
  const metricLat = 111_320;
  for (let i = 1; i < n; i++) {
    const [lon1, lat1] = coords[i - 1];
    const [lon2, lat2] = coords[i];
    if (!Number.isFinite(lon1) || !Number.isFinite(lat1)
        || !Number.isFinite(lon2) || !Number.isFinite(lat2)) {
      cum[i] = cum[i - 1];
      continue;
    }
    const midLatRad = ((lat1 + lat2) / 2) * (Math.PI / 180);
    const dLat = (lat2 - lat1) * metricLat;
    const dLon = (lon2 - lon1) * metricLat * Math.cos(midLatRad);
    cum[i] = cum[i - 1] + Math.hypot(dLat, dLon);
  }
  const total = cum[n - 1];
  if (!(total > 1)) return null;
  return { coords, cum, total };
}

/**
 * Sample a world-space position at fraction t ∈ [0,1) along a cached
 * polyline. Binary-searches the cumulative table, then lerps in degree
 * space (TomTom breaks segments at intersections, so straight-line
 * interpolation within one vertex span matches the road).
 * @param {{coords: Array<[number, number]>, cum: Float64Array, total: number}} cache
 *   - Table from `buildPolylineCache()`.
 * @param {number} t - Fraction along the polyline, wrapped to [0,1).
 * @param {number} heightOffsetMetres - Vertical offset (m).
 * @returns {Cesium.Cartesian3|null} World-space position, or null when the cache is unusable.
 */
function sampleAlongCache(cache, t, heightOffsetMetres) {
  if (!cache || !(cache.total > 0)) return null;
  const { coords, cum, total } = cache;
  const wrapped = ((t % 1) + 1) % 1;
  const target = wrapped * total;
  // Binary search: find lo such that cum[lo] <= target <= cum[lo + 1].
  let lo = 0;
  let hi = cum.length - 1;
  while (lo + 1 < hi) {
    const mid = (lo + hi) >> 1;
    if (cum[mid] <= target) lo = mid; else hi = mid;
  }
  const span = cum[hi] - cum[lo];
  const t0 = span > 0 ? (target - cum[lo]) / span : 0;
  const a = coords[lo];
  const b = coords[hi];
  return Cesium.Cartesian3.fromDegrees(
    a[0] + (b[0] - a[0]) * t0,
    a[1] + (b[1] - a[1]) * t0,
    heightOffsetMetres,
  );
}

/**
 * Build a fresh phantom for one segment. Returns null when the segment is
 * unusable or the cap is hit.
 * @param {{coords: number[][], trafficLevel: number, roadType: string, closure: boolean}} segment
 *   - TomTom flow segment decoded by `decodeFlowTile()`.
 * @param {number} segmentIdx - Index used in render key.
 * @param {number} vehicleIdx - Index of this phantom on this segment.
 * @param {number} generation - Refresh generation.
 * @returns {Cesium.PointPrimitive|null} Rendered phantom, or null when the
 *   segment is unusable or the cap is hit.
 */
function buildPhantom(segment, segmentIdx, vehicleIdx, generation) {
  if (!_pointCollection) return null;
  if (_phantoms.size >= MAX_PHANTOM_VEHICLES) {
    if (!_limitWarned) {
      _limitWarned = true;
      console.warn(`[Data:SyntheticTraffic] phantom cap reached (${MAX_PHANTOM_VEHICLES})`);
    }
    return null;
  }
  if (segment.closure) return null; // closed roads surface as segments, not moving glyphs

  // One-time cost: cumulative-length table for this segment. Reused by the
  // position callback every frame without rebuilding anything.
  const cache = buildPolylineCache(segment.coords);
  if (!cache) return null;

  const speed = freeFlowSpeed(segment.roadType) * Math.max(MIN_TRAFFIC_LEVEL, segment.trafficLevel);
  const phase = (vehicleIdx / 3) % 1; // stagger 0, 1/3, 2/3 along the path
  const startTime = performance.now() / 1000;
  const direction = vehicleIdx % 2 === 0 ? 1 : -1; // alternate

  const positionCallback = new Cesium.CallbackProperty(() => {
    const elapsed = performance.now() / 1000 - startTime;
    const distance = direction * speed * elapsed;
    const t = (phase + distance / cache.total) % 1;
    return sampleAlongCache(cache, t, PHANTOM_HEIGHT_OFFSET_M);
  }, false);

  const point = _pointCollection.add({
    position: positionCallback,
    color: synthColor(segment.trafficLevel),
    pixelSize: 6,
    outlineColor: Cesium.Color.BLACK.withAlpha(0.35),
    outlineWidth: 1,
    scaleByDistance: new Cesium.NearFarScalar(1200, 1.4, 250_000, 0.4),
    translucencyByDistance: new Cesium.NearFarScalar(1200, 1.0, 350_000, 0.2),
    id: { source: 'synthetic-traffic', segmentIdx, vehicleIdx, generation },
  });
  _phantoms.set(renderKey(segmentIdx, vehicleIdx, generation), point);
  return point;
}

/**
 * Phantoms to spawn on one segment. Longer roads carry more vehicles — a
 * 1.2 km segment gets 3, a short block gets 1 — so the stagger offsets in
 * `buildPhantom` are actually reachable (the original `1 + (i % 3)` formula
 * only ever produced 1 because the stride guaranteed `i % 3 === 0`).
 * @param {number} segmentLengthM - Segment length in metres (> 0).
 * @returns {number} Phantom count for this segment, 1..3.
 */
function phantomsForSegment(segmentLengthM) {
  return Math.min(3, Math.max(1, Math.round(segmentLengthM / 400)));
}

/**
 * Pick a translucent primary colour from traffic level:
 *  level ≤ 0.3 (jam)     → red
 *  0.3 < level ≤ 0.7      → amber
 *  level > 0.7 (free)    → green
 * Closes (which we render as no-glyph) reach this only with `trafficLevel`
 * already 0 from the upstream decoder.
 * @param {number} trafficLevel - TomTom ratio (0..1).
 * @returns {Cesium.Color} Point colour.
 */
function synthColor(trafficLevel) {
  if (trafficLevel <= 0.3) return Cesium.Color.fromCssColorString('#ff5a55'); // jam red
  if (trafficLevel <= 0.7) return Cesium.Color.fromCssColorString('#f5b94a'); // amber
  return Cesium.Color.fromCssColorString('#5fd06a'); // free flow green
}

/**
 * Strip phantoms whose key was not seen in this refresh. Cheap O(n)
 * iteration; the map tops out at MAX_PHANTOM_VEHICLES entries.
 * @param {Set<string>} liveKeys - Render keys touched in this refresh.
 */
function pruneStale(liveKeys) {
  for (const key of _phantoms.keys()) {
    if (!liveKeys.has(key)) {
      const point = _phantoms.get(key);
      if (point && _pointCollection) _pointCollection.remove(point);
      _phantoms.delete(key);
    }
  }
}

/**
 * Camera-altitude hysteresis: enter below ACTIVATION_ENTER_ALTITUDE_M, exit
 * above ACTIVATION_EXIT_ALTITUDE_M. Matches the transitVehicles pattern so
 * both vehicle layers flip on/off at the same altitude band.
 * @param {number} altitude - Camera height in metres.
 * @returns {boolean} True when the layer should be active.
 */
function shouldActivateAtAltitude(altitude) {
  if (!Number.isFinite(altitude)) return false;
  if (_altitudeGateOpen) {
    if (altitude >= ACTIVATION_EXIT_ALTITUDE_M) _altitudeGateOpen = false;
  } else if (altitude <= ACTIVATION_ENTER_ALTITUDE_M) {
    _altitudeGateOpen = true;
  }
  return _altitudeGateOpen;
}

/**
 * Compute the camera's lon/lat viewport rectangle. We use Cesium's
 * camera.computeViewRectangle() when available; it returns the on-globe
 * rectangle in radians covering the visible screen. We convert to degrees
 * and clamp to valid lat/lon so a tilted globe at extreme orientations
 * doesn't return a degenerate box. Returns null when the view is above the
 * atmosphere (computeViewRectangle returns undefined).
 * @param {Cesium.Viewer} viewer - Init'd Cesium viewer.
 * @returns {{south: number, west: number, north: number, east: number}|null} Degrees rect, or null.
 */
function lngLatBoundsForViewport(viewer) {
  if (!viewer) return null;
  const camera = viewer.camera;
  if (typeof camera.computeViewRectangle !== 'function') return null;
  const rect = camera.computeViewRectangle();
  if (!rect) return null;
  let south = Cesium.Math.toDegrees(rect.south);
  let north = Cesium.Math.toDegrees(rect.north);
  const west = Cesium.Math.toDegrees(rect.west);
  const east = Cesium.Math.toDegrees(rect.east);
  // Clamp lat into [-85, 85] — TomTom flow tiles don't extend to the
  // poles, and a near-polar camera gives a 360°-wide rectangle that's
  // useless for our purposes anyway.
  south = Math.max(-85, Math.min(85, south));
  north = Math.max(-85, Math.min(85, north));
  // For a globe-spanning view, west > east after conversion; clamp both
  // to keep the rect finite (the bbox predicate treats west>=east as
  // unusable, which is fine — a globe-spanning view is too zoomed-out
  // to be inside our altitude gate anyway).
  if (!Number.isFinite(west) || !Number.isFinite(east)) return null;
  return { south, west, north, east };
}

/**
 * Rebuild the phantom fleet from a decoded segment list. The OLD fleet is
 * removed FIRST: render keys are generation-scoped, so nothing from the
 * previous refresh is reusable, and the `MAX_PHANTOM_VEHICLES` cap in
 * `buildPhantom` counts `_phantoms.size` — building before pruning would
 * count stale entries against the cap and reject every new phantom
 * (populated/blank oscillation, caught by audit 2026-09-18). Removal and
 * re-add land in the same JS turn, so Cesium composites them in one frame
 * with no visible flicker.
 * @param {Array<{coords: number[][], trafficLevel: number, roadType: string, closure: boolean}>} segments
 *   - Segments from `fetchFlowForBounds()`.
 * @returns {number} Phantoms live after the rebuild.
 */
function rebuildPhantoms(segments) {
  pruneStale(new Set()); // keys are generation-scoped ⇒ this drops the whole old fleet
  _generation += 1;
  const generation = _generation;
  let phantomCount = 0;
  for (let i = 0; i < segments.length; i += SEGMENT_STRIDE) {
    if (phantomCount >= MAX_PHANTOM_VEHICLES) break;
    const seg = segments[i];
    if (!seg || seg.closure) continue;
    const cache = buildPolylineCache(seg.coords);
    if (!cache) continue;
    const phantomsOnThisSegment = phantomsForSegment(cache.total);
    for (let k = 0; k < phantomsOnThisSegment; k++) {
      if (phantomCount >= MAX_PHANTOM_VEHICLES) break;
      if (buildPhantom(seg, i, k, generation)) phantomCount++;
    }
  }
  return phantomCount;
}

/**
 * One poll cycle for the visible viewport. If any registered GTFS-RT feed
 * covers the visible rect, the call short-circuits — a real feed presumably
 * wins there. Errors are surfaced via `_lastError`, not thrown (a transient
 * TomTom outage must not break the layer module).
 * @returns {Promise<void>}
 */
async function pollViewport() {
  if (!_viewer) return;
  const rect = lngLatBoundsForViewport(_viewer);
  if (!rect) {
    pruneStale(new Set());
    return;
  }
  if (gtfsRtAnyFeedCoversRect(rect)) {
    // Real feed owns this viewport — drop any synthetics we previously
    // showed here. (transitVehicles is responsible for showing real buses.)
    pruneStale(new Set());
    return;
  }
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  _inflight.add(controller);
  _loadingOps++;
  try {
    const segments = await fetchFlowForBounds(rect, { signal: controller.signal });
    if (!_enabled) return;
    rebuildPhantoms(segments);
    _lastUpdate = Date.now();
    governorRequestRender('synthetic-traffic-update');
  } catch (error) {
    if (error?.name !== 'AbortError') {
      _lastError = error?.message || String(error);
      console.warn('[Data:SyntheticTraffic] poll failed:', _lastError);
    }
  } finally {
    clearTimeout(timeoutId);
    _inflight.delete(controller);
    _loadingOps = Math.max(0, _loadingOps - 1);
  }
}

// ---------------------------------------------------------------------------
// Layer module
// ---------------------------------------------------------------------------

const syntheticTrafficLayer = {
  id: 'synthetic-traffic',
  name: 'Synthetic Traffic',
  icon: '🚗',
  source: 'TomTom Flow (synthetic)',
  updateInterval: POLL_INTERVAL_MS,

  init(viewer) {
    _viewer = viewer;
    _pointCollection = new Cesium.PointPrimitiveCollection({
      blendOption: Cesium.BlendOption.TRANSLUCENT,
    });
    viewer.scene.primitives.add(_pointCollection);
    registerSpriteCollection('synthetic-traffic', _pointCollection);
    _pointCollection.show = false;
    restoreSpriteOrder(viewer);
  },

  enable(viewer) {
    // Convention matches transitVehicles / bikeshare: init() captures the
    // viewer in the module-level `_viewer`; this method re-uses that
    // closure variable instead of trusting the caller's viewer reference.
    _enabled = true;
    _lastError = null;
    _altitudeGateOpen = false;
    _limitWarned = false;
    _pointCollection.show = true;
    if (viewer && viewer !== _viewer) _viewer = viewer;
    _tomTomCreditRegistered = registerDynamicCredit(_viewer, TOMTOM_CREDIT) || _tomTomCreditRegistered;
    governorRequestRender('synthetic-traffic-enable');
    void this.update();
  },

  disable(_viewer) {
    _enabled = false;
    for (const controller of _inflight) {
      try { controller.abort(); } catch { /* no-op */ }
    }
    _inflight.clear();
    _altitudeGateOpen = false;
    if (_pointCollection) {
      _pointCollection.show = false;
      _pointCollection.removeAll();
    }
    _phantoms.clear();
    _loadingOps = 0;
  },

  async update() {
    if (!_enabled || !_viewer) return;
    const altitude = _viewer.camera?.positionCartographic?.height;
    if (!shouldActivateAtAltitude(altitude)) {
      if (_phantoms.size > 0) {
        if (_pointCollection) _pointCollection.removeAll();
        _phantoms.clear();
      }
      return;
    }
    await pollViewport();
  },

  destroy(viewer) {
    if (_enabled) this.disable(viewer);
    if (_pointCollection) {
      try { viewer.scene.primitives.remove(_pointCollection); } catch { /* no-op */ }
      _pointCollection = null;
    }
    _viewer = null;
    _phantoms = new Map();
  },

  /**
   * Deterministic stride-sampled cohort for the HUD detection overlay.
   * Mirrors the bikeshare/transitVehicles contract.
   * @param {object} [options] - Sampling controls.
   * @param {number} [options.maxCount] - Cohort cap.
   * @param {number} [options.seed] - Stride offset.
   * @returns {Array<{position: Cesium.Cartesian3, id: string, type: string, skipLabel: boolean, sourceId: string}>}
   *   HUD-detectable vehicles (or empty when the layer is disabled).
   */
  getDetectableObjects(options = {}) {
    if (!_enabled || !_pointCollection || _phantoms.size === 0) return [];
    const records = [];
    for (const [key, point] of _phantoms) {
      if (!point?.show) continue;
      records.push({ key, point });
    }
    if (records.length === 0) return [];

    const maxCount = Number.isFinite(options.maxCount)
      ? Math.max(1, Math.floor(options.maxCount))
      : records.length;
    const seed = Number.isFinite(options.seed) ? Math.floor(options.seed) : 0;
    const stride = Math.max(1, Math.ceil(records.length / Math.min(maxCount, MAX_DETECTABLE_OBJECTS)));
    const start = ((seed % stride) + stride) % stride;
    const result = [];
    for (let i = start; i < records.length; i += stride) {
      const r = records[i];
      result.push({
        position: r.point.position,
        sourceId: r.key,
        id: `🚗 ${r.key}`,
        type: 'VEH',
        skipLabel: false,
      });
      if (result.length >= maxCount) break;
    }
    return result;
  },

  /**
   * Diagnostics for `getStats()` consumers (layer manager).
   * @returns {{count: number, lastUpdate: number|null, loading: boolean,
   *   loadingLabel?: string, error?: string, tilesFetched: number, totalCapacity: number,
   *   suppressedByRealFeed: boolean, altitudeBand: string}}
   *   Snapshot of the layer's current state for the layer manager.
   */
  getStats() {
    const flowStats = getFlowSessionStats();
    const altitude = _viewer?.camera?.positionCartographic?.height;
    const rect = _viewer ? lngLatBoundsForViewport(_viewer) : null;
    const suppressed = rect ? gtfsRtAnyFeedCoversRect(rect) : false;
    const stats = {
      count: _phantoms.size,
      lastUpdate: _lastUpdate,
      loading: _loadingOps > 0,
      tilesFetched: flowStats.tilesFetched,
      totalCapacity: MAX_PHANTOM_VEHICLES,
      suppressedByRealFeed: suppressed,
      altitudeBand: Number.isFinite(altitude)
        ? `${Math.round(altitude / 1000)} km`
        : 'unknown',
    };
    if (_loadingOps > 0) stats.loadingLabel = 'reading flow tiles…';
    if (_lastError) stats.error = _lastError;
    return stats;
  },
};

/**
 * Test seam: plan the phantom rebuild for a segment array WITHOUT touching
 * Cesium's globe or the live network. Mirrors `rebuildPhantoms`' picking
 * (stride, closure skip, length-driven 1–3 count, cap) so tests can pin the
 * planner without a viewer.
 *
 * @param {Array<{coords: number[][], trafficLevel: number, roadType: string, closure: boolean}>} segments
 *   - Same shape as `decodeFlowTile()` output.
 * @returns {{
 *   totalSegments: number,
 *   eligibleSegments: number,
 *   phantomBudget: number,
 *   spawnablePhantoms: number,
 *   freeFlowSpeedMpsByType: { [roadType: string]: number }
 * }}
 *   Plan describing the layer's phantom budget and per-segment picks.
 */
export function _planPhantomsForTest(segments) {
  const totalSegments = segments.length;
  let eligibleSegments = 0;
  let spawnablePhantoms = 0;
  for (let i = 0; i < segments.length; i += SEGMENT_STRIDE) {
    const seg = segments[i];
    if (!seg || seg.closure) continue;
    const cache = buildPolylineCache(seg.coords);
    if (!cache) continue;
    eligibleSegments++;
    const desired = phantomsForSegment(cache.total);
    const actual = Math.min(desired, MAX_PHANTOM_VEHICLES - spawnablePhantoms);
    if (actual <= 0) break;
    spawnablePhantoms += actual;
  }
  const freeFlowSpeedMpsByType = {};
  for (const [k, v] of Object.entries(FREE_FLOW_SPEED_MPS)) {
    freeFlowSpeedMpsByType[k] = v;
  }
  return {
    totalSegments,
    eligibleSegments,
    phantomBudget: MAX_PHANTOM_VEHICLES,
    spawnablePhantoms,
    freeFlowSpeedMpsByType,
  };
}

/**
 * Test seam: pure helper, isolated from rendering. Samples a position on a
 * polyline at fraction t ∈ [0,1) through the SAME cache path the per-frame
 * callback uses, and returns [lon, lat] in degrees for easy assertion.
 * @param {Array<[number, number]>} coords - Polyline in [lon, lat] degrees.
 * @param {number} t - Fraction along the polyline.
 * @returns {[number, number]|null} [lon, lat] at the sample, or null when
 *   the polyline is unusable.
 */
export function _sampleAlongPolylineForTest(coords, t) {
  const cache = buildPolylineCache(coords);
  const cart = sampleAlongCache(cache, t, 0);
  if (!cart) return null;
  const carto = Cesium.Cartographic.fromCartesian(cart);
  return [
    Cesium.Math.toDegrees(carto.longitude),
    Cesium.Math.toDegrees(carto.latitude),
  ];
}

/**
 * Test seam: run the REAL rebuild lifecycle (prune-old-first → build with
 * cap accounting → generation bump) against a real
 * `Cesium.PointPrimitiveCollection` — no viewer or network required. This
 * is the path the populate/blank oscillation bug lived in, so the
 * consecutive-refresh assertions in the unit suite run exactly what
 * production runs.
 *
 * The layer must be init()'d with a stand-in viewer first (the collection
 * must exist). Returns the live count after this refresh.
 * @param {Array<{coords: number[][], trafficLevel: number, roadType: string, closure: boolean}>} segments
 *   - Segments as `fetchFlowForBounds()` would return.
 * @returns {number} Phantom count after the rebuild.
 */
export function _rebuildPhantomsForTest(segments) {
  return rebuildPhantoms(segments);
}

/**
 * Test seam: drop every phantom and reset generation state between test
 * cases (mirrors the disable() teardown without requiring a viewer).
 * @returns {void}
 */
export function _resetPhantomsForTest() {
  if (_pointCollection) _pointCollection.removeAll();
  _phantoms.clear();
  _generation = 0;
  _limitWarned = false;
}

/** Test seam: layer constant surface for the coverage tools. */
export const SYNTHETIC_TRAFFIC_RENDER_BOUNDS = Object.freeze({
  maxPhantomVehicles: MAX_PHANTOM_VEHICLES,
  segmentStride: SEGMENT_STRIDE,
  heightOffsetM: PHANTOM_HEIGHT_OFFSET_M,
});

/**
 * Test seam: exposes the bbox predicate behaviour at the import boundary so
 * tests can reason about viewport-suppression without a viewer.
 * @param {{south: number, west: number, north: number, east: number}|null} rect - Target rectangle, degrees.
 * @returns {boolean} True iff at least one registered GTFS-RT feed covers the rect.
 */
export function _gtfsRtAnyFeedCoversRectForTest(rect) {
  return gtfsRtAnyFeedCoversRect(rect);
}

export default syntheticTrafficLayer;
