import {
  createStandaloneApplication,
  pageEngineKind,
} from './standalone/application.js';
import { createRendererCache } from './standalone/rendererCache.js';
import { describeError } from './standalone/errors.js';
import { createEngineAddress } from './standalone/engineSwitch.js';
import { ENGINE_STORAGE_KEY, engineOfChoice } from './app/engineChoice.js';
import { createSceneSwitcher } from './standalone/sceneSwitcher.js';
import { createLayerSession } from './app/layerSession.js';
import { createSessionDiagnostics } from './app/sessionDiagnostics.js';
import { useDisplayStore } from './ui/stores/display.js';
import { applicationPinia } from './ui/vueRuntime.js';
import { t } from './i18n/index.js';
import { guardCesiumGlobal } from './app/loadCesium.js';

// Cesium.js loads with the first Cesium globe (src/app/loadCesium.js).
guardCesiumGlobal();

// The Vite boundary exposes only undefined, null, or a validated URL.
const photonSetting = import.meta.env.PHOTON_URL;
// Every engine start composes the same place-search endpoints.
const geospatial =
  photonSetting === undefined ? {} : { endpoints: { photon: photonSetting } };

const display = useDisplayStore(applicationPinia());
const loading = document.getElementById('loading-screen');
let application;
let engineSwitch = null;
// ?parkedMs= shortens how long a parked globe waits before it is released,
// so a QA scenario can switch back to a released one.
const renderers = createRendererCache({
  // Navara and Navara HD are one engine: only one of them stays parked.
  engineOf: engineOfChoice,
  parkedMs:
    Number(new URLSearchParams(location.search).get('parkedMs')) || undefined,
});
const layerSession = createLayerSession();
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

function createApplication(kind, engineSwitch, transition) {
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
    transition,
  });
  return application;
}

// The running application while a globe is attached to it; null while the
// page has no engine (between engines, or after a failed recovery).
function liveComponents() {
  if (application?.getState().status !== 'ready') return null;
  const components = application.getComponents();
  return components.scene?.engine ? components : null;
}

// The page's application is created once; a switch detaches and attaches
// only its engine-bound parts.

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
    ['navara-hd', 'Navara HD'],
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
    engineSwitch = createSceneSwitcher({
      kind: initialKind,
      requested: pageEngineKind,
      signal,
      getApplication: () => application,
      startApplication: (kind, transition) =>
        createApplication(kind, true, transition),
      layerSession,
      renderers,
      diagnostics: session,
      keepFrame: keepGlobeFrame,
      onSettled() {
        withdrawEngineRetry();
        loading.classList.add('hidden');
      },
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
