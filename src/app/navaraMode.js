// The experimental Navara mode (?engine=navara) of the application: its
// scene and its viewerless tools. src/app/scene.js and src/app/tools.js load
// this module with import() only in that mode, and it loads the Navara globe
// the same way, so the Cesium-mode bundle carries none of it.

import { DATA_CREDITS, registerDataCredits } from '../data/dataCredits.js';
import { isEmbeddedInline } from './embed.js';
import {
  getRenderGovernorDiagnostics,
  governorRequestRender,
  installRenderGovernor,
  uninstallRenderGovernor,
} from '../renderGovernor.js';

/** The Navara globe module, loaded on demand. */
const loadNavaraGlobeModule = async () =>
  (await import('../globe/navara/index.js')).createNavaraGlobe;

/** The shell's notice in the experimental Navara mode (label and detail). */
export const NAVARA_MODE_NOTICE = Object.freeze({
  label: 'Experimental Navara engine',
  detail: 'Layers, cockpit, director and voice are unavailable',
});

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
 * chrome, the render governor on the engine, hidden-tab handling and the
 * debug handle. The shell shows which features are unavailable.
 */
export function createViewerlessTools({
  scene: { engine, mapStackController, operations },
  controls: { styleManager },
  data,
  loadingScreen,
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
  styleManager._showGlobalStatusNotice?.(NAVARA_MODE_NOTICE.label, {
    state: 'retry',
    detail: NAVARA_MODE_NOTICE.detail,
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
  return { sceneDirector: null, annotations: null, voiceCommands: null };
}
