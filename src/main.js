import { createStandaloneApplication } from './standalone/application.js';
import { describeError } from './standalone/errors.js';
import { t } from './i18n/index.js';
import { readBrowserConfig } from './standalone/browserConfig.js';

const browserConfig = {
  googleApiKey: import.meta.env.GOOGLE_MAPS_API_KEY,
  cesiumToken: import.meta.env.CESIUM_ION_TOKEN,
  mapillaryToken: import.meta.env.MAPILLARY_CLIENT_TOKEN,
};

const application = createStandaloneApplication({
  ...browserConfig,
  loadBrowserConfig: import.meta.env.GEV_PANEL_BUILD
    ? undefined
    : (signal) => readBrowserConfig(browserConfig, { signal }),
  allowQaRegistration: import.meta.env.DEV,
});

application.start().catch((error) => {
  console.error("God's Eye View initialization failed:", error);
  const loaderStatus = document.querySelector('#loading-screen .loader-status');
  loaderStatus.textContent = t('Error: {message}', {
    message: describeError(error),
  });
  loaderStatus.style.color = '#ff4444';
});

export { application };
