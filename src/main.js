import { createStandaloneApplication } from './standalone/application.js';
import { startPageLocale } from './i18n/page.js';
import { describeError } from './standalone/errors.js';
import { t } from './i18n/index.js';
import { PHOTON_SETTING as photonSetting } from './search/photonSetting.js';

// The page's language loads before any view renders: its catalog, then the
// application that renders in it.
const application = startPageLocale(document).then(() =>
  createStandaloneApplication({
    googleApiKey: import.meta.env.GOOGLE_MAPS_API_KEY,
    cesiumToken: import.meta.env.CESIUM_ION_TOKEN,
    geospatial:
      photonSetting === undefined
        ? {}
        : { endpoints: { photon: photonSetting } },
    allowQaRegistration: import.meta.env.DEV,
  }),
);

application
  .then((app) => app.start())
  .catch((error) => {
    console.error("God's Eye View initialization failed:", error);
    const loaderStatus = document.querySelector(
      '#loading-screen .loader-status',
    );
    loaderStatus.textContent = t('Error: {message}', {
      message: describeError(error),
    });
    loaderStatus.style.color = '#ff4444';
  });

export { application };
