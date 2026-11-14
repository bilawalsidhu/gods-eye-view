import { msg, t } from '../../i18n/index.js';
import { frameLabel } from './labels.js';
import { NO_IMAGERY_HOST } from '../weather/imageryHost.js';
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
      // The frames live in the globe's imagery layers. A map source that hides
      // the globe (photorealistic 3D tiles) leaves them loaded but unseen, so
      // say so rather than reporting ready. The year stays loaded and shows
      // again on a globe map.
      const hidden =
        layerState.status !== 'idle' &&
        layerState.viewer?.scene?.globe?.show === false;
      return {
        // An imagery overlay has no records. Report 1 while frames are visible
        // so the panel row reads as active rather than as empty.
        count: layerState.filmstrip && !hidden ? 1 : 0,
        lastUpdate: layerState.lastUpdate,
        status: layerState.status,
        loading: layerState.loading,
        error: layerState.error || (hidden ? NO_IMAGERY_HOST : null),
        failureReason: layerState.failureReason,
        frameDate: layerState.date,
        latestDate: layerState.latest,
        year,
        opacity: layerState.alpha,
        coverage: COVERAGE_NOTE,
        statusMessage: hidden
          ? NO_IMAGERY_HOST
          : layerState.loading
            ? msg('Loading a year of monthly means…')
            : layerState.status === 'unavailable'
              ? layerState.error || msg('NASA GIBS unavailable')
              : layerState.status === 'idle'
                ? msg('Temperature overlay off')
                : layerState.date
                  ? t('{frame} · newest {month}', {
                      frame: frameLabel(layerState.date),
                      month: layerState.latest.slice(0, 7),
                    })
                  : msg('Loading frames…'),
        loadingLabel: layerState.loading ? msg('loading monthly means') : '',
      };
    },
  };

  return { methods };
}
