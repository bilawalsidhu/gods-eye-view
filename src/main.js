import { createStandaloneApplication } from './standalone/application.js';
import { describeError } from './standalone/errors.js';
import { installServerlessNotice } from './serverlessMode.js';
import { installOndemandVoice } from './voice/ondemand/index.js';

const application = createStandaloneApplication({
  googleApiKey: import.meta.env.GOOGLE_MAPS_API_KEY,
  cesiumToken: import.meta.env.CESIUM_ION_TOKEN,
  allowQaRegistration: import.meta.env.DEV,
});

application.start().catch((error) => {
  console.error('OnDemand Spatial initialization failed:', error);
  const loaderStatus = document.querySelector('#loading-screen .loader-status');
  loaderStatus.textContent = `Error: ${describeError(error)}`;
  loaderStatus.style.color = '#ff4444';
});

// No-op unless this build was produced with VITE_SERVERLESS_MODE=true; see
// src/serverlessMode.js.
installServerlessNotice();

// OD VOICE — OnDemand turn-based voice (media+STT → chat/workflow → TTS),
// active in dev AND serverless builds once the scene components exist; the
// startup failure above is already reported, so a rejected start is ignored
// here. See src/voice/ondemand/index.js and docs/VOICE_MODE.md.
application
  .start()
  .then((components) => installOndemandVoice({ components }))
  .catch(() => {});

export { application };
