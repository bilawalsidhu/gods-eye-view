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
      // A failed city is only the layer's failure when it left nothing on the
      // map. While any city still renders, the layer is working and says so.
      if (
        layerState._failedCityIds.size > 0 &&
        layerState._stationRenderMap.size === 0
      ) {
        stats.error = 'GBFS fetch error';
      }
      return stats;
    },
  };

  return { methods };
}
