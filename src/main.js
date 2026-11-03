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
import { createSessionDiagnostics } from './app/sessionDiagnostics.js';
import { useDisplayStore } from './ui/stores/display.js';
import { applicationPinia } from './ui/vueRuntime.js';
import { t } from './i18n/index.js';

// The Vite boundary exposes only undefined, null, or a validated URL.
const photonSetting = import.meta.env.PHOTON_URL;
// Every engine start composes the same place-search endpoints.
const geospatial =
  photonSetting === undefined ? {} : { endpoints: { photon: photonSetting } };

const display = useDisplayStore(applicationPinia());
const loading = document.getElementById('loading-screen');
let application;
let engineSwitch = null;
let cover = null;
let cockpit = null;
const renderers = createRendererCache();
const layerSession = { lifetime: new AbortController() };
const { signal } = layerSession.lifetime;
// Which session objects this page holds now (scripts/qa-app-once.mjs).
const session = createSessionDiagnostics(() => {
  const components = application?.getComponents?.() ?? {};
  const style = components.controls?.styleManager;
  return {
    application,
    shell: style,
    shareLink: style?.shareLinkManager,
    hud: style?.hud,
    navigation: style?._navigation,
    placeSearch: style?.placeSearch,
    dataManager: components.data?.dataManager,
    voice: layerSession.voice?.commands ?? components.tools?.voiceCommands,
    annotations: layerSession.annotations ?? components.tools?.annotations,
    geoImport: window.__gevGeoImport,
    drawTool: window.__gevDrawTool,
  };
});
window.__gevSession = session;
window.addEventListener('pagehide', (event) => {
  if (event.persisted) return;
  layerSession.lifetime.abort();
  void application
    ?.destroy()
    .catch(report)
    .finally(() => renderers.clear());
});

// Registered before any engine starts, so it runs ahead of the session's own
// share-link listeners. A history visit that changes the engine belongs to
// the switch: the outgoing engine's share link neither restores that entry
// (releasing the followed subject just before the handoff) nor writes its
// own view onto it. The incoming engine reads the entry as it starts, and
// settle() hands the address back to whichever engine then runs.
window.addEventListener('popstate', () => {
  if (!engineSwitch) return;
  if (pageEngineKind() !== engineSwitch.state().engine)
    application
      ?.getComponents()
      .controls?.styleManager?.shareLinkManager?.holdNavigation?.();
  void engineSwitch.reconcile();
});

function createApplication(kind, engineSwitch) {
  session.count('applications');
  layerSession.restoringView = engineSwitch;
  application = createStandaloneApplication({
    googleApiKey: import.meta.env.GOOGLE_MAPS_API_KEY,
    cesiumToken: import.meta.env.CESIUM_ION_TOKEN,
    geospatial,
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
    handOffSession(layerSession, {
      addressLayerIds:
        components.controls.styleManager.shareLinkManager?.currentLayerState?.()
          ?.enabledLayerIds,
    });
    renderers.retain(from);
  }
  await application?.destroy();
  session.count('detaches');
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
    session.count('attachments');
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
  const components = liveComponents();
  try {
    if (cover && components) await waitForFirstFrame(components.scene.engine);
  } finally {
    cover?.remove();
    cover = null;
  }
  // A page left without an engine keeps the last handoff for the next try.
  if (!components) return;
  layerSession.handoffLayers = null;
  cockpit = null;
  withdrawEngineRetry();
  // The running engine owns the address again, including an entry visited
  // before its share link listened or while it was held.
  components.controls.styleManager.shareLinkManager?.resumeNavigation?.();
}

// Voice calls made while the engines switch wait for the next engine
// (src/voice/sceneRunner.js); a settled switch lets them look again.
layerSession.switching = () => engineSwitch?.state().busy === true;

function present() {
  const { kind, busy } = engineSwitch.state();
  if (!busy) layerSession.voice?.runner.wake();
  display.presentGlobeEngine({ kind, busy, select });
  for (const button of loading.querySelectorAll('.engine-switch-retry button'))
    button.disabled = busy;
}

// No engine runs after a failed recovery. The error stays on the loading
// screen with an engine picker, so a new attempt needs no reload.
function offerEngineRetry() {
  const content = loading.querySelector('.loader-content') ?? loading;
  if (content.querySelector('.engine-switch-retry')) return;
  const group = document.createElement('div');
  group.className = 'engine-switch-retry';
  group.setAttribute('role', 'group');
  group.setAttribute('aria-label', t('Globe Engine'));
  for (const [kind, name] of [
    ['cesium', 'Cesium'],
    ['navara', 'Navara'],
  ]) {
    const button = document.createElement('button');
    button.type = 'button';
    button.dataset.engine = kind;
    button.textContent = name;
    button.setAttribute('translate', 'no');
    button.addEventListener('click', () => select(kind));
    group.append(button);
  }
  content.append(group);
}

function withdrawEngineRetry() {
  loading.querySelector('.engine-switch-retry')?.remove();
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
    session.count('attachments');
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
        if (style) return style._showToast(describeError(error));
        report(error);
        offerEngineRetry();
      },
    });
    present();
    // A history visit made while the first engine started.
    void engineSwitch.reconcile();
  })
  .catch(report);

export { application };
