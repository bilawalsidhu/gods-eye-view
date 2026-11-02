import { t } from '../i18n/index.js';
// The experimental Navara mode (?engine=navara) of the application: its
// scene and its viewerless tools. src/app/scene.js and src/app/tools.js load
// this module with import() only in that mode, and it loads the Navara globe
// the same way, so the Cesium-mode bundle carries none of it.

import { DATA_CREDITS, registerDataCredits } from '../data/dataCredits.js';
import { isEmbeddedInline } from './embed.js';
import {
  createLayerAvailability,
  layerAvailableOn,
  registerLayerRenderers,
} from './layers/renderers.js';
import {
  getRenderGovernorDiagnostics,
  governorRequestRender,
  installRenderGovernor,
  uninstallRenderGovernor,
} from '../renderGovernor.js';
import { initGevVoiceCommands } from '../voice/gevRealtime.js';
import { initNavaraImageryBoxTool } from '../ui/imageryBoxNavara.js';
import { createRecentImageryPanel } from '../ui/recentImagery.js';

// Native mesh capability stays at the composition boundary.
const navaraViews = new WeakMap();

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
    label: t('Experimental Navara engine'),
    detail: names.length
      ? `Data layers: ${names.join(', ')}; the other layers and director are unavailable`
      : 'No data layers on this engine yet; cockpit and director are unavailable',
  });
}

/** Static attribution for the shell and the layers available on Navara. */
const NAVARA_CREDIT_KEYS = new Set([
  'photon-geocoder',
  'openstreetmap',
  'reearth-terrain',
  'opensky',
  'adsblol',
  'adsbdb',
  'aisstream',
  'celestrak',
  'launch-library-2',
  'usgs',
  'eccc-aqhi',
  'wfigs',
  's2-ghostmaps',
  'telegeography',
  'wind-gfs',
  'ecmwf-ifs',
  'weather-noaa',
  'weather-lightning',
  'weather-cyclones',
  'dams',
  'firms',
  'gbfs',
  'overture-military-names',
  'radio-browser',
]);

/**
 * Registers the Navara layer renderers (once per page). Each loads only
 * here, through import(), so Cesium mode never fetches them.
 */
export async function registerNavaraLayerRenderers() {
  const loaders = {
    'recent-imagery': async () => {
      const { createRecentImageryNavaraRenderer } =
        await import('../layers/recentImagery/render/navara.js');
      return (engine, options) =>
        createRecentImageryNavaraRenderer(engine, {
          ...options,
          ...navaraViews.get(engine),
        });
    },
    transit: async () => {
      const { createTransitNavaraRenderer } =
        await import('../layers/transit/render/navara.js');
      return (engine, options) =>
        createTransitNavaraRenderer(engine, {
          ...options,
          ...navaraViews.get(engine),
        });
    },
    cctv: async () => {
      const { createCctvNavaraRenderer } =
        await import('../layers/cctv/render/navara.js');
      return (engine, options) =>
        createCctvNavaraRenderer(engine, {
          ...options,
          ...navaraViews.get(engine),
        });
    },
    'alpr-cameras': async () =>
      (await import('../layers/alpr/render/navara.js'))
        .createAlprNavaraRenderer,
    radio: async () =>
      (await import('../layers/radio/render/navara.js'))
        .createRadioNavaraRenderer,
    bikeshare: async () =>
      (await import('../layers/bikeshare/render/navara.js'))
        .createBikeshareNavaraRenderer,
    ...Object.fromEntries(['weather-radar', 'weather-satellite', 'weather-lightning'].map((id) => [
      id, async () => {
        const { createWeatherNavaraRenderer } = await import('../layers/weather/render/navara.js');
        return (engine, options) => createWeatherNavaraRenderer(engine, navaraViews.get(engine), options);
      },
    ])),
    'telegeography-submarine-cables': async () => {
      const { createNavaraCables } = await import('../layers/submarineCables/render/navara.js');
      return (engine, { overlayHost }) => createNavaraCables(engine, navaraViews.get(engine), overlayHost);
    },
    wind: async () => {
      const { createWindNavaraRenderer } = await import('../layers/wind/render/navara.js');
      return (engine) => createWindNavaraRenderer(engine, navaraViews.get(engine));
    },
    'weather-cyclones': async () => {
      const {createCyclonesNavaraRenderer} = await import('../layers/cyclones/render/navara.js');
      return (engine,options) => createCyclonesNavaraRenderer(engine,navaraViews.get(engine).view,options);
    },
    ...Object.fromEntries(['local-datacenters','local-dams'].map((id) => [
      id, async () => {
        const {createInfrastructureNavaraRenderer} = await import('../layers/infrastructure/render/navara.js');
        return (engine,{config,services}) => createInfrastructureNavaraRenderer(engine,navaraViews.get(engine),config,services);
      },
    ])),
    's2-ghostmaps': async () => {
      const { createGhostMapsNavaraRenderer } = await import('../layers/ghostMaps/render/navara.js');
      return (engine) => createGhostMapsNavaraRenderer(engine, navaraViews.get(engine).view);
    },
    'military-awareness': async () =>
      (await import('../layers/awareness/render/navara.js')).createAwarenessNavaraRenderer,
    'military-installations': async () => {
      const { createInstallationsNavaraRenderer } =
        await import('../layers/installations/render/navara.js');
      return (engine, options) =>
        createInstallationsNavaraRenderer(engine, {
          ...options,
          ...navaraViews.get(engine),
        });
    },
    'local-firms': async () => {
      const { createFirmsNavaraRenderer } =
        await import('../layers/firms/render/navara.js');
      return (engine, options) =>
        createFirmsNavaraRenderer(engine, {
          ...options,
          ...navaraViews.get(engine),
        });
    },
    'fire-perimeters': async () => {
      const { createPerimetersNavaraRenderer } = await import('../layers/perimeters/render/navara.js');
      return (engine) => createPerimetersNavaraRenderer(engine, navaraViews.get(engine));
    },
    'gnss-integrity': async () => {
      const { createGnssNavaraRenderer } = await import('../layers/gnss/render/navara.js');
      return (engine) => createGnssNavaraRenderer(engine, navaraViews.get(engine));
    },
    'air-quality': async () => {
      const { createAirQualityNavaraRenderer } =
        await import('../layers/airQuality/render/navara.js');
      return (engine) => createAirQualityNavaraRenderer(engine, navaraViews.get(engine));
    },
    earthquakes: async () => {
      const { createEarthquakesNavaraRenderer } =
        await import('../layers/earthquakes/render/navara.js');
      return (engine, options) =>
        createEarthquakesNavaraRenderer(engine, {
          ...options,
          ...navaraViews.get(engine),
        });
    },
    'rocket-launches': async () => {
      const { createLaunchesNavaraRenderer } =
        await import('../layers/launches/render/navara.js');
      return (engine, options) =>
        createLaunchesNavaraRenderer(engine, {
          ...options,
          ...navaraViews.get(engine),
        });
    },
    satellites: async () =>
      (await import('../layers/satellites/render/navara.js'))
        .createSatellitesNavaraRenderer,
    flights: async () =>
      (await import('../layers/flights/render/navara.js'))
        .createFlightsNavaraRenderer,
    military: async () =>
      (await import('../layers/military/render/navara.js'))
        .createMilitaryNavaraRenderer,
    'local-adsb': async () =>
      (await import('../layers/localAdsb/render/navara.js'))
        .createLocalAdsbNavaraRenderer,
    'ais-live-vessels': async () =>
      (await import('../layers/vessels/render/navara.js'))
        .createVesselsNavaraRenderer,
  };
  const missing = Object.keys(loaders).filter(
    (id) => !layerAvailableOn(id, 'navara'),
  );
  if (!missing.length) return;
  const factories = await Promise.all(missing.map((id) => loaders[id]()));
  // A concurrent call may have registered some meanwhile.
  const fresh = Object.fromEntries(
    missing
      .map((id, index) => [id, factories[index]])
      .filter(([id]) => !layerAvailableOn(id, 'navara')),
  );
  if (Object.keys(fresh).length) registerLayerRenderers('navara', fresh);
}

/**
 * The scene on the experimental Navara engine: no viewer and no Cesium
 * objects. Navara builds the map sources from the controller's descriptions
 * (Google 3D tiles from the browser key, else base imagery) and shows their
 * credits in its own attribution UI.
 */
export async function createNavaraScene({
  container = document.getElementById('cesiumContainer'),
  cesiumToken,
  credits,
  MapController,
  mapOptions,
  loaderStatus,
  loadNavaraGlobe = loadNavaraGlobeModule,
  signal,
  defer,
}) {
  loaderStatus.textContent = t('Loading the experimental Navara engine...');
  const createNavaraGlobe = await loadNavaraGlobe();
  signal.throwIfAborted();
  const globe = await createNavaraGlobe({
    container,
    // The cinematic look unless `?look=photoreal|minimal` asks otherwise.
    search: globalThis.location?.search ?? '',
  });
  defer(() => globe.destroy());
  const { engine } = globe;
  navaraViews.set(engine, {
    view: globe.view,
    alignDaylightToRestoredView: globe.alignDaylightToRestoredView,
    MeshDesc: globe.MeshDesc,
    EffectDesc: globe.EffectDesc,
    NavaraEffect: globe.NavaraEffect,
    DrapedMesh: globe.DrapedMesh,
    setupMaterialForDrape: globe.setupMaterialForDrape,
  });
  defer(() => navaraViews.delete(engine));
  // The layers drawn on Navara (their render/navara.js), before the catalog
  // asks the registry which layers this engine shows.
  await registerNavaraLayerRenderers();
  signal.throwIfAborted();
  // The tools install the governor on this engine; it goes before the engine.
  defer(() => uninstallRenderGovernor(engine));
  signal.throwIfAborted();
  loaderStatus.textContent = t('Initializing systems...');
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
    (credits ?? DATA_CREDITS).filter(({ key }) => NAVARA_CREDIT_KEYS.has(key)),
  );
  return {
    viewer: null,
    engine,
    tileset: null,
    suspend() {
      uninstallRenderGovernor(engine);
      engine.camera.cancelFlight();
      engine.render.setContinuous(false);
      globe.setRenderLoop(false);
    },
    resume() {
      globe.setRenderLoop(true);
    },
    mapStackController,
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
  void styleManager.initialRestorePromise?.then(() => {
    if (!signal.aborted)
      navaraViews.get(engine)?.alignDaylightToRestoredView?.();
  });
  const recentImagery = dataManager.layers.get('recent-imagery')?.module;
  if (recentImagery) {
    const tool = initNavaraImageryBoxTool({
      engine,
      onBox: (box) => recentImagery.setBox(box),
      onPreview: (box) => recentImagery.setBoxPreview(box),
      onCancel: (reason, message, box) => {
        if (message) recentImagery.reportBoxRefusal(message, box);
      },
      onActive: (active) => recentImagery.setToolActive(active),
      onEscape: () => recentImagery.clearPreview(),
    });
    data.presentation.attachRecentImagery((container) =>
      createRecentImageryPanel({
        container,
        engine,
        layer: recentImagery,
        tool,
      }),
    );
    const handle = { layer: recentImagery, tool };
    window.__gevRecentImagery = handle;
    defer(() => {
      if (window.__gevRecentImagery === handle)
        delete window.__gevRecentImagery;
      data.presentation.attachRecentImagery(null);
      tool.destroy();
    });
  }
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
  // the viewer-only ones (director, annotations…) refuse.
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
