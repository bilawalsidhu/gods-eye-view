import {
  createStandaloneApplication,
  pageEngineKind,
} from './standalone/application.js';
import { createRendererCache } from './standalone/rendererCache.js';
import { describeError } from './standalone/errors.js';
import { createEngineAddress } from './standalone/engineSwitch.js';
import {
  DEFAULT_ENGINE_CHOICE,
  ENGINE_NAMES,
  ENGINE_STORAGE_KEY,
  engineOfChoice,
  resolveEngineKind,
} from './app/engineChoice.js';
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
let showingStartFailure = false;
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
  if (requestedEngineKind() !== engineSwitch.state().engine)
    application
      ?.getComponents()
      .controls?.styleManager?.shareLinkManager?.holdNavigation?.();
  void engineSwitch.reconcile();
});

function createApplication(kind, engineSwitch, transition) {
  session.count('applications');
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
  const existing = content.querySelector('.engine-switch-retry');
  if (existing) {
    existing.querySelector('button')?.focus();
    return;
  }
  const group = document.createElement('div');
  group.className = 'engine-switch-retry';
  group.setAttribute('role', 'group');
  const label = document.createElement('p');
  label.id = 'engine-switch-retry-label';
  label.textContent = t('Choose an engine to try again.');
  group.setAttribute('aria-labelledby', label.id);
  group.append(label);
  for (const [kind, name] of Object.entries(ENGINE_NAMES)) {
    const button = document.createElement('button');
    button.type = 'button';
    button.dataset.engine = kind;
    button.textContent = name;
    button.setAttribute('translate', 'no');
    button.addEventListener('click', () => {
      // The retry's progress replaces the error: no longer an alert.
      loading.querySelector('.loader-status').removeAttribute('role');
      select(kind);
    });
    group.append(button);
  }
  content.append(group);
  group.querySelector('button').focus();
}

function withdrawEngineRetry() {
  loading.querySelector('.engine-switch-retry')?.remove();
  if (!showingStartFailure) return;
  showingStartFailure = false;
  loading.classList.add('hidden');
}

function report(error, kind) {
  showingStartFailure = true;
  console.error("God's Eye View initialization failed:", error);
  const status = loading.querySelector('.loader-status');
  status.setAttribute('role', 'alert');
  status.textContent = kind
    ? t('Could not start {engine}: {message}', {
        engine: ENGINE_NAMES[kind] ?? kind,
        message: describeError(error),
      })
    : t('Error: {message}', { message: describeError(error) });
  loading.classList.remove('hidden');
}

// A globe that failed to start while another runs: say which one runs.
function showStartFailure(error, running) {
  const style = liveComponents()?.controls.styleManager;
  if (!style) return false;
  void Promise.resolve(style.initialRestorePromise).then(() => {
    if (signal.aborted || liveComponents()?.controls.styleManager !== style)
      return;
    style._showToast(
      t('Globe engine failed to start. Running {engine}: {message}', {
        engine: ENGINE_NAMES[running] ?? running,
        message: describeError(error),
      }),
      6000,
    );
  });
  return true;
}

function select(next) {
  if (engineSwitch) void engineSwitch.select(next);
  else if (!starting) void start(next, { rememberChoice: true });
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

let initialKind = pageEngineKind();
let starting = false;
const requestedEngineKind = () =>
  resolveEngineKind({ search: location.search, fallback: initialKind });

function remember(kind) {
  try {
    localStorage.setItem(ENGINE_STORAGE_KEY, kind);
  } catch {
    // The current URL still carries the choice when storage is blocked.
  }
}

async function start(kind, { fallback = false, rememberChoice = false } = {}) {
  starting = true;
  try {
    await createApplication(kind, false).start();
    if (rememberChoice) {
      initialKind = kind;
      remember(kind);
      createEngineAddress({ location, history }).restore(kind);
    }
    session.count('attachments');
    engineSwitch = createSceneSwitcher({
      kind,
      requested: requestedEngineKind,
      signal,
      getApplication: () => application,
      startApplication: (kind, transition) =>
        createApplication(kind, true, transition),
      layerSession,
      renderers,
      diagnostics: session,
      keepFrame: keepGlobeFrame,
      onSettled: withdrawEngineRetry,
      address: createEngineAddress({
        location,
        history,
        flush: () => {
          const live = liveComponents();
          // A pick made mid-flight hands over the flight's destination, as
          // if it had landed (Cesium's completeFlight), not a midpoint.
          live?.scene.engine.camera.completeFlight();
          live?.controls.styleManager.shareLinkManager?.flush();
        },
      }),
      remember,
      onChange: present,
      onFailure(error, { recovered, kind: running }) {
        if (recovered && showStartFailure(error, running)) return;
        report(error);
        offerEngineRetry();
      },
    });
    if (showingStartFailure)
      await liveComponents()?.controls.styleManager.initialRestorePromise;
    withdrawEngineRetry();
    present();
    // A history visit made while the first engine started.
    void engineSwitch.reconcile();
  } catch (error) {
    await application?.destroy().catch(report);
    if (fallback && kind !== DEFAULT_ENGINE_CHOICE) {
      // A stored choice that cannot start would fail on every visit.
      await start(DEFAULT_ENGINE_CHOICE, { rememberChoice: true });
      showStartFailure(error, DEFAULT_ENGINE_CHOICE);
    } else {
      report(error, kind);
      offerEngineRetry();
    }
  } finally {
    starting = false;
  }
}

void start(initialKind, {
  fallback: !new URLSearchParams(location.search).has('engine'),
});

export { application };
