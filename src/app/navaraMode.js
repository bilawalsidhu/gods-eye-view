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
  governorRequestRender,
  installRenderGovernor,
  uninstallRenderGovernor,
} from '../renderGovernor.js';
import { attachSessionVoice } from './sessionVoice.js';
import { initNavaraImageryBoxTool } from '../ui/imageryBoxNavara.js';
import {
  attachNavaraAnnotations,
  attachNavaraDraw,
  attachNavaraGeoImport,
  attachNavaraScopeMask,
} from './navaraTools.js';
import { createRecentImageryPanel } from '../ui/recentImagery.js';

/**
 * An imported file's data source drawn on `engine` (UTILITIES ▸ Import); the
 * drawing loads on first use, like the layers' Navara renderers.
 */
async function drawImported(engine, dataSource) {
  const { drawImportedSource, measureImportImages } =
    await import('../layers/shared/render/navaraStory.js');
  const sizes = await measureImportImages(dataSource);
  return drawImportedSource(engine, engine.extensions.navara, dataSource, {
    sizes,
  });
}

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
      ? `Data layers: ${names.join(', ')}`
      : 'No registered data layers',
  });
}

/** Static attribution for the shell and the layers available on Navara. */
const NAVARA_CREDIT_KEYS = new Set([
  'inaturalist',
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
          ...engine.extensions.navara,
        });
    },
    transit: async () =>
      (await import('../layers/transit/render/display.js'))
        .createTransitDisplay,
    // CCTV's display, with the Navara backend of its plane and volume.
    cctv: async () => {
      const [{ createCctvDisplay }, { createCctvNavaraMeshes }] =
        await Promise.all([
          import('../layers/cctv/render/display.js'),
          import('../layers/cctv/render/navaraMeshes.js'),
        ]);
      return (engine, options) =>
        createCctvDisplay(engine, {
          ...options,
          navaraMeshes: createCctvNavaraMeshes,
        });
    },
    'alpr-cameras': async () =>
      (await import('../layers/alpr/render/display.js')).createAlprDisplay,
    radio: async () =>
      (await import('../layers/radio/render/display.js')).createRadioDisplay,
    bikeshare: async () =>
      (await import('../layers/bikeshare/render/display.js'))
        .createBikeshareDisplay,
    ...Object.fromEntries(
      ['weather-radar', 'weather-satellite', 'weather-lightning'].map((id) => [
        id,
        async () => {
          const { createWeatherNavaraRenderer } =
            await import('../layers/weather/render/navara.js');
          return (engine, options) =>
            createWeatherNavaraRenderer(
              engine,
              engine.extensions.navara,
              options,
            );
        },
      ]),
    ),
    'bhote-koshi-2026': async () => {
      const { createNepalEventDisplay } =
        await import('../layers/bhoteKoshi/render/navara.js');
      return (engine) =>
        createNepalEventDisplay(engine, engine.extensions.navara);
    },
    'bhote-koshi-locator': async () => {
      const { drawStorySource } =
        await import('../layers/shared/render/navaraStory.js');
      return (engine, { data }) =>
        drawStorySource(engine, engine.extensions.navara, data);
    },
    'street-level': async () => {
      const { createStreetMap } =
        await import('../layers/streetLevel/render/navara.js');
      return (engine) => createStreetMap(engine, engine.extensions.navara);
    },
    traffic: async () => {
      const { createTrafficNavaraRenderer } =
        await import('../layers/traffic/render/navara.js');
      return (engine) =>
        createTrafficNavaraRenderer(engine, engine.extensions.navara);
    },
    directions: async () => {
      const { createDirectionsNavaraRenderer } =
        await import('../layers/directions/render/navara.js');
      return (engine) =>
        createDirectionsNavaraRenderer(engine, engine.extensions.navara);
    },
    'telegeography-submarine-cables': async () =>
      (await import('../layers/submarineCables/render/display.js'))
        .createCablesDisplay,
    wind: async () => {
      const { createWindNavaraRenderer } =
        await import('../layers/wind/render/navara.js');
      return (engine) =>
        createWindNavaraRenderer(engine, engine.extensions.navara);
    },
    'weather-cyclones': async () =>
      (await import('../layers/cyclones/render/display.js'))
        .createCyclonesDisplay,
    ...Object.fromEntries(
      ['local-datacenters', 'local-dams'].map((id) => [
        id,
        async () => {
          const { createInfrastructureNavaraRenderer } =
            await import('../layers/infrastructure/render/navara.js');
          return (engine, { config, services }) =>
            createInfrastructureNavaraRenderer(
              engine,
              engine.extensions.navara,
              config,
              services,
            );
        },
      ]),
    ),
    's2-ghostmaps': async () =>
      (await import('../layers/ghostMaps/render/display.js'))
        .createGhostMapsDisplay,
    'military-awareness': async () => {
      const { createAwarenessNavaraRenderer } =
        await import('../layers/awareness/render/navara.js');
      return (engine) =>
        createAwarenessNavaraRenderer(engine, engine.extensions.navara);
    },
    'military-installations': async () => {
      const { createInstallationsNavaraRenderer } =
        await import('../layers/installations/render/navara.js');
      return (engine, options) =>
        createInstallationsNavaraRenderer(engine, {
          ...options,
          ...engine.extensions.navara,
        });
    },
    // The FIRMS display, with the Navara backend of its heatmap.
    'local-firms': async () => {
      const [{ createFirmsDisplay }, { createFirmsHeatDrape }] =
        await Promise.all([
          import('../layers/firms/render/display.js'),
          import('../layers/firms/render/navaraHeat.js'),
        ]);
      return (engine, options) =>
        createFirmsDisplay(engine, {
          ...options,
          navaraHeat: createFirmsHeatDrape,
        });
    },
    'osm-places': async () =>
      (await import('../layers/osmPlaces/render/display.js'))
        .createOsmPlacesDisplay,
    // Draws itself through the globe contract (engine.movers, engine.lines).
    'wildlife-sightings': async () => () => null,
    'drone-airspace': async () =>
      (await import('../layers/droneAirspace/render/display.js'))
        .createDroneAirspaceDisplay,
    'fire-perimeters': async () =>
      (await import('../layers/perimeters/render/display.js'))
        .createPerimetersDisplay,
    'gnss-integrity': async () =>
      (await import('../layers/gnss/render/display.js')).createGnssDisplay,
    'air-quality': async () =>
      (await import('../layers/airQuality/render/display.js'))
        .createAirQualityDisplay,
    earthquakes: async () =>
      (await import('../layers/earthquakes/render/display.js'))
        .createEarthquakesDisplay,
    // The same displays as on Cesium (renderers.js).
    'rocket-launches': async () =>
      (await import('../layers/launches/render/display.js'))
        .createLaunchesDisplay,
    satellites: async () =>
      (await import('../layers/satellites/render/display.js'))
        .createSatellitesDisplay,
    // The aircraft family: the same displays as on Cesium (renderers.js).
    flights: async () =>
      (await import('../layers/flights/render/display.js'))
        .createFlightsDisplay,
    military: async () =>
      (await import('../layers/military/render/display.js'))
        .createMilitaryDisplay,
    'local-adsb': async () =>
      (await import('../layers/localAdsb/render/display.js'))
        .createLocalAdsbDisplay,
    'ais-live-vessels': async () =>
      (await import('../layers/vessels/render/display.js'))
        .createVesselsDisplay,
    // The open map overlays drape themselves through engine.maps.addOverlay.
    'sea-marks': async () => () => null,
    'ski-pistes': async () => () => null,
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
  hd = false,
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
    // Navara HD: the device pixel ratio and MSAA (viewOptions.js).
    hd,
  });
  defer(() => globe.destroy());
  const { engine } = globe;
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
  let packRenderer;
  const { createNavaraPackRenderer } =
    await import('../scenes/dataPacks/navara.js');
  const packGraphics = () =>
    (packRenderer ??= createNavaraPackRenderer(
      engine,
      engine.extensions.navara,
    ));
  return {
    viewer: null,
    engine,
    packRenderer: {
      geometry: (...args) => packGraphics().geometry(...args),
      image: (...args) => packGraphics().image(...args),
      media: (...args) => packGraphics().media(...args),
    },
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
 * The tools without a viewer (the experimental Navara engine), attached to
 * one Navara scene: the render governor, hidden-tab handling, imagery box,
 * engine notice, annotations, Draw, Import, scope mask and voice. The shared
 * tools keep their session state across engines. Returns the annotation
 * board (null without a Navara view) and voice commands.
 */
export function attachViewerlessTools(
  { engine, mapStackController = null },
  {
    data,
    operations,
    placeSearch,
    voice = {},
    sceneDirector,
    layerSession = null,
    styleManager,
  },
  { signal, defer },
) {
  const { dataManager } = data;
  void styleManager.initialRestorePromise?.then(() => {
    if (!signal.aborted) engine.extensions.navara.alignDaylightToRestoredView();
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
  // Holds drive engine.render.setContinuous; requests go to the engine. A
  // parked engine uninstalls it (createNavaraScene suspend).
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
  // The notice is this engine's: it goes when the engine does.
  defer(() => styleManager._clearPersistentStatusNotice?.());
  // The page session's annotation board, Draw and Import on this engine
  // (src/app/navaraTools.js).
  const tools = {
    engine,
    views: engine.extensions?.navara,
    mapStackController,
  };
  const context = {
    operations,
    placeSearch,
    layerSession,
    styleManager,
    drawImported,
  };
  const annotations = attachNavaraAnnotations(tools, context, {
    signal,
    defer,
  });
  attachNavaraDraw(tools, { ...context, annotations }, { signal, defer });
  attachNavaraGeoImport(tools, context, { signal, defer });
  attachNavaraScopeMask(tools, context, { signal, defer });
  // Voice uses the engine and shared session services; each action checks
  // the capabilities it needs on the attached scene.
  const voiceCommands = attachSessionVoice({
    layerSession,
    voice,
    operations,
    placeSearch,
    dataManager,
    scene: {
      viewer: null,
      engine,
      styleManager,
      sceneDirector,
      annotations,
    },
    signal,
    defer,
  });
  return { annotations, voiceCommands };
}
