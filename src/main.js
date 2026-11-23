import { createStandaloneApplication } from './standalone/application.js';
import { fetchServerKeyStatus } from './sources/serverKeys.js';
import { createMapillarySource } from './layers/streetLevel/providers/mapillary/source.js';
import { t } from './i18n/index.js';
import { PHOTON_SETTING as photonSetting } from './search/photonSetting.js';

/**
 * Say on the loading screen that the application did not start.
 *
 * The failure itself is neither shown nor logged: a startup error can carry
 * a credential (a key in a URL, a bearer token in a header, a password in a
 * URL's userinfo), and the loading screen and the console are both places
 * where it would be read out. The page says only that the application did
 * not start; a caller that awaits `application` gets the fixed error below
 * instead of the failure.
 */
function showStartupError() {
  console.error("God's Eye View initialization failed.");
  const loaderStatus = globalThis.document?.querySelector(
    '#loading-screen .loader-status',
  );
  // A page without the loading screen must still report the failure.
  if (!loaderStatus) return;
  loaderStatus.textContent = t('The application could not start.');
  loaderStatus.style.color = '#ff4444';
}

/**
 * The error a caller that awaits `application` gets when the application
 * cannot start.
 *
 * A fresh error every time, with a fixed message and no cause: the failure
 * that caused it can carry a credential (a key in a URL, a bearer token in a
 * header, a password in a URL's userinfo), and passing that failure on
 * would carry the credential into the message, the stack, the cause and
 * whatever the caller logs, serializes or reports as an unhandled
 * rejection. This error says what happened and nothing else.
 */
function startupError() {
  return new Error('The application could not start.');
}

// The Cesium ion and Mapillary tokens stay on the server
// (server/providers/keyIsolation); before it starts, the browser only learns
// what the server holds, asked together: for ion a marker ('server-managed',
// or '' when the server holds no token; not a credential), for Mapillary a
// boolean. Street Level picks its first source from the Mapillary answer when
// it is built. No top-level await: the production build targets es2020, which
// rejects it.
const application = fetchServerKeyStatus()
  .then(({ cesiumToken, mapillaryConfigured }) => {
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
    } catch {
      // The failure is dropped here: it can carry a credential, and the
      // caller gets the fixed error instead of it.
      throw startupError();
    }
    // `start()` can fail after the application exists. Its failure is
    // reported like a build failure and swallowed, so nothing of it is
    // logged.
    app.start().catch(() => showStartupError());
    return app;
  })
  .catch(() => {
    // Every way into a startup failure ends here: the loading screen and
    // the console are told, and the promise still rejects, so a caller that
    // awaits `application` sees the fixed error and never the failure.
    showStartupError();
    throw startupError();
  });

export { application };
