import { retainsLayerSession } from './layerSession.js';
import { createSceneServices } from '../data/sceneServices.js';
import { releaseCameraVerbs } from '../cameraVerbs.js';
import { createApplicationOperations } from './operations.js';
import {
  createApplicationViewer,
  installFreeLookHeightLimit,
  installTrackpadPinchZoom,
  loadCesiumPhotorealTileset,
} from '../globe/cesium/viewer.js';
import { registerDataCredits } from '../data/dataCredits.js';
import { configureCreditKeyboardAccess } from '../creditKeyboard.js';
import { MapStackController } from '../mapStackController.js';
import { initLogoGaze } from '../logoGaze.js';
import { describeError } from './errors.js';
import { createSceneEngine } from './globeEngine.js';
import { worldClock, worldTimeFor } from '../time/worldClock.js';
import { followWorldTime } from '../globe/cesium/worldTime.js';
import { onLocaleChange, t } from '../i18n/index.js';
import { loadCesium } from './loadCesium.js';

/**
 * Construct the application globe using the caller's local configuration.
 * `engineKind` 'navara' or 'navara-hd' (the page's engine choice,
 * src/app/engineChoice.js) builds the experimental Navara engine instead of
 * the Cesium viewer: the scene then has no viewer (`viewer: null`).
 */
export async function createApplicationScene({
  requestServices,
  googleApiKey,
  signal,
  defer,
  rendererCache,
  layerSession,
  ...options
}) {
  const operations =
    layerSession?.operations ??
    createApplicationOperations({
      requests: requestServices,
      signal: layerSession?.lifetime.signal ?? signal,
    });
  if (layerSession) layerSession.operations = operations;
  // The logo's gaze and the page's Google key belong to the page session
  // when there is one: an engine switch keeps them.
  const pageChrome = layerSession ? (layerSession.chrome ??= {}) : null;
  const own = pageChrome
    ? (release) =>
        layerSession.lifetime.signal.addEventListener('abort', release, {
          once: true,
        })
    : defer;
  if (!pageChrome?.sceneChrome) {
    if (pageChrome) pageChrome.sceneChrome = true;
    own(initLogoGaze());
    const previousKey = window.__GOOGLE_MAPS_API_KEY__;
    if (googleApiKey) {
      window.__GOOGLE_MAPS_API_KEY__ = googleApiKey;
      own(() => {
        if (window.__GOOGLE_MAPS_API_KEY__ !== googleApiKey) return;
        if (previousKey === undefined) delete window.__GOOGLE_MAPS_API_KEY__;
        else window.__GOOGLE_MAPS_API_KEY__ = previousKey;
      });
    }
  }
  // A cached renderer is built once, by the first application that asks for
  // its engine, and later applications reuse it warm. Everything this closure
  // captures from that application (its abort signal, the loader status
  // element, Navara's `?look=` read from location.search) is read only while
  // the renderer is being built; nothing in the built scene keeps using it.
  // A changed `?look=` therefore applies to a renderer built after it.
  const build = (resources) =>
    createRenderer({
      ...options,
      googleApiKey,
      signal,
      ...resources,
    });
  const { viewer, engine, tileset, mapStackController } = rendererCache
    ? await rendererCache.acquire(options.engineKind, build, defer)
    : await build({ defer });
  defer(
    worldClock.setFrameScheduler(
      globalThis.requestAnimationFrame?.bind(globalThis),
      globalThis.cancelAnimationFrame?.bind(globalThis),
    ),
  );
  defer(worldClock.subscribe(() => engine.render.request('world-time')));
  const services = createSceneServices(engine, {
    retainedSelection: layerSession?.handoff?.selection,
  });
  if (layerSession?.handoff) layerSession.handoff.selection = null;
  defer(() => {
    const retained = services.destroy({
      retainSelection: retainsLayerSession(layerSession),
    });
    if (layerSession?.handoff) layerSession.handoff.selection = retained;
  });
  if (layerSession) {
    // DEM cells belong to the session. Mesh samples came from the outgoing
    // scene, including when the incoming canvas was warm in the cache.
    operations.surface.groundFloor.clearMeshFloorCells();
    operations.surface.groundFloor.setMeshFloorPreferred(
      mapStackController.getActiveId() === 'photoreal',
    );
  }
  return {
    viewer,
    engine,
    tileset,
    mapStackController,
    operations,
    services,
  };
}

async function createRenderer({
  googleApiKey,
  googleTokens = null,
  cesiumToken,
  credits,
  MapController = MapStackController,
  mapOptions = {},
  loaderStatus,
  engineKind = 'cesium',
  loadNavaraGlobe,
  signal,
  defer,
  container,
}) {
  // The Navara mode's own code loads only in that mode, with Navara itself,
  // so the Cesium-mode bundle carries none of it.
  if (engineKind === 'navara' || engineKind === 'navara-hd') {
    const scene = await (
      await import('./navaraMode.js')
    ).createNavaraScene({
      container,
      cesiumToken,
      credits,
      MapController,
      mapOptions,
      loaderStatus,
      loadNavaraGlobe,
      hd: engineKind === 'navara-hd',
      signal,
      defer,
    });
    // As the Cesium scene below: a parked or released engine keeps no camera
    // verb running on it (a Directions flight is parked before this).
    const { engine } = scene;
    defer(() => releaseCameraVerbs(engine));
    const suspend = scene.suspend;
    scene.suspend = () => {
      releaseCameraVerbs(engine);
      suspend();
    };
    return scene;
  }
  if (engineKind !== 'cesium')
    throw new TypeError(`Unknown globe engine: ${engineKind}`);
  await loadCesium();
  signal.throwIfAborted();
  loaderStatus.textContent = t('Configuring viewer...');
  // Provider attribution stays visible, including clean-view and recording.
  const creditContainer = document.createElement('div');
  creditContainer.id = 'cesium-credits';
  (container ?? document.body).appendChild(creditContainer);
  defer(() => creditContainer.remove());
  const viewer = createApplicationViewer({
    container: container ?? 'cesiumContainer',
    creditContainer,
  });
  defer(() => {
    if (!viewer.isDestroyed()) viewer.destroy();
  });
  // The globe engine over this viewer; Google's startup tileset is named
  // once it loads.
  const tilesetRef = { current: null };
  const engine = createSceneEngine(viewer, { tilesetRef, defer });
  // As the Navara scene above: a released engine keeps no camera verb.
  defer(() => releaseCameraVerbs(engine));
  defer(installTrackpadPinchZoom(viewer));
  defer(followWorldTime(viewer, worldTimeFor('sky')));
  defer(installFreeLookHeightLimit(viewer));
  registerDataCredits(engine, credits);
  configureCreditKeyboardAccess(document);
  defer(onLocaleChange(() => configureCreditKeyboardAccess(document)));
  loaderStatus.textContent =
    googleApiKey || googleTokens || cesiumToken
      ? t('Loading Google 3D Tiles...')
      : t('Loading the keyless globe...');
  const photoreal = await loadCesiumPhotorealTileset({
    googleApiKey,
    googleTokens,
    cesiumToken,
  });
  const tileset = photoreal.tileset;
  tilesetRef.current = tileset;
  // A provider can finish after cancellation; retain ownership of its result.
  defer(() => {
    if (tileset && !tileset.isDestroyed()) {
      if (!viewer.scene.primitives.remove(tileset)) tileset.destroy();
    }
  });
  signal.throwIfAborted();
  if (tileset) {
    viewer.scene.primitives.add(tileset);
    // NOTE: Cesium World Terrain intentionally disabled — conflicts with Google 3D Tiles at high zoom.
    // Google Photorealistic 3D Tiles provide their own terrain/elevation.
    viewer.scene.globe.show = false;
    console.info(`[Init] Google 3D Tiles loaded via ${photoreal.route}.`);
  } else {
    if (photoreal.errors.length) {
      const tileError = photoreal.errors.at(-1);
      console.warn(
        '[Init] Google 3D Tiles unavailable, using the keyless globe:',
        tileError,
      );
      const tileErrorDetail = describeError(tileError);
      loaderStatus.textContent = t(
        'Google 3D Tiles unavailable ({detail}). Loading the keyless globe...',
        {
          detail: tileErrorDetail,
        },
      );
    }
    viewer.scene.globe.show = true;
  }

  loaderStatus.textContent = t('Initializing systems...');

  const mapStackController = new MapController({
    requestRender: (reason) => engine.render.request(reason),
    // Map sources reach the scene through the globe engine's maps.
    engine,
    ...mapOptions,
    googleTileset: tileset,
    cesiumToken,
    initialStack: tileset ? 'photoreal' : 'esri-imagery',
    // Rebroadcast stack changes as a window CustomEvent so data layers (CCTV
    // per-regime ground resolution) can react without coupling
    // MapStackController to layer modules. Fires on 'switching'/'ready'/
    // 'error'; listeners derive the surface regime from live scene state, so
    // intermediate emissions are harmless.
    onChange: (state) => {
      window.dispatchEvent(
        new CustomEvent('gev:map-stack-changed', { detail: state }),
      );
    },
    onError: (message) => console.warn('[MapStack]', message),
  });
  defer(() => mapStackController.destroy());
  await mapStackController.setStack(tileset ? 'photoreal' : 'esri-imagery', {
    silent: true,
  });

  signal.throwIfAborted();
  return {
    viewer,
    engine,
    tileset,
    mapStackController,
    suspend() {
      engine.camera.cancelFlight();
      releaseCameraVerbs(engine);
      viewer.useDefaultRenderLoop = false;
    },
    resume() {
      viewer.useDefaultRenderLoop = !document.hidden;
    },
  };
}
