import * as Cesium from 'cesium';
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
  HEIGHT_REFINE_BUDGET_MS,
  HEIGHT_REFINE_INTERVAL_MS,
} from './policy.js';
import {
  createTerrainSurface,
  TERRAIN_NEED,
} from '../../services/terrainSurface.js';

export function createRendering({
  state: layerState,
  services,
  parts,
  source,
}) {
  const { governorRequestRender } = services.render;
  // The terrain globe's loaded surface: the application's shared reader, or
  // the layer's own when it is built without one.
  const terrainSurface =
    services.ground?.terrainSurface || createTerrainSurface();
  /** Stations drawn at the fallback height, waiting for their ground height. */
  let heightQueue = [];
  let heightTimer = null;
  const heightPoint = new Cesium.Cartographic();

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
   * @returns {Cesium.Color} Color to apply to the station point.
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
   * Create a Cartesian3 position for a station at the fallback height. Its
   * ground height is found afterwards (refineHeights): a city's stations are
   * drawn at once, and finding hundreds of heights in the same task held the
   * main thread for most of a second.
   * @param {Object} station - Station info object with lat/lon.
   * @returns {Cesium.Cartesian3|null} World position, or null if coordinates are invalid.
   */

  function createStationPosition(station) {
    const lon = Number(station?.lon);
    const lat = Number(station?.lat);
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;
    return Cesium.Cartesian3.fromDegrees(lon, lat, POINT_HEIGHT_OFFSET_M);
  }

  /**
   * The ground height under a station, or undefined when the scene cannot say.
   * A terrain globe answers from its loaded surface, which is cheap. Where it
   * cannot (the globe is hidden under photorealistic tiles, or draws no tile
   * at the point) the scene renders the depth there, at a millisecond or more
   * a point.
   */

  function sampleGroundHeight(lat, lon) {
    const viewer = layerState._viewer;
    const scene = viewer?.scene;
    if (!scene) return undefined;
    // A station is a marker: its one read is not left for a later window.
    // The step's own time budget bounds what a pass spends.
    const terrain = terrainSurface.height(
      viewer,
      lat,
      lon,
      TERRAIN_NEED.MARKER,
    );
    if (Number.isFinite(terrain)) return terrain;
    if (!scene.sampleHeightSupported) return undefined;
    Cesium.Cartographic.fromDegrees(lon, lat, 0, heightPoint);
    const sampled = scene.sampleHeight(heightPoint);
    return Number.isFinite(sampled) ? sampled : undefined;
  }

  /**
   * Move queued stations onto the ground for a few milliseconds, then leave
   * the rest to the next step. A station the scene has no height for keeps
   * the fallback height, as it did when heights were read while drawing.
   */

  function refineHeights() {
    heightTimer = null;
    const started = performance.now();
    let moved = false;
    while (
      heightQueue.length > 0 &&
      performance.now() - started < HEIGHT_REFINE_BUDGET_MS
    ) {
      const { record, lat, lon } = heightQueue.pop();
      const ground = sampleGroundHeight(lat, lon);
      if (ground === undefined) continue;
      record.point.position = Cesium.Cartesian3.fromDegrees(
        lon,
        lat,
        ground + POINT_HEIGHT_OFFSET_M,
      );
      moved = true;
      // The highlight and card of a selected station copy its position.
      if (layerState._selectedKey === record.key)
        parts.selection._selectStation(record.key);
    }
    if (moved) governorRequestRender('bikeshare-heights');
    scheduleHeightRefinement();
  }

  function scheduleHeightRefinement() {
    if (heightTimer !== null || heightQueue.length === 0) return;
    heightTimer = setTimeout(refineHeights, HEIGHT_REFINE_INTERVAL_MS);
  }

  /** Drop every queued station and the pending step. */

  function stopHeightRefinement() {
    heightQueue = [];
    clearTimeout(heightTimer);
    heightTimer = null;
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
   * Ensure point primitives exist for all stations in a city.
   * Creates new points for stations not yet rendered; skips existing ones.
   * Respects the MAX_TOTAL_POINTS global cap to prevent GPU overload.
   * @param {string} cityId - City identifier.
   * @param {Map<string, Object>} stationMap - Parsed station info map for the city.
   */

  function ensureCityPoints(cityId, stationMap) {
    // Deferred debounce/fetch completions mutate point primitives after the
    // camera settled — each commit needs one frame in idle mode. (perf wave 2 fix)
    governorRequestRender('bikeshare-points');
    const runtime = ensureCityRuntime(cityId);

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

      // Add a point primitive with distance-based scale and translucency falloff
      const point = layerState._pointCollection.add({
        position,
        pixelSize: capacityToPixelSize(station.capacity),
        color: COLOR_NEUTRAL,
        outlineColor: COLOR_OUTLINE,
        outlineWidth: 1,
        scaleByDistance: new Cesium.NearFarScalar(200, 1.35, 130000, 0.4),
        translucencyByDistance: new Cesium.NearFarScalar(
          200,
          1.0,
          180000,
          0.15,
        ),
        disableDepthTestDistance: 2500,
        id: key,
      });

      const record = {
        key,
        cityId,
        stationId: station.stationId,
        stationName: station.name,
        point,
        capacity: parts.model.toNonNegativeInteger(station.capacity),
        publishedCapacity: parts.model.toNonNegativeInteger(station.capacity),
        bikesAvailable: null,
        docksAvailable: null,
        isInstalled: station.isInstalled,
        isRenting: station.isRenting,
        isReturning: station.isReturning,
      };
      layerState._stationRenderMap.set(key, record);
      heightQueue.push({
        record,
        lat: Number(station.lat),
        lon: Number(station.lon),
      });

      runtime.stationKeys.add(key);
    }

    layerState._count = layerState._stationRenderMap.size;
    scheduleHeightRefinement();
  }

  /**
   * Remove all rendered point primitives for a city and clean up runtime state.
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

    for (const key of runtime.stationKeys) {
      const record = layerState._stationRenderMap.get(key);
      if (!record) continue;
      layerState._pointCollection.remove(record.point);
      layerState._stationRenderMap.delete(key);
    }

    // Its stations no longer wait for a height.
    heightQueue = heightQueue.filter(
      ({ record }) => layerState._stationRenderMap.get(record.key) === record,
    );
    if (heightQueue.length === 0) stopHeightRefinement();

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
      record.point.pixelSize = capacityToPixelSize(capacity);
      record.point.color = statusToColor(status, capacity);
    }
  }
  return {
    resolveCapacity,
    capacityToPixelSize,
    statusToColor,
    createStationPosition,
    ensureCityRuntime,
    ensureCityPoints,
    removeCityPoints,
    applyStatusToPoints,
    stopHeightRefinement,
    /** Stations still waiting for their ground height. */
    pendingHeightCount: () => heightQueue.length,
    /** Whether a refinement step is waiting on a timer. */
    heightRefinementScheduled: () => heightTimer !== null,
  };
}
