import {
  createStandaloneApplication,
  pageEngineKind,
} from './standalone/application.js';
import { describeError } from './standalone/errors.js';
import { ENGINE_STORAGE_KEY } from './app/engineChoice.js';
import { useDisplayStore } from './ui/stores/display.js';
import { applicationPinia } from './ui/vueRuntime.js';
import { t } from './i18n/index.js';

const display = useDisplayStore(applicationPinia());
const loading = document.getElementById('loading-screen');
let kind = pageEngineKind();
let application;
let busy = false;

async function start(next) {
  kind = next;
  application = createStandaloneApplication({
    googleApiKey: import.meta.env.GOOGLE_MAPS_API_KEY,
    cesiumToken: import.meta.env.CESIUM_ION_TOKEN,
    allowQaRegistration: import.meta.env.DEV,
    engineKind: next,
  });
  await application.start();
}

function present() {
  display.presentGlobeEngine({ kind, busy, select });
}

function report(error) {
  console.error("God's Eye View initialization failed:", error);
  loading.querySelector('.loader-status').textContent = t('Error: {message}', {
    message: describeError(error),
  });
  loading.classList.remove('hidden');
}

function select(next) {
  if (busy || kind === next || !['cesium', 'navara'].includes(next)) return;
  application.getComponents().controls.styleManager.shareLinkManager.flush();
  const url = new URL(location.href);
  url.searchParams.set('engine', kind);
  history.replaceState(history.state, '', url);
  url.searchParams.set('engine', next);
  history.pushState(null, '', url);
  void reconcile(true);
}

// popstate can arrive again while an engine is starting. After teardown and
// after startup, read the actual address so the latest history entry wins.
async function reconcile(remember = false) {
  if (busy) return;
  busy = true;
  present();
  const previous = kind;
  try {
    while (pageEngineKind() !== kind) {
      loading.classList.remove('hidden');
      await application.destroy();
      await start(pageEngineKind());
    }
    if (remember) {
      try {
        localStorage.setItem(ENGINE_STORAGE_KEY, kind);
      } catch {
        // The current URL still carries the choice when storage is blocked.
      }
    }
  } catch (error) {
    // Keep a failed renderer from stranding a previously working session.
    const url = new URL(location.href);
    url.searchParams.set('engine', previous);
    history.replaceState(history.state, '', url);
    try {
      await application.destroy();
      await start(previous);
      application
        .getComponents()
        .controls.styleManager._showToast(describeError(error));
    } catch (recoveryError) {
      report(recoveryError);
    }
  } finally {
    busy = false;
    present();
  }
}

start(kind)
  .then(() => {
    present();
    window.addEventListener('popstate', () => void reconcile());
    void reconcile();
  })
  .catch(report);

export { application };
