import { MAX_TOTAL_POINTS } from './policy.js';
import {
  capacityToPixelSize,
  resolveCapacity,
  statusToColor,
} from './presentation.js';

/**
 * The station records behind the rendered points, per city, on either
 * engine. `points` draws them:
 * - `position(station)`: the station's world position, or null;
 * - `create(record, { position, pixelSize })`: the record's point;
 * - `remove(record)`, `update(record)`: one point removed or restyled;
 * - `afterAdd()`, `afterRemove()`, `afterUpdate()`: a batch is done.
 * Every member but `position` and `create` is optional.
 */
export function createStationPoints({ state, services, parts }, points) {
  /**
   * Get or create the runtime tracking object for a city.
   * @param {string} cityId - City identifier.
   * @returns {{ stationKeys: Set<string> }} City runtime object.
   */
  function ensureCityRuntime(cityId) {
    if (state._cityRuntime.has(cityId)) return state._cityRuntime.get(cityId);
    const runtime = { stationKeys: new Set() };
    state._cityRuntime.set(cityId, runtime);
    return runtime;
  }

  /**
   * Ensure points exist for all stations in a city.
   * Creates new points for stations not yet rendered; skips existing ones.
   * Respects the MAX_TOTAL_POINTS global cap to prevent GPU overload.
   * @param {string} cityId - City identifier.
   * @param {Map<string, Object>} stationMap - Parsed station info map for the city.
   */
  function ensureCityPoints(cityId, stationMap) {
    // Deferred debounce/fetch completions change points after the camera
    // settled: each commit needs one frame in idle mode.
    services.render.governorRequestRender('bikeshare-points', state._engine);
    const runtime = ensureCityRuntime(cityId);

    for (const station of stationMap.values()) {
      const key = parts.model.stationKey(cityId, station.stationId);
      if (state._stationRenderMap.has(key)) {
        runtime.stationKeys.add(key);
        continue;
      }

      // Enforce global point cap
      if (state._stationRenderMap.size >= MAX_TOTAL_POINTS) {
        if (!state._limitWarned) {
          state._limitWarned = true;
          console.warn(
            `[Data:Bikeshare] Point cap reached (${MAX_TOTAL_POINTS}).`,
          );
        }
        break;
      }

      const position = points.position(station);
      if (!position) continue;

      const record = {
        key,
        cityId,
        stationId: station.stationId,
        stationName: station.name,
        point: null,
        capacity: parts.model.toNonNegativeInteger(station.capacity),
        publishedCapacity: parts.model.toNonNegativeInteger(station.capacity),
        bikesAvailable: null,
        docksAvailable: null,
        isInstalled: station.isInstalled,
        isRenting: station.isRenting,
        isReturning: station.isReturning,
      };
      record.point = points.create(record, {
        position,
        pixelSize: capacityToPixelSize(station.capacity),
      });
      state._stationRenderMap.set(key, record);
      runtime.stationKeys.add(key);
    }

    points.afterAdd?.();
    state._count = state._stationRenderMap.size;
  }

  /**
   * Remove all rendered points for a city and clean up runtime state.
   * Also clears any active selection if it belongs to this city.
   * @param {string} cityId - City identifier to remove.
   */
  function removeCityPoints(cityId) {
    const runtime = state._cityRuntime.get(cityId);
    if (!runtime) return;

    // Clear selection if it belongs to the city being removed
    if (state._selectedKey && runtime.stationKeys.has(state._selectedKey))
      parts.display._clearSelection();

    for (const key of runtime.stationKeys) {
      const record = state._stationRenderMap.get(key);
      if (!record) continue;
      points.remove?.(record);
      state._stationRenderMap.delete(key);
    }

    state._cityRuntime.delete(cityId);
    points.afterRemove?.();
    state._count = state._stationRenderMap.size;
  }

  /**
   * Apply real-time status data to rendered station points for a city.
   * Updates each point's color (availability ratio) and pixel size (capacity),
   * and refreshes the render record's cached availability fields.
   * @param {string} cityId - City identifier.
   * @param {Map<string, Object>} statusMap - Parsed station status map.
   */
  function applyStatusToPoints(cityId, statusMap) {
    services.render.governorRequestRender('bikeshare-status', state._engine);
    const runtime = state._cityRuntime.get(cityId);
    if (!runtime) return;

    for (const key of runtime.stationKeys) {
      const record = state._stationRenderMap.get(key);
      if (!record) continue;

      const status = statusMap.get(record.stationId) || null;
      // Resolve from the published capacity, not last poll's derived value.
      const capacity = resolveCapacity(
        parts.model,
        record.publishedCapacity,
        status,
      );
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
      record.point.color = statusToColor(parts.model, status, capacity);
      points.update?.(record);
    }
    points.afterUpdate?.();
    parts.display.refreshSelectedCard();
  }

  return { ensureCityPoints, removeCityPoints, applyStatusToPoints };
}
