import { createStandaloneApplication } from './standalone/application.js';
import { describeError } from './standalone/errors.js';
import { createLocalChatSession } from './voice/localChatSession.js';
import './ui/styles/hybrid-intelligence.css';

const application = createStandaloneApplication({
  googleApiKey: import.meta.env.GOOGLE_MAPS_API_KEY,
  cesiumToken: import.meta.env.CESIUM_ION_TOKEN,
  allowQaRegistration: import.meta.env.DEV,
  hudSummaryPolicy: import.meta.env.GEV_LOCAL_MODEL_SELECTED
    ? { requestTimeoutMs: 65_000 }
    : {},
  hybrid: { enabled: import.meta.env.GEV_HYBRID_ENABLED },
  voice: import.meta.env.GEV_LOCAL_MODEL_SELECTED
    ? { createSession: createLocalChatSession }
    : {},
});

application.start().catch((error) => {
  console.error("God's Eye View initialization failed:", error);
  const loaderStatus = document.querySelector('#loading-screen .loader-status');
  loaderStatus.textContent = `Error: ${describeError(error)}`;
  loaderStatus.style.color = '#ff4444';
});

export { application };
