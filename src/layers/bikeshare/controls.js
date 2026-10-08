import { STATUS_POLL_MS } from './policy.js';

export function createControls({ state: layerState, services, parts, source }) {
  const methods = {
    id: 'bikeshare',

    name: 'Bikeshare',

    icon: '🚲',

    source: 'GBFS',

    updateInterval: STATUS_POLL_MS,

    /**
     * Return a sampled array of detectable station objects for HUD overlay rendering.
     * @param {Object} [options] - Sampling options (maxCount, seed).
     * @returns {Array<{ position: Cesium.Cartesian3, id: string, type: string, skipLabel: boolean }>}
     */
    getDetectableObjects(options = {}) {
      return parts.queries.collectDetectableStations(options);
    },

    /**
     * Snapshot loaded bikeshare stations as plain JSON-safe records for the analyst
     * query engine. On demand only (once per spoken query); [] while the
     * layer is off.
     * @param {number} [maxCount=Infinity] Most records to return.
     * @returns {Array<Object>} {id, name, city, lat, lon, bikesAvailable, docksAvailable, capacity, renting}.
     */
    getAnalystRecords(maxCount = Infinity) {
      if (!layerState._enabled) return [];
      const num = (v) => (Number.isFinite(v) ? v : null);
      const result = [];
      for (const record of layerState._stationRenderMap.values()) {
        if (result.length >= maxCount) break;
        const info = layerState._stationInfoCache
          .get(record.cityId)
          ?.get(record.stationId);
        if (!Number.isFinite(info?.lat) || !Number.isFinite(info?.lon))
          continue;
        result.push({
          id: record.stationName || `Dock ${record.stationId}`,
          name: record.stationName || null,
          city: record.cityId || null,
          lat: info.lat,
          lon: info.lon,
          bikesAvailable: num(record.bikesAvailable),
          docksAvailable: num(record.docksAvailable),
          capacity: num(record.capacity),
          renting: record.isRenting !== false,
        });
      }
      return result;
    },

    /**
     * Return current layer statistics for the UI status display.
     * @returns {{ count: number, lastUpdate: number|null, loading: boolean, loadingLabel?: string, error?: string }}
     */
    getStats() {
      const stats = {
        count: layerState._count,
        lastUpdate: layerState._lastUpdate,
        loading: layerState._loading,
      };
      if (layerState._loading) {
        stats.loadingLabel =
          layerState._activeCityIds.size > 0
            ? `syncing ${layerState._activeCityIds.size} city feeds...`
            : 'scanning nearby systems...';
      }
      if (layerState._error) stats.error = layerState._error;
      return stats;
    },
  };

  return { methods };
}
