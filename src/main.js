import { createStandaloneApplication } from './standalone/application.js';
import { describeError } from './standalone/errors.js';
import { createLocalVoiceSession } from './voice/localVoiceSession.js';

const application = createStandaloneApplication({
  googleApiKey: import.meta.env.GOOGLE_MAPS_API_KEY,
  cesiumToken: import.meta.env.CESIUM_ION_TOKEN,
  allowQaRegistration: import.meta.env.DEV,
  // AI_PROVIDER=ollama swaps the OpenAI Realtime adapter for the local one.
  voice:
    import.meta.env.GEV_AI_PROVIDER === 'ollama'
      ? { createSession: createLocalVoiceSession }
      : {},
});

application.start().catch((error) => {
  console.error("God's Eye View initialization failed:", error);
  const loaderStatus = document.querySelector('#loading-screen .loader-status');
  loaderStatus.textContent = `Error: ${describeError(error)}`;
  loaderStatus.style.color = '#ff4444';
});

export { application };
