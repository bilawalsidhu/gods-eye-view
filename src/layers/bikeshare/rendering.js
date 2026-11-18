import {
  DEFAULT_CAPACITY,
  POINT_SIZE_MIN,
  POINT_SIZE_MAX,
  COLOR_NEUTRAL,
  COLOR_MUTED,
  COLOR_GREEN,
  COLOR_YELLOW,
  COLOR_RED,
  POINT_HEIGHT_OFFSET_M,
  MAX_TOTAL_POINTS,
  COLOR_OUTLINE,
  POINT_SCALE_BY_DISTANCE,
  POINT_FADE_BY_DISTANCE,
  POINT_DISABLE_DEPTH_TEST_M,
  COVERAGE_PIXEL_SIZE,
  COVERAGE_OUTLINE_WIDTH,
  COVERAGE_HEIGHT_M,
} from './policy.js';
import { GBFS_CITY_REGISTRY } from './registry.js';
import { heightsOf } from '../../queries/heights.js';
import { fromDegrees } from '../../geo/ellipsoid.js';
import { drawOf } from '../../render/rendererOf.js';

/**
 * The draw sets the stations are drawn in start with this; each layer has
 * its own (`bikeshare:1:stations`, `bikeshare:1:selected`), so several can
 * share a renderer. Picks name them as `Hit.set`.
 */
export const BIKESHARE_SET_ID = 'bikeshare';

/** A covered city's marker id: its registry id under this prefix. */
export const COVERAGE_ID_PREFIX = 'city:';
let instances = 0;

export function createRendering({
  state: layerState,
  services,
  parts,
  source,
}) {
  const { governorRequestRender } = services.render;

  /**
   * Make the layer's draw sets on `viewer`'s renderer (`drawOf`): the
   * station dots, hidden until the layer is enabled, and the selected
   * station's highlight. Sets made before are let go first.
   * @param {object} viewer
   */
  function attachSets(viewer) {
    const draw = drawOf(viewer);
    detachSets();
    const prefix = `${BIKESHARE_SET_ID}:${++instances}`;
    layerState._stationSet = draw.points({
      id: `${prefix}:stations`,
      blend: 'translucent',
      show: false,
      drawOrder: services.sprites?.spriteDrawOrder?.('bikeshare') ?? 0,
    });
    layerState._selectedSet = draw.points({ id: `${prefix}:selected` });
    // One marker per covered city, drawn while the camera is too high for
    // stations: the globe shows where bike share is.
    layerState._coverageSet = draw.points({
      id: `${prefix}:coverage`,
      show: false,
      drawOrder: services.sprites?.spriteDrawOrder?.('bikeshare') ?? 0,
    });
    layerState._coverageSet.set(
      GBFS_CITY_REGISTRY.map((city) => ({
        id: `${COVERAGE_ID_PREFIX}${city.id}`,
        pos: fromDegrees(city.centerLon, city.centerLat, COVERAGE_HEIGHT_M),
        pixelSize: COVERAGE_PIXEL_SIZE,
        color: COLOR_GREEN,
        outlineColor: [1, 1, 1, 0.9],
        outlineWidth: COVERAGE_OUTLINE_WIDTH,
      })),
    );
    // Drawn from the start, empty, so both take their place in the scene
    // now, as the layer's collections did; the stations' place among the
    // other sprite layers is their draw order (`spriteDrawOrder`).
    layerState._stationSet.set([]);
    layerState._selectedSet.set([]);
  }

  /** Let the layer's draw sets go. */
  function detachSets() {
    layerState._stationSet?.dispose();
    layerState._selectedSet?.dispose();
    layerState._coverageSet?.dispose();
    layerState._stationSet = null;
    layerState._selectedSet = null;
    layerState._coverageSet = null;
  }

  /**
   * A station's dot, from its render record; the selected station's own dot
   * is hidden while its highlight replaces it.
   * @param {Object} record - Render record from _stationRenderMap.
   * @returns {import('../../render/contract/draw').PointItem}
   */
  function stationItem(record) {
    return {
      id: record.key,
      pos: record.position,
      pixelSize: record.pixelSize,
      color: record.color,
      outlineColor: COLOR_OUTLINE,
      outlineWidth: 1,
      scaleByDistance: POINT_SCALE_BY_DISTANCE,
      fadeByDistance: POINT_FADE_BY_DISTANCE,
      disableDepthTest: POINT_DISABLE_DEPTH_TEST_M,
      show: record.key !== layerState._selectedKey,
    };
  }

  /**
   * Resolve the effective dock capacity for a station.
   * Prefers the explicit capacity from station_information; falls back to
   * bikes+docks from status data; uses DEFAULT_CAPACITY as last resort.
   * @param {number|null} capacityFromInfo - Capacity from station_information, or null.
   * @param {Object|null} status - Station status object with bikesAvailable/docksAvailable.
   * @returns {number} Resolved capacity (always > 0).
   */

  function resolveCapacity(capacityFromInfo, status) {
    const fromInfo = parts.model.toNonNegativeInteger(capacityFromInfo);
    if (fromInfo && fromInfo > 0) return fromInfo;

    // Derive capacity from current bikes + available docks
    const bikes = parts.model.toNonNegativeInteger(status?.bikesAvailable, 0);
    const docks = parts.model.toNonNegativeInteger(status?.docksAvailable, 0);
    const derived = bikes + docks;
    if (derived > 0) return derived;

    return DEFAULT_CAPACITY;
  }

  /**
   * Map station capacity to a point pixel size using a sqrt scale.
   * Larger-capacity stations render as bigger dots; clamped to [POINT_SIZE_MIN, POINT_SIZE_MAX].
   * @param {number} capacity - Station dock capacity.
   * @returns {number} Point size in pixels.
   */

  function capacityToPixelSize(capacity) {
    const c = Math.max(1, Math.min(80, Number(capacity) || DEFAULT_CAPACITY));
    // sqrt scale so large stations don't dominate visually
    const normalized = Math.sqrt(c) / Math.sqrt(80);
    const size =
      POINT_SIZE_MIN + normalized * (POINT_SIZE_MAX - POINT_SIZE_MIN);
    return Math.max(POINT_SIZE_MIN, Math.min(POINT_SIZE_MAX, size));
  }

  /**
   * Determine the display color for a station based on its availability ratio.
   * - No status data: neutral gray.
   * - Offline (not installed/renting/returning): muted gray.
   * - >60% bikes available: green.
   * - 30-60% bikes available: yellow.
   * - <30% bikes available: red.
   * @param {Object|null} status - Station status object.
   * @param {number} capacity - Resolved station capacity.
   * @returns {readonly number[]} Renderer colour `[r, g, b, a]` for the station point.
   */

  function statusToColor(status, capacity) {
    if (!status) return COLOR_NEUTRAL;
    if (!status.isInstalled || !status.isRenting || !status.isReturning)
      return COLOR_MUTED;

    const bikes = parts.model.toNonNegativeInteger(status.bikesAvailable);
    if (!Number.isFinite(bikes)) return COLOR_NEUTRAL;

    const cap = Math.max(1, Number(capacity) || DEFAULT_CAPACITY);
    const ratio = bikes / cap;
    if (ratio > 0.6) return COLOR_GREEN;
    if (ratio >= 0.3) return COLOR_YELLOW;
    return COLOR_RED;
  }

  /**
   * The ECEF position for a station, on the sampled surface when possible.
   * Falls back to a fixed small height offset if terrain sampling is unsupported.
   * @param {Object} station - Station info object with lat/lon.
   * @returns {{x: number, y: number, z: number}|null} ECEF metres, or null if coordinates are invalid.
   */

  function createStationPosition(station) {
    const lon = Number(station?.lon);
    const lat = Number(station?.lat);
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;

    let height = POINT_HEIGHT_OFFSET_M;
    // Sample terrain height so points sit on ground rather than at ellipsoid level
    const viewer = layerState._viewer;
    if (viewer && heightsOf(viewer).supported().surface) {
      const sampled = heightsOf(viewer).now({ lon, lat });
      if (sampled !== null) height = sampled + POINT_HEIGHT_OFFSET_M;
    }

    return fromDegrees(lon, lat, height);
  }

  /**
   * Get or create the runtime tracking object for a city.
   * @param {string} cityId - City identifier.
   * @returns {{ stationKeys: Set<string> }} City runtime object.
   */

  function ensureCityRuntime(cityId) {
    if (layerState._cityRuntime.has(cityId))
      return layerState._cityRuntime.get(cityId);
    const runtime = { stationKeys: new Set() };
    layerState._cityRuntime.set(cityId, runtime);
    return runtime;
  }

  /**
   * Ensure dots exist for all stations in a city.
   * Creates new dots for stations not yet rendered; skips existing ones.
   * Respects the MAX_TOTAL_POINTS global cap to prevent GPU overload.
   * @param {string} cityId - City identifier.
   * @param {Map<string, Object>} stationMap - Parsed station info map for the city.
   */

  function ensureCityPoints(cityId, stationMap) {
    // Deferred debounce/fetch completions mutate point primitives after the
    // camera settled — each commit needs one frame in idle mode. (perf wave 2 fix)
    governorRequestRender('bikeshare-points');
    const runtime = ensureCityRuntime(cityId);

    const added = [];
    for (const station of stationMap.values()) {
      const key = parts.model.stationKey(cityId, station.stationId);
      if (layerState._stationRenderMap.has(key)) {
        runtime.stationKeys.add(key);
        continue;
      }

      // Enforce global point cap
      if (layerState._stationRenderMap.size >= MAX_TOTAL_POINTS) {
        if (!layerState._limitWarned) {
          layerState._limitWarned = true;
          console.warn(
            `[Data:Bikeshare] Point cap reached (${MAX_TOTAL_POINTS}).`,
          );
        }
        break;
      }

      const position = createStationPosition(station);
      if (!position) continue;

      const record = {
        key,
        cityId,
        stationId: station.stationId,
        stationName: station.name,
        position,
        pixelSize: capacityToPixelSize(station.capacity),
        color: COLOR_NEUTRAL,
        capacity: parts.model.toNonNegativeInteger(station.capacity),
        publishedCapacity: parts.model.toNonNegativeInteger(station.capacity),
        bikesAvailable: null,
        docksAvailable: null,
        isInstalled: station.isInstalled,
        isRenting: station.isRenting,
        isReturning: station.isReturning,
      };
      layerState._stationRenderMap.set(key, record);
      // A dot with distance-based scale and translucency falloff.
      added.push(stationItem(record));

      runtime.stationKeys.add(key);
    }
    if (added.length) layerState._stationSet?.upsert(added);

    layerState._count = layerState._stationRenderMap.size;
  }

  /**
   * Remove all rendered dots for a city and clean up runtime state.
   * Also clears any active selection if it belongs to this city.
   * @param {string} cityId - City identifier to remove.
   */

  function removeCityPoints(cityId) {
    const runtime = layerState._cityRuntime.get(cityId);
    if (!runtime) return;

    // Clear selection if it belongs to the city being removed
    if (
      layerState._selectedKey &&
      runtime.stationKeys.has(layerState._selectedKey)
    ) {
      parts.selection._clearSelection();
    }

    const removed = [];
    for (const key of runtime.stationKeys) {
      if (!layerState._stationRenderMap.has(key)) continue;
      removed.push(key);
      layerState._stationRenderMap.delete(key);
    }
    if (removed.length) layerState._stationSet?.remove(removed);

    layerState._cityRuntime.delete(cityId);
    layerState._count = layerState._stationRenderMap.size;
  }

  /**
   * Apply real-time status data to rendered station points for a city.
   * Updates each point's color (availability ratio) and pixel size (capacity),
   * and refreshes the render record's cached availability fields.
   * @param {string} cityId - City identifier.
   * @param {Map<string, Object>} statusMap - Parsed station status map.
   */

  function applyStatusToPoints(cityId, statusMap) {
    governorRequestRender('bikeshare-status');
    const runtime = layerState._cityRuntime.get(cityId);
    if (!runtime) return;

    const updated = [];
    for (const key of runtime.stationKeys) {
      const record = layerState._stationRenderMap.get(key);
      if (!record) continue;

      const status = statusMap.get(record.stationId) || null;
      // Resolve from the published capacity, not last poll's derived value.
      const capacity = resolveCapacity(record.publishedCapacity, status);
      record.capacity = capacity;

      record.bikesAvailable = parts.model.toNonNegativeInteger(
        status?.bikesAvailable,
      );
      record.docksAvailable = parts.model.toNonNegativeInteger(
        status?.docksAvailable,
      );
      record.isInstalled = parts.model.normalizeGbfsBool(
        status?.isInstalled,
        true,
      );
      record.isRenting = parts.model.normalizeGbfsBool(status?.isRenting, true);
      record.isReturning = parts.model.normalizeGbfsBool(
        status?.isReturning,
        true,
      );

      // Update visual properties based on current status
      record.pixelSize = capacityToPixelSize(capacity);
      record.color = statusToColor(status, capacity);
      updated.push(stationItem(record));
    }
    if (updated.length) layerState._stationSet?.upsert(updated);
  }
  return {
    attachSets,
    detachSets,
    stationItem,
    resolveCapacity,
    capacityToPixelSize,
    statusToColor,
    createStationPosition,
    ensureCityRuntime,
    ensureCityPoints,
    removeCityPoints,
    applyStatusToPoints,
  };
}
