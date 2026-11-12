import { createStandaloneApplication } from './standalone/application.js';
import { describeError } from './standalone/errors.js';
import { fetchServerKeyStatus } from './sources/serverKeys.js';
import { createMapillarySource } from './layers/streetLevel/providers/mapillary/source.js';
import { t } from './i18n/index.js';

// The Vite boundary exposes only undefined, null, or a validated URL.
const photonSetting = import.meta.env.PHOTON_URL;

/** Say on the loading screen why the application did not start. */
function showStartupError(error) {
  console.error("God's Eye View initialization failed:", error);
  const loaderStatus = document.querySelector('#loading-screen .loader-status');
  loaderStatus.textContent = t('Error: {message}', {
    message: describeError(error),
  });
  loaderStatus.style.color = '#ff4444';
}

// The Cesium ion and Mapillary tokens stay on the server
// (server/providers/keyIsolation); before it starts, the browser only learns
// what the server holds, asked together: for ion a marker ('server-managed',
// or '' when the server holds no token; not a credential), for Mapillary a
// boolean. Street Level picks its first source from the Mapillary answer when
// it is built. No top-level await: the production build targets es2020, which
// rejects it.
const application = fetchServerKeyStatus().then(
  ({ cesiumToken, mapillaryConfigured }) => {
    let app;
    try {
      app = createStandaloneApplication({
        googleApiKey: import.meta.env.GOOGLE_MAPS_API_KEY,
        cesiumToken,
        sources: {
          mapillary: createMapillarySource({ configured: mapillaryConfigured }),
        },
        geospatial:
          photonSetting === undefined
            ? {}
            : { endpoints: { photon: photonSetting } },
        allowQaRegistration: import.meta.env.DEV,
      });
    } catch (error) {
      // Nothing has started, so the loading screen would say nothing. The
      // promise still rejects, so callers see the failure too.
      showStartupError(error);
      throw error;
    }
    app.start().catch(showStartupError);
    return app;
  },
);

export { application };
