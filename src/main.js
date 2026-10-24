import { createStandaloneApplication } from './standalone/application.js';
import { describeError } from './standalone/errors.js';
import { fetchIonCredential } from './sources/serverKeys.js';
import { t } from './i18n/index.js';

// The Cesium ion and Mapillary tokens stay on the server
// (server/providers/keyIsolation); the browser only learns whether the server
// holds an ion token. No top-level await: the production build targets
// es2020, which rejects it.
const application = fetchIonCredential().then((cesiumToken) => {
  const app = createStandaloneApplication({
    googleApiKey: import.meta.env.GOOGLE_MAPS_API_KEY,
    cesiumToken,
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
});

export { application };
