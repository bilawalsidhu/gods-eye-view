import { passesImageryFilter } from '../../filter.js';
import { FOLLOW_MAP_STACK_ID } from '../../policy.js';
import { createMapsLoader } from './mapsLoader.js';
import { createGoogleViewer } from './viewer.js';
import {
  COLORS,
  GOOGLE_CREDIT_HTML,
  GOOGLE_KEY_ID,
  GOOGLE_LABEL,
  GOOGLE_NAME,
  GOOGLE_PROVIDER_ID,
  FLAT_FILTER_HINT,
  GROUND_CLICK_HINT,
  KEY_REJECTED_MESSAGE,
  NEAREST_RADIUS_M,
  NEAREST_TIMEOUT_MS,
  NO_ANSWER_MESSAGE,
  PICK_PREFIX,
  imageMonthEndMs,
} from './policy.js';

/**
 * `promise`, unless `ms` pass first (NO_ANSWER_MESSAGE), `signal` aborts, or
 * Google refuses the key: a lookup Google never answers must not keep the
 * panel loading.
 */
function settleWithin(promise, { ms, signal, loader }) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => finish(reject, new Error(NO_ANSWER_MESSAGE)),
      ms,
    );
    const onAbort = () => finish(reject, signal.reason);
    signal?.addEventListener('abort', onAbort, { once: true });
    const stopAuthWatch = loader.onAuthFailure(() =>
      finish(reject, new Error(KEY_REJECTED_MESSAGE)),
    );
    promise.then(
      (value) => finish(resolve, value),
      (error) => finish(reject, error),
    );
    function finish(settle, value) {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      stopAuthWatch();
      settle(value);
    }
  });
}

/**
 * Google Street View Street Level provider: Google's own panorama viewer and
 * nearest-panorama lookups. Google offers no coverage layer for other maps,
 * so it draws none; a click on a street opens the panorama there.
 * `getApiKey` returns the browser Maps key; `loader` is ./mapsLoader.js or a stand-in.
 * @returns {import('../../registry.js').StreetLevelProvider}
 */
export function createGoogleProvider({
  getApiKey,
  loader = createMapsLoader({ getApiKey }),
}) {
  if (typeof getApiKey !== 'function')
    throw new TypeError('Google Street View needs getApiKey');

  return Object.freeze({
    id: GOOGLE_PROVIDER_ID,
    name: GOOGLE_NAME,
    label: GOOGLE_LABEL,
    requiresKeyId: GOOGLE_KEY_ID,
    pickPrefix: PICK_PREFIX.root,
    colors: COLORS,
    credit: Object.freeze({ html: GOOGLE_CREDIT_HTML }),
    groundClick: true,
    // Google's terms forbid Street View beside non-Google maps.
    requiresMapStack: FOLLOW_MAP_STACK_ID,
    // Every panorama is billed to the Maps key: the user lights the chip.
    defaultOn: false,

    create(context) {
      let keyRequired = !getApiKey();
      let active = false;
      let service = null;
      /** The one StreetViewService the lookups and the viewer share. */
      async function getService() {
        const lib = await loader.importLibrary('streetView');
        service ||= new lib.StreetViewService();
        return service;
      }
      const viewer = createGoogleViewer({
        loader,
        getService,
        render: context.services?.render,
      });
      const stopAuthWatch = loader.onAuthFailure(() => {
        // Switched off since: its chip says so; no error over another photo.
        if (context.isActive?.())
          context.actions.reportError(KEY_REJECTED_MESSAGE);
        context.notify();
      });

      return {
        async status() {
          keyRequired = !getApiKey();
          context.notify();
          return { configured: !keyRequired };
        },

        init() {},

        activate() {
          active = true;
        },

        deactivate() {
          active = false;
        },

        destroy() {
          active = false;
          stopAuthWatch();
        },

        refreshCoverage() {},

        /** Nothing drawn to redraw: lookups read the filter when they run. */
        setFilter() {},

        coverageStats() {
          const keyRejected = loader.authFailed();
          return {
            count: 0,
            zoom: null,
            kind: null,
            loading: false,
            hint:
              !active || keyRequired || keyRejected
                ? ''
                : context.getFilter().pano === 'flat'
                  ? FLAT_FILTER_HINT
                  : GROUND_CLICK_HINT,
            error: keyRejected ? KEY_REJECTED_MESSAGE : null,
            keyRequired,
            keyRejected,
          };
        },

        handlePick: () => false,

        /**
         * Nearest Google-collected outdoor panorama that passes the imagery
         * filter, or null. Every Street View panorama is 360°.
         */
        async nearestImage({ lat, lon }, { signal } = {}) {
          if (loader.authFailed()) throw new Error(KEY_REJECTED_MESSAGE);
          signal?.throwIfAborted();
          const filter = context.getFilter();
          if (filter.pano === 'flat') return null;
          const lookup = (async () => {
            const lib = await loader.importLibrary('streetView');
            await getService();
            const { GOOGLE, OUTDOOR } = lib.StreetViewSource;
            try {
              const { data } = await service.getPanorama({
                location: { lat, lng: lon },
                radius: NEAREST_RADIUS_M,
                // Both: Google's own imagery, outdoors (sources intersect).
                sources: [GOOGLE, OUTDOOR],
                preference: lib.StreetViewPreference.NEAREST,
              });
              return data;
            } catch (error) {
              if (error?.code === 'ZERO_RESULTS') return null;
              throw error;
            }
          })();
          const data = await settleWithin(lookup, {
            ms: NEAREST_TIMEOUT_MS,
            signal,
            loader,
          });
          const panoId = data?.location?.pano;
          if (!panoId) return null;
          const passes = passesImageryFilter(
            { isPano: true, capturedAt: imageMonthEndMs(data.imageDate) ?? 0 },
            filter,
          );
          if (!passes) return null;
          viewer.remember(panoId, data);
          return panoId;
        },

        viewer,
      };
    },
  });
}
