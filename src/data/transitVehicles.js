/**
 * @module transitVehicles
 * @description GTFS-Realtime transit vehicle overlay.
 *
 * Polls keyless GTFS-RT VehiclePositions.pb feeds (MBTA, OVapi, MetroMN)
 * through the `/api/gtfsrt/<feedId>` proxy, decodes the protobuf with the
 * hand-rolled `gtfsRtDecode.js`, and renders each vehicle as a
 * route-coloured point primitive on the Cesium globe.
 *
 * Layer contract (the same one `bikeshare` and `earthquakes` use):
 *   init(viewer)         — wire up the point collection + state
 *   enable(viewer)       — start polling, attach camera gate
 *   disable(viewer)      — stop polling, hide points
 *   async update()       — one poll cycle (also fired by layer manager tick)
 *   destroy(viewer)      — release primitives + listeners
 *   getDetectableObjects — for HUD detection overlay
 *   getStats()           — { count, lastUpdate, loading, error }
 *
 * Camera gating: the layer is hidden when the camera rises above
 * ACTIVATION_EXIT_ALTITUDE_M (cities are unreadable from space); an
 * enter/exit hysteresis pair prevents flicker at the boundary.
 *
 * Per-feed rendering: each vehicle gets a stable colour derived from its
 * route id (hash → HSL). Heavy-rail lines (MBTA Red, OVapi metro) and bus
 * routes share one palette, with a width bump for rail.
 */

import * as Cesium from 'cesium';
import { api } from '../config/apiEndpoints.js';
import { GTFS_RT_FEED_IDS } from './gtfsRtPolicy.js';
import { decodeGtfsRtFeed } from './gtfsRtDecode.js';
import { governorRequestRender } from '../renderGovernor.js';
import { registerSpriteCollection, restoreSpriteOrder } from './spriteOrder.js';

// ---------------------------------------------------------------------------
// Tuning constants
// ---------------------------------------------------------------------------

/** Camera altitude (m) at which the layer becomes eligible. Hysteresis enter
 * is the low threshold; exit is the high one (so the layer hides once you
 * climb past it and re-shows only when you descend again). */
const ACTIVATION_ENTER_ALTITUDE_M = 80_000;
const ACTIVATION_EXIT_ALTITUDE_M = 100_000;

/** Minimum interval (ms) between polls — the manager tick is finer; this
 * caps work per camera pose. */
const POLL_INTERVAL_MS = 25_000;

/** Network timeout (ms) per feed request. */
const FEED_FETCH_TIMEOUT_MS = 8_000;

/** Maximum vehicles rendered total across all feeds. Hard cap so a future
 * feed addition can't silently blow the GPU budget. */
const MAX_TOTAL_VEHICLES = 5000;

/** Vertical offset (m) above ellipsoid for vehicle primitives. */
const VEHICLE_HEIGHT_OFFSET_M = 4.0;

/** Hex colours for visual styling. */
const POINT_OUTLINE = Cesium.Color.BLACK.withAlpha(0.4);
const POINT_OUTLINE_WIDTH = 1;
const POINT_PIXEL_SIZE = 7;
const POINT_SCALE_NEAR = 1.4;
const POINT_SCALE_FAR = 0.35;
const POINT_TRANSLUCENCY_NEAR = 1.0;
const POINT_TRANSLUCENCY_FAR = 0.18;

/** Detectability: HUD overlay cohort. */
const MAX_DETECTABLE_OBJECTS = 240;

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

/** @type {Cesium.Viewer|null} */
let _viewer = null;
/** @type {Cesium.PointPrimitiveCollection|null} */
let _pointCollection = null;
/** @type {Map<string, Cesium.PointPrimitive>} */
let _points = new Map();
/** @type {boolean} */
let _enabled = false;
/** @type {boolean} */
let _altitudeGateOpen = false;
/** @type {Set<AbortController>} In-flight fetch controllers. Cleared on disable/destroy. */
const _inflight = new Set();
/** @type {string|null} */
let _lastError = null;
/** @type {number|null} */
let _lastUpdate = null;
/** @type {number} */
let _loadingOps = 0;
/** @type {boolean} */
let _limitWarned = false;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Build the composite render key: `<feedId>/<vehicleId>`.
 * Feed id is namespaced so a vehicle id collision across feeds (e.g. MBTA
 * `R-123` and a hypothetical future MBTA-2 feed also using `R-123`) can't
 * shadow each other in the render map.
 * @param {string} feedId - Feed id (the registry key, namespaced).
 * @param {string} vehicleId - Vehicle id from the upstream entity.
 * @returns {string} Composite `<feedId>/<vehicleId>` render key.
 */
function renderKey(feedId, vehicleId) {
  return `${feedId}/${vehicleId}`;
}

/**
 * Stable per-route colour from a route id string. Hashes the route id into
 * the HSL hue wheel; saturation and lightness are fixed so colours stay
 * readable against the photoreal globe.
 * @param {string|null} routeId - Route id (or null when the feed omits it).
 * @returns {Cesium.Color} Pre-built RGBA colour for the route.
 */
function routeColor(routeId) {
  const id = String(routeId || '');
  let hash = 0;
  for (let i = 0; i < id.length; i++) {
    hash = ((hash << 5) - hash) + id.codePointAt(i);
    hash = Math.trunc(hash);
  }
  const hue = ((hash % 360) + 360) % 360;
  return Cesium.Color.fromHsl(hue / 360, 0.72, 0.55, 0.95);
}

/**
 * Render a vehicle as a small colour-coded point. The route colour is the
 * only signal we have for "what kind of vehicle is this?" without a second
 * feed, so it carries the visual weight; rail vs bus isn't distinguished
 * yet (a future enhancement: lookup `route_type` from the GTFS static feed).
 * @param {object} vehicle - Decoded VehiclePosition.
 * @param {{feedId: string, vehicleId: string}} key - Composite render key.
 */
function renderVehicle(vehicle, { feedId, vehicleId }) {
  if (!_pointCollection || !_viewer) return;
  const pos = vehicle.position;
  if (!pos || !Number.isFinite(pos.latitude) || !Number.isFinite(pos.longitude)) return;

  const cart = Cesium.Cartesian3.fromDegrees(
    pos.longitude,
    pos.latitude,
    VEHICLE_HEIGHT_OFFSET_M,
  );
  const key = renderKey(feedId, vehicleId);

  let point = _points.get(key);
  if (!point) {
    if (_points.size >= MAX_TOTAL_VEHICLES) {
      if (!_limitWarned) {
        _limitWarned = true;
        console.warn(`[Data:TransitVehicles] point cap reached (${MAX_TOTAL_VEHICLES})`);
      }
      return;
    }
    point = _pointCollection.add({
      position: cart,
      color: routeColor(vehicle.trip?.routeId),
      outlineColor: POINT_OUTLINE,
      outlineWidth: POINT_OUTLINE_WIDTH,
      pixelSize: POINT_PIXEL_SIZE,
      scaleByDistance: new Cesium.NearFarScalar(1500, POINT_SCALE_NEAR, 250_000, POINT_SCALE_FAR),
      translucencyByDistance: new Cesium.NearFarScalar(1500, POINT_TRANSLUCENCY_NEAR, 350_000, POINT_TRANSLUCENCY_FAR),
      id: { source: 'transit-vehicles', feedId, vehicleId },
    });
    _points.set(key, point);
  } else {
    point.position = cart;
    point.color = routeColor(vehicle.trip?.routeId);
  }
}

/**
 * Remove rendered primitives whose vehicle id is no longer in the latest
 * per-feed snapshot. We sweep instead of rebuilding every cycle because
 * GTFS-RT vehicle ids are stable for the lifetime of the trip.
 * @param {Set<string>} liveKeys - Render keys present in the just-decoded snapshot.
 */
function pruneStaleVehicles(liveKeys) {
  for (const key of _points.keys()) {
    if (!liveKeys.has(key)) {
      const point = _points.get(key);
      if (point && _pointCollection) _pointCollection.remove(point);
      _points.delete(key);
    }
  }
}

/**
 * Decide whether the layer should be active at a given camera altitude.
 * Hysteresis: enter below ACTIVATION_ENTER_ALTITUDE_M, exit above
 * ACTIVATION_EXIT_ALTITUDE_M. Prevents thrashing at the boundary.
 * @param {number} altitude - Camera altitude in metres.
 * @returns {boolean} True when the camera is in the layer's altitude band.
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
 * Fetch + decode one feed. Errors are swallowed (the layer should not throw
 * on a single upstream blip); they surface via `_lastError` and `getStats()`.
 * @param {string} feedId - One of GTFS_RT_FEED_IDS.
 * @returns {Promise<{feedId: string, vehicleIds: Set<string>}>} Per-feed render summary.
 */
async function pollFeed(feedId) {
  _loadingOps++;
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), FEED_FETCH_TIMEOUT_MS);
  _inflight.add(controller);
  try {
    const response = await fetch(api.gtfsRt(feedId), {
      method: 'GET',
      headers: { Accept: 'application/x-protobuf' },
      signal: controller.signal,
    });
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }
    const arrayBuffer = await response.arrayBuffer();
    const feed = decodeGtfsRtFeed(new Uint8Array(arrayBuffer));

    const liveKeys = new Set();
    for (const entity of feed.entities) {
      const vehicle = entity.vehicle;
      if (!vehicle?.position || vehicle.position.latitude == null || vehicle.position.longitude == null) continue;
      const vid = entity.id || `${vehicle.position.latitude},${vehicle.position.longitude}`;
      const key = renderKey(feedId, vid);
      liveKeys.add(key);
      renderVehicle(vehicle, { feedId, vehicleId: vid });
    }
    pruneStaleVehicles(liveKeys);

    return { feedId, vehicleIds: liveKeys };
  } catch (error) {
    if (error?.name !== 'AbortError') {
      _lastError = `${feedId}: ${error?.message || error}`;
      console.warn(`[Data:TransitVehicles] ${feedId} poll failed:`, error?.message || error);
    }
    return { feedId, vehicleIds: new Set() };
  } finally {
    clearTimeout(timeoutId);
    _inflight.delete(controller);
    _loadingOps = Math.max(0, _loadingOps - 1);
  }
}

// ---------------------------------------------------------------------------
// Layer module
// ---------------------------------------------------------------------------

const transitVehiclesLayer = {
  id: 'transit-vehicles',
  name: 'Transit',
  icon: '🚆',
  source: 'GTFS-RT',
  updateInterval: POLL_INTERVAL_MS,

  init(viewer) {
    _viewer = viewer;
    _pointCollection = new Cesium.PointPrimitiveCollection({
      blendOption: Cesium.BlendOption.TRANSLUCENT,
    });
    viewer.scene.primitives.add(_pointCollection);
    registerSpriteCollection('transit-vehicles', _pointCollection);
    _pointCollection.show = false;
    restoreSpriteOrder(viewer);
  },

  enable(_viewer) {
    _enabled = true;
    _lastError = null;
    _altitudeGateOpen = false;
    _pointCollection.show = true;
    governorRequestRender('transit-vehicles-enable');
    void this.update();
  },

  disable(_viewer) {
    _enabled = false;
    for (const controller of _inflight) {
      try { controller.abort(); } catch { /* no-op */ }
    }
    _inflight.clear();
    _altitudeGateOpen = false;
    if (_pointCollection) _pointCollection.show = false;
    _points.clear();
    _loadingOps = 0;
  },

  async update() {
    if (!_enabled || !_viewer) return;
    const altitude = _viewer.camera?.positionCartographic?.height;
    if (!shouldActivateAtAltitude(altitude)) {
      _points.clear();
      if (_pointCollection) {
        // removeAll is the canonical way to clear a PointPrimitiveCollection
        _pointCollection.removeAll();
      }
      return;
    }

    governorRequestRender('transit-vehicles-update');
    const results = await Promise.all(GTFS_RT_FEED_IDS.map((feedId) => pollFeed(feedId)));
    if (!_enabled) return;
    if (results.some((r) => r.vehicleIds.size > 0)) {
      _lastUpdate = Date.now();
    }
  },

  destroy(viewer) {
    if (_enabled) this.disable(viewer);
    if (_pointCollection) {
      try { viewer.scene.primitives.remove(_pointCollection); } catch { /* no-op */ }
      _pointCollection = null;
    }
    _viewer = null;
    _points = new Map();
  },

  /**
   * Return a deterministic, stride-sampled subset of rendered vehicles for
   * the HUD detection overlay. Mirrors the bikeshare layer's contract.
   * @param {object} [options] - Sampling controls.
   * @param {number} [options.maxCount] - Cohort size cap.
   * @param {number} [options.seed] - Stride offset for stable sampling.
   * @returns {Array<{position: Cesium.Cartesian3, id: string, type: string, skipLabel: boolean, sourceId: string}>} HUD-detectable vehicles.
   */
  getDetectableObjects(options = {}) {
    if (!_enabled || !_pointCollection || _points.size === 0) return [];
    const records = [];
    for (const [key, point] of _points) {
      if (!point?.show || !point?.position) continue;
      records.push({ key, position: point.position });
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
      result.push({
        position: records[i].position,
        sourceId: records[i].key,
        id: `🚆 ${records[i].key}`,
        type: 'VEH',
        skipLabel: false,
      });
      if (result.length >= maxCount) break;
    }
    return result;
  },

  getStats() {
    const stats = {
      count: _points.size,
      lastUpdate: _lastUpdate,
      loading: _loadingOps > 0,
    };
    if (_loadingOps > 0) stats.loadingLabel = `syncing ${_loadingOps} feed${_loadingOps === 1 ? '' : 's'}…`;
    if (_lastError) stats.error = _lastError;
    return stats;
  },
};

/**
 * Test seam — decode a feed's bytes and return the renderable summary
 * without touching Cesium. Used by unit tests to validate the layer's
 * decode → renderable path against a captured MBTA fixture without spinning
 * up a viewer. Returns:
 *   {
 *     feedId: string,
 *     vehicleCount: number,        // entities with a valid position
 *     sampleKeys: string[],        // first 5 composite render keys
 *     sampleRoutes: string[],      // first 5 route ids encountered
 *   }
 * @param {string} feedId - Feed id (`mbta`, `ovapi`, `metro-mn`).
 * @param {ArrayBuffer|Uint8Array} bytes - Raw protobuf bytes.
 * @returns {{feedId: string, vehicleCount: number, sampleKeys: string[], sampleRoutes: string[]}} Renderable summary.
 */
export function _decodeFeedForTest(feedId, bytes) {
  const feed = decodeGtfsRtFeed(bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes));
  const sampleKeys = [];
  const sampleRoutes = [];
  let vehicleCount = 0;
  for (const entity of feed.entities) {
    const vehicle = entity.vehicle;
    if (!vehicle?.position || vehicle.position.latitude == null || vehicle.position.longitude == null) continue;
    const vid = entity.id || `${vehicle.position.latitude},${vehicle.position.longitude}`;
    vehicleCount++;
    if (sampleKeys.length < 5) sampleKeys.push(renderKey(feedId, vid));
    if (sampleRoutes.length < 5 && vehicle.trip?.routeId) sampleRoutes.push(vehicle.trip.routeId);
  }
  return { feedId, vehicleCount, sampleKeys, sampleRoutes };
}

/**
 * Test seam: route id → Cesium colour, isolated from the render loop.
 * @param {string|null} routeId - Route id (or null/empty for the fallback colour).
 * @returns {Cesium.Color} Stable colour for the route.
 */
export function _routeColorForTest(routeId) {
  return routeColor(routeId);
}

/** Test seam: painted pixel size / scale bounds, exposed so coverage scripts
 * can reason about the layer's footprint without a viewer. */
export const TRANSIT_VEHICLE_RENDER_BOUNDS = Object.freeze({
  maxTotalVehicles: MAX_TOTAL_VEHICLES,
  pixelSize: POINT_PIXEL_SIZE,
  heightOffsetM: VEHICLE_HEIGHT_OFFSET_M,
});

export default transitVehiclesLayer;
