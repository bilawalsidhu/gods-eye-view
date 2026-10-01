import { frameLabel } from './dates.js';
import { COVERAGE_NOTE, DEFAULT_ALPHA, LAYER_ID } from './policy.js';

export function createControls({ state: layerState, services, parts }) {
  const methods = {
    id: LAYER_ID,

    name: 'Surface Temperature',

    icon: '🌡️',

    source: 'NASA GIBS · MODIS Terra land surface temperature',

    /** One resolved year per enable; nothing to poll. */
    updateInterval: 0,

    statsRefreshInterval: 2000,

    defaultAlpha: DEFAULT_ALPHA,

    /**
     * Set overlay opacity.
     * @param {number} value Requested opacity between MIN_ALPHA and MAX_ALPHA.
     * @returns {number} Applied opacity.
     */
    setOpacity(value) {
      return parts.filmstrip.setAlpha(value);
    },

    getOpacity() {
      return layerState.alpha;
    },

    getStats() {
      const year = layerState.playback?.year ?? null;
      return {
        // An imagery overlay has no records. Report 1 while frames are loaded
        // so the panel row reads as active rather than as empty.
        count: layerState.filmstrip ? 1 : 0,
        lastUpdate: layerState.lastUpdate,
        status: layerState.status,
        loading: layerState.loading,
        error: layerState.error,
        failureReason: layerState.failureReason,
        frameDate: layerState.date,
        latestDate: layerState.latest,
        year,
        opacity: layerState.alpha,
        coverage: COVERAGE_NOTE,
        statusMessage: layerState.loading
          ? 'Loading a year of monthly means…'
          : layerState.status === 'unavailable'
            ? layerState.error || 'NASA GIBS unavailable'
            : layerState.status === 'idle'
              ? 'Temperature overlay off'
              : layerState.date
                ? `${frameLabel(layerState.date)} · newest ${layerState.latest.slice(0, 7)}`
                : 'Loading frames…',
        loadingLabel: layerState.loading ? 'loading monthly means' : '',
      };
    },
  };

  return { methods };
}
