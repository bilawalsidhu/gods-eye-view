import {
  createStandaloneApplication,
  pageEngineKind,
} from './standalone/application.js';
import { createRendererCache } from './standalone/rendererCache.js';
import { describeError } from './standalone/errors.js';
import {
  createEngineAddress,
  createEngineSwitch,
  handOffSession,
  resumeSession,
  waitForFirstFrame,
} from './standalone/engineSwitch.js';
import { ENGINE_STORAGE_KEY } from './app/engineChoice.js';
import { useDisplayStore } from './ui/stores/display.js';
import { applicationPinia } from './ui/vueRuntime.js';
import { t } from './i18n/index.js';

const display = useDisplayStore(applicationPinia());
const loading = document.getElementById('loading-screen');
let application;
let engineSwitch = null;
let cover = null;
let cockpit = null;
const renderers = createRendererCache();
const layerSession = { lifetime: new AbortController() };
const { signal } = layerSession.lifetime;
window.addEventListener('pagehide', (event) => {
  if (event.persisted) return;
  layerSession.lifetime.abort();
  void application
    ?.destroy()
    .catch(report)
    .finally(() => renderers.clear());
});

// Registered before any engine starts, so these run ahead of the running
// session's own share-link listeners. A history visit that changes the
// engine belongs to the switch: the outgoing engine must not start restoring
// that entry's share (and release the followed subject) just before it hands
// the session off. The incoming engine reads the entry's view as it starts.
let swallowedHash = null;
window.addEventListener('popstate', (event) => {
  if (!engineSwitch) return;
  swallowedHash = null;
  if (pageEngineKind() !== engineSwitch.state().engine) {
    event.stopImmediatePropagation();
    swallowedHash = location.hash;
  }
  void engineSwitch.reconcile();
});
window.addEventListener('hashchange', (event) => {
  // Back/Forward fires hashchange after popstate for the same entry.
  if (swallowedHash !== null && location.hash === swallowedHash)
    event.stopImmediatePropagation();
  swallowedHash = null;
});

function createApplication(kind, engineSwitch) {
  layerSession.restoringView = engineSwitch;
  application = createStandaloneApplication({
    googleApiKey: import.meta.env.GOOGLE_MAPS_API_KEY,
    cesiumToken: import.meta.env.CESIUM_ION_TOKEN,
    allowQaRegistration: import.meta.env.DEV,
    engineKind: kind,
    rendererCache: renderers,
    layerSession,
    engineSwitch,
  });
  return application;
}

function liveComponents() {
  return application?.getState().status === 'ready'
    ? application.getComponents()
    : null;
}

// Hand the session off and release the running engine. Its renderer is
// parked for a later switch back.
async function leave(from) {
  const components = liveComponents();
  if (components) {
    cover ??= keepGlobeFrame(components.scene.engine);
    cockpit = components.controls.styleManager.getCockpitState();
    handOffSession(layerSession);
    renderers.retain(from);
  }
  await application?.destroy();
}

// Start an engine on the retained session. Success means the engine runs
// with the session attached and the address's view restored; its first frame
// only decides when the cover goes (settle).
async function enter(kind) {
  const app = createApplication(kind, true);
  try {
    const { controls } = await app.start();
    signal.throwIfAborted();
    const style = controls.styleManager;
    await style.initialRestorePromise;
    signal.throwIfAborted();
    layerSession.restoringView = false;
    resumeSession(layerSession);
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
  } catch (error) {
    // pagehide owns the teardown once the lifetime is aborted.
    if (!signal.aborted)
      await app
        .destroy()
        .catch((cleanupError) =>
          console.error('A failed globe could not be released:', cleanupError),
        );
    throw error;
  }
}

async function settle() {
  const engine = liveComponents()?.scene.engine;
  if (cover && engine) await waitForFirstFrame(engine);
  // A page left without an engine keeps the last handoff for the next try.
  if (engine) {
    layerSession.handoffLayers = null;
    cockpit = null;
  }
  cover?.remove();
  cover = null;
}

function present() {
  const { kind, busy } = engineSwitch.state();
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
  void engineSwitch?.select(next);
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

const initialKind = pageEngineKind();
createApplication(initialKind, false)
  .start()
  .then(() => {
    engineSwitch = createEngineSwitch({
      kind: initialKind,
      requested: pageEngineKind,
      signal,
      leave,
      enter,
      settle,
      address: createEngineAddress({
        location,
        history,
        flush: () =>
          liveComponents()?.controls.styleManager.shareLinkManager?.flush(),
      }),
      remember(kind) {
        try {
          localStorage.setItem(ENGINE_STORAGE_KEY, kind);
        } catch {
          // The current URL still carries the choice when storage is blocked.
        }
      },
      onChange: present,
      onFailure(error, { recovered }) {
        const style = recovered && liveComponents()?.controls.styleManager;
        if (style) style._showToast(describeError(error));
        else report(error);
      },
    });
    present();
    // A history visit made while the first engine started.
    void engineSwitch.reconcile();
  })
  .catch(report);

export { application };
