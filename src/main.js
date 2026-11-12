import { createStandaloneApplication } from './standalone/application.js';
import { describeError } from './standalone/errors.js';
import { fetchServerKeyStatus } from './sources/serverKeys.js';
import { createMapillarySource } from './layers/streetLevel/providers/mapillary/source.js';
import { t } from './i18n/index.js';

// The Vite boundary exposes only undefined, null, or a validated URL.
const photonSetting = import.meta.env.PHOTON_URL;

// The Cesium ion and Mapillary tokens stay on the server
// (server/providers/keyIsolation); before it starts, the browser only learns
// whether the server holds each of them (two booleans, asked together).
// Street Level picks its first source from the Mapillary one when it is
// built. No top-level await: the production build targets es2020, which
// rejects it.
const application = fetchServerKeyStatus().then(
  ({ cesiumToken, mapillaryConfigured }) => {
    const app = createStandaloneApplication({
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
    app.start().catch((error) => {
      console.error("God's Eye View initialization failed:", error);
      const loaderStatus = document.querySelector(
        '#loading-screen .loader-status',
      );
      loaderStatus.textContent = t('Error: {message}', {
        message: describeError(error),
      });
      loaderStatus.style.color = '#ff4444';
    });
    return app;
  },
);

export { application };
