import { createStandaloneApplication } from './standalone/application.js';
import { describeError } from './standalone/errors.js';
import { photonEndpointSetting } from './keylessGeocoder.js';

// PHOTON_URL: undefined when unset (public default), empty disables, else a URL.
const photonSetting = import.meta.env.PHOTON_URL;

const application = createStandaloneApplication({
  googleApiKey: import.meta.env.GOOGLE_MAPS_API_KEY,
  cesiumToken: import.meta.env.CESIUM_ION_TOKEN,
  geospatial:
    photonSetting == null
      ? {}
      : { endpoints: { photon: photonEndpointSetting(photonSetting) } },
  allowQaRegistration: import.meta.env.DEV,
});

application.start().catch((error) => {
  console.error("God's Eye View initialization failed:", error);
  const loaderStatus = document.querySelector('#loading-screen .loader-status');
  loaderStatus.textContent = `Error: ${describeError(error)}`;
  loaderStatus.style.color = '#ff4444';
});

export { application };
