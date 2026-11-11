import { createStandaloneApplication } from './standalone/application.js';
import { describeError } from './standalone/errors.js';
import { t } from './i18n/index.js';

// The Vite boundary exposes only undefined, null, or a validated URL.
const photonSetting = import.meta.env.PHOTON_URL;

const application = createStandaloneApplication({
  googleApiKey: import.meta.env.GOOGLE_MAPS_API_KEY,
  cesiumToken: import.meta.env.CESIUM_ION_TOKEN,
  geospatial:
    photonSetting === undefined ? {} : { endpoints: { photon: photonSetting } },
  // Undefined unless the operator set GEV_BASEMAP_URL or GEV_TERRAIN_URL
  // (validated by Vite; a null terrain selects the flat ellipsoid).
  mapOptions: {
    basemapUrl: import.meta.env.GEV_BASEMAP_URL,
    basemapAttribution: import.meta.env.GEV_BASEMAP_ATTRIBUTION,
    terrainUrl: import.meta.env.GEV_TERRAIN_URL,
  },
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
