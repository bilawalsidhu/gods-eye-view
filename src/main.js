import { createStandaloneApplication } from './standalone/application.js';
import { describeError } from './standalone/errors.js';
import { initAiCommandCenter } from './ui/aiCommandCenter.js';

// Initialize JARVIS AI Command Center immediately for instant interactivity
try {
  initAiCommandCenter({
    getGlobeContext: () => {
      const gev = globalThis.window?.__godsEyeView;
      return gev?.dataManager?.contextStore?.getSnapshot?.() || null;
    },
    executeGlobeAction: async (name, args) => {
      const gev = globalThis.window?.__godsEyeView;
      const runner = gev?.runner || gev?.voiceCommands?.runner;
      if (typeof runner === 'function') {
        return await runner(name, args);
      }
      return null;
    },
  });
} catch {
  // Non-blocking in non-browser environments
}

// Live Tactical Zulu UTC Mission Clock
function startZuluClock() {
  const clockEl = document.getElementById('zulu-clock');
  if (!clockEl) return;
  const update = () => {
    const d = new Date();
    const h = String(d.getUTCHours()).padStart(2, '0');
    const m = String(d.getUTCMinutes()).padStart(2, '0');
    const s = String(d.getUTCSeconds()).padStart(2, '0');
    clockEl.textContent = `ZULU ${h}:${m}:${s}Z`;
  };
  update();
  setInterval(update, 1000);
}
if (typeof document !== 'undefined') {
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', startZuluClock);
  } else {
    startZuluClock();
  }
}

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
