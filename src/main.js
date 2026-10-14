import { createStandaloneApplication } from './standalone/application.js';
import { describeError } from './standalone/errors.js';
import { installSameOriginXhrBypassWhenReady } from './mobile/capacitorXhrBypass.js';

// Capacitor's native bridge patches XHR without a same-origin bypass (its
// fetch patch has one): absolute same-origin asset URLs would be proxied to
// a real localhost TLS connection and fail. Rewrite them to relative paths
// first so bundled assets take the local-server path. The bridge injects
// asynchronously around page load, so install when ready: nativeness is
// evaluated late inside the installer, never here at module-eval time.
// Fire-and-forget; resolves false on web with no behavior change.
void installSameOriginXhrBypassWhenReady();

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

export { application };
