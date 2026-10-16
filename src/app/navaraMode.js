// The experimental Navara mode (?engine=navara) of the application: its
// scene and its viewerless tools. src/app/scene.js and src/app/tools.js load
// this module with import() only in that mode, and it loads the Navara globe
// the same way, so the Cesium-mode bundle carries none of it.

import { DATA_CREDITS, registerDataCredits } from '../data/dataCredits.js';
import { isEmbeddedInline } from './embed.js';
import { createLayerAvailability } from './layers/renderers.js';
import {
  getRenderGovernorDiagnostics,
  governorRequestRender,
  installRenderGovernor,
  uninstallRenderGovernor,
} from '../renderGovernor.js';
import { initGevVoiceCommands } from '../voice/gevRealtime.js';

/** The Navara globe module, loaded on demand. */
const loadNavaraGlobeModule = async () =>
  (await import('../globe/navara/index.js')).createNavaraGlobe;

/**
 * The shell's notice in the experimental Navara mode (label and detail): the
 * data layers this engine shows (its catalog, from the renderer registry)
 * and what it does not have.
 * @param {import('./layers/renderers.js').LayerAvailability} availability
 */
export function navaraModeNotice(availability) {
  const names = availability.available().map(({ name }) => name);
  return Object.freeze({
    label: 'Experimental Navara engine',
    detail: names.length
      ? `Data layers: ${names.join(', ')}; the other layers, cockpit and director are unavailable`
      : 'No data layers on this engine yet; cockpit and director are unavailable',
  });
}

/**
 * Data credits for what the shell uses without data layers: place search,
 * its OpenStreetMap data and the keyless terrain. Navara lists every credit
 * in one attribution card, so layer credits would only crowd it.
 */
const SHELL_CREDIT_KEYS = new Set([
  'photon-geocoder',
  'openstreetmap',
  'reearth-terrain',
]);

/**
 * The scene on the experimental Navara engine: no viewer and no Cesium
 * objects. Navara builds the map sources from the controller's descriptions
 * (Google 3D tiles from the browser key, else base imagery) and shows their
 * credits in its own attribution UI.
 */
export async function createNavaraScene({
  operations,
  cesiumToken,
  credits,
  MapController,
  mapOptions,
  loaderStatus,
  loadNavaraGlobe = loadNavaraGlobeModule,
  signal,
  defer,
}) {
  loaderStatus.textContent = 'Loading the experimental Navara engine...';
  const createNavaraGlobe = await loadNavaraGlobe();
  signal.throwIfAborted();
  const globe = await createNavaraGlobe({
    container: document.getElementById('cesiumContainer'),
    // The cinematic look unless `?look=photoreal|minimal` asks otherwise.
    search: globalThis.location?.search ?? '',
  });
  defer(() => globe.destroy());
  const { engine } = globe;
  // The tools install the governor on this engine; it goes before the engine.
  defer(() => uninstallRenderGovernor(engine));
  signal.throwIfAborted();
  loaderStatus.textContent = 'Initializing systems...';
  const mapStackController = new MapController(null, {
    requestRender: governorRequestRender,
    engine,
    ...mapOptions,
    cesiumToken,
    onChange: (state) => {
      window.dispatchEvent(
        new CustomEvent('gev:map-stack-changed', { detail: state }),
      );
    },
    onError: (message) => console.warn('[MapStack]', message),
  });
  defer(() => mapStackController.destroy());
  await mapStackController.setStack(mapStackController.getActiveId(), {
    silent: true,
  });
  signal.throwIfAborted();
  // After the map's own credits, so Google's copyright lines come first in
  // Navara's attribution card.
  registerDataCredits(
    engine,
    (credits ?? DATA_CREDITS).filter(({ key }) => SHELL_CREDIT_KEYS.has(key)),
  );
  return {
    viewer: null,
    engine,
    tileset: null,
    mapStackController,
    operations,
  };
}

/**
 * The tools without a viewer (the experimental Navara engine): the startup
 * chrome, the render governor on the engine, hidden-tab handling, voice on
 * the engine and the debug handle. The shell shows which features are
 * unavailable.
 */
export function createViewerlessTools({
  scene: { engine, mapStackController, operations },
  controls: { styleManager },
  data,
  loadingScreen,
  placeSearch,
  voice = {},
  startChrome,
  signal,
  defer,
}) {
  const { dataManager } = data;
  // No first-run welcome: its choices turn on data layers.
  if (startChrome)
    defer(
      startChrome({
        loadingScreen,
        styleManager,
        dataManager,
        signal,
        initializeWelcome: null,
      }),
    );
  // Holds drive engine.render.setContinuous; requests go to the engine.
  installRenderGovernor(engine);
  const syncVisibility = () => {
    if (document.hidden && !isEmbeddedInline()) return;
    data.presentation.flushVisible();
    governorRequestRender('visibility-restore');
  };
  document.addEventListener('visibilitychange', syncVisibility);
  defer(() => document.removeEventListener('visibilitychange', syncVisibility));
  const notice = navaraModeNotice(
    data.catalog?.availability ?? createLayerAvailability('navara'),
  );
  styleManager._showGlobalStatusNotice?.(notice.label, {
    state: 'retry',
    detail: notice.detail,
    persistent: true,
  });
  window.__godsEyeView = {
    viewer: null,
    engine,
    styleManager,
    tileset: null,
    dataManager,
    sceneDirector: null,
    mapStackController,
    annotations: null,
    weatherEffects: null,
    cockpitCloudEffects: null,
    voiceCommands: null,
    getRenderGovernorDiagnostics,
    surfaceServices: operations.surface,
    requestRender: governorRequestRender,
  };
  const debug = window.__godsEyeView;
  defer(() => {
    if (window.__godsEyeView === debug) delete window.__godsEyeView;
  });
  // Voice on the engine (phase 3, Task 9): the W1 tools drive the engine;
  // the viewer-only ones (director, annotations, cockpit, radio…) refuse.
  const voiceCommands = initGevVoiceCommands({
    ...voice,
    annotationResolver: operations.annotationResolver,
    searchNavigation: operations.searchAndFlyTo,
    signal,
    placeSearch,
    viewer: null,
    engine,
    styleManager,
    dataManager,
    sceneDirector: null,
    annotations: null,
  });
  defer(() => {
    voiceCommands.stop({ removeUi: true });
    if (window.__gevVoiceCommands === voiceCommands)
      delete window.__gevVoiceCommands;
  });
  debug.voiceCommands = voiceCommands;
  return { sceneDirector: null, annotations: null, voiceCommands };
}
