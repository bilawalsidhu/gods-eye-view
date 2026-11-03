import {
  createStandaloneApplication,
  pageEngineKind,
} from './standalone/application.js';
import { createRendererCache } from './standalone/rendererCache.js';
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
const renderers = createRendererCache();
const layerSession = { lifetime: new AbortController() };
window.addEventListener('pagehide', (event) => {
  if (event.persisted) return;
  layerSession.lifetime.abort();
  void application?.destroy().catch(report).finally(() => renderers.clear());
});

async function start(next, engineSwitch = false, cockpit = null) {
  kind = next;
  layerSession.restoringView = engineSwitch;
  application = createStandaloneApplication({
    googleApiKey: import.meta.env.GOOGLE_MAPS_API_KEY,
    cesiumToken: import.meta.env.CESIUM_ION_TOKEN,
    allowQaRegistration: import.meta.env.DEV,
    engineKind: next,
    rendererCache: renderers,
    layerSession,
    engineSwitch,
  });
  const { scene, controls } = await application.start();
  if (engineSwitch) {
    const style = controls.styleManager;
    await style.initialRestorePromise;
    layerSession.restoringView = false;
    for (const {module} of layerSession.manager.layers.values()) module.resumeViewport?.();
    if (layerSession.handoffLayers) layerSession.manager.layers.get('directions')?.module.resumeCamera?.();
    layerSession.director?.resumeScene();
    // Only resume the aircraft that actually survived the handoff. A history
    // entry may select a different subject, and a stale track may disappear.
    const target = style.getAircraftTrackingTarget();
    if (
      cockpit?.active &&
      target &&
      target?.id === cockpit.subject?.id &&
      target?.layerId === cockpit.subject?.layerId &&
      style.controlCockpit('enter').ok
    ) {
      style.cockpitView.setVisionMode(cockpit.visionMode);
    }
    await waitForGlobeFrame(scene.engine);
  }
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

// Keep the last visible frame while the first visit initializes the other renderer.
function keepGlobeFrame(engine) {
  const source = engine.host.canvas;
  const frame = document.createElement('canvas');
  frame.width = source.width;
  frame.height = source.height;
  if (!frame.width || !frame.height) return null;
  const context = frame.getContext('2d');
  if (!context) return null;
  context.drawImage(source, 0, 0);
  frame.className = 'engine-switch-frame';
  frame.setAttribute('aria-hidden', 'true');
  document.getElementById('cesiumContainer').append(frame);
  return frame;
}

// Hand off the visible globe only after the new camera has actually drawn.
function waitForGlobeFrame(engine) {
  if (document.hidden) return;
  return new Promise((resolve, reject) => {
    const finish = () => {
      remove();
      clearTimeout(timer);
      document.removeEventListener('visibilitychange', done);
    };
    const remove = engine.frames.postRender.addEventListener(done);
    const timer = setTimeout(() => {
      finish();
      reject(new Error('The globe did not draw a frame'));
    }, 8000);
    function done() {
      finish();
      resolve();
    }
    document.addEventListener('visibilitychange', done, { once: true });
    engine.render.request('engine-switch');
  });
}

// popstate can arrive again while an engine is starting. After teardown and
// after startup, read the actual address so the latest history entry wins.
async function reconcile(remember = false) {
  if (busy) return;
  busy = true;
  present();
  const previous = kind;
  let cover;
  let cockpit;
  const handoffHash = remember ? location.hash : null;
  try {
    while (pageEngineKind() !== kind) {
      cover ??= keepGlobeFrame(application.getComponents().scene.engine);
      cockpit = application
        .getComponents()
        .controls.styleManager.getCockpitState();
      const manager = application.getComponents().data.dataManager;
      layerSession.handoffLayers = location.hash === handoffHash
        ? new Map([...manager.layers].map(([id, entry]) => [
            id, { entry: entry.module.attachRenderer ? entry : null, enabled: manager.isEffectivelyEnabled(id) },
          ]))
        : null;
      if (layerSession.handoffLayers) {
        manager.layers.get('directions')?.module.suspendCamera?.();
        manager.layers.get('satellites')?.module.suspendCamera?.();
        layerSession.director?.suspendScene();
      }
      renderers.retain(kind);
      await application.destroy();
      await start(pageEngineKind(), true, cockpit);
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
      await start(previous, true, cockpit);
      application
        .getComponents()
        .controls.styleManager._showToast(describeError(error));
    } catch (recoveryError) {
      report(recoveryError);
    }
  } finally {
    layerSession.handoffLayers = null;
    cover?.remove();
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
