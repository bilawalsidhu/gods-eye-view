import { isConsoleRoute } from './xr/routes.js';

// Load only the renderer used by this view. A headset never pays for Cesium.
let application;
const entry = isConsoleRoute(location.search, location.hash)
  ? import('./standalone/main.js')
  : import('./xr/main.js');
entry
  .then((module) => {
    application = module.application;
  })
  .catch((error) => {
    console.error('Application entry failed', error);
    const status = document.querySelector('#loading-screen .loader-status');
    if (status) status.textContent = `Unable to start: ${error.message}`;
  });

export { application };
