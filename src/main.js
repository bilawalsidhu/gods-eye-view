import { createStandaloneApplication } from './standalone/application.js';
import { describeError } from './standalone/errors.js';
import { mountOperationsConsole } from './console/index.js';

// Additive chrome: it attaches to the running application through the debug
// handle and never participates in bootstrap, so a console failure cannot stop
// the globe from loading. The guard is what makes that true rather than
// merely intended.
const operationsConsole = (() => {
  try {
    return mountOperationsConsole();
  } catch (error) {
    console.error('Operations Console failed to mount:', error);
    return null;
  }
})();

const application = createStandaloneApplication({
  googleApiKey: import.meta.env.GOOGLE_MAPS_API_KEY,
  cesiumToken: import.meta.env.CESIUM_ION_TOKEN,
  allowQaRegistration: import.meta.env.DEV,
});

application.start().catch((error) => {
  console.error("God's Eye View initialization failed:", error);
  const loaderStatus = document.querySelector('#loading-screen .loader-status');
  loaderStatus.textContent = `Error: ${describeError(error)}`;
  loaderStatus.style.color = '#ff4444';
});

export { application, operationsConsole };
