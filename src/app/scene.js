import { releaseCameraVerbs } from '../cameraVerbs.js';
import { createApplicationOperations } from './operations.js';
import * as Cesium from 'cesium';
import {
  createApplicationViewer,
  installTrackpadPinchZoom,
} from '../app/viewer.js';
import { registerDataCredits } from '../data/dataCredits.js';
import { configureCreditKeyboardAccess } from '../creditKeyboard.js';
import { MapStackController } from '../mapStackController.js';
import { loadPhotorealisticTileset } from '../mapStartup.js';
import { initLogoGaze } from '../logoGaze.js';
import {
  uninstallRenderGovernor,
  governorRequestRender,
} from '../renderGovernor.js';
import { describeError } from './errors.js';
import { createSceneEngine } from './globeEngine.js';
import { onLocaleChange, t } from '../i18n/index.js';

/**
 * Construct the application globe using the caller's local configuration.
 * `engineKind` 'navara' builds the experimental Navara engine instead of the
 * Cesium viewer: the scene then has no viewer (`viewer: null`).
 */
export async function createApplicationScene({
  requestServices,
  googleApiKey,
  signal,
  defer,
  rendererCache,
  ...options
}) {
  const operations = createApplicationOperations({
    requests: requestServices,
    signal,
  });
  defer(initLogoGaze());
  const previousKey = window.__GOOGLE_MAPS_API_KEY__;
  if (googleApiKey) {
    window.__GOOGLE_MAPS_API_KEY__ = googleApiKey;
    defer(() => {
      if (window.__GOOGLE_MAPS_API_KEY__ !== googleApiKey) return;
      if (previousKey === undefined) delete window.__GOOGLE_MAPS_API_KEY__;
      else window.__GOOGLE_MAPS_API_KEY__ = previousKey;
    });
  }
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
  return { viewer, engine, tileset, mapStackController, operations };
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
  if (engineKind === 'navara')
    return (await import('./navaraMode.js')).createNavaraScene({
      container,
      cesiumToken,
      credits,
      MapController,
      mapOptions,
      loaderStatus,
      loadNavaraGlobe,
      signal,
      defer,
    });
  if (engineKind !== 'cesium')
    throw new TypeError(`Unknown globe engine: ${engineKind}`);
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
    releaseCameraVerbs(viewer);
    uninstallRenderGovernor(viewer);
    if (!viewer.isDestroyed()) viewer.destroy();
  });
  // The globe engine over this viewer; Google's startup tileset is named
  // once it loads.
  const tilesetRef = { current: null };
  const engine = createSceneEngine(viewer, { tilesetRef, defer });
  defer(installTrackpadPinchZoom(viewer));
  registerDataCredits(engine, credits);
  configureCreditKeyboardAccess(document);
  defer(onLocaleChange(() => configureCreditKeyboardAccess(document)));
  loaderStatus.textContent =
    googleApiKey || googleTokens || cesiumToken
      ? t('Loading Google 3D Tiles...')
      : t('Loading the keyless globe...');
  const photoreal = await loadPhotorealisticTileset(Cesium, {
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

  const mapStackController = new MapController(viewer, {
    requestRender: governorRequestRender,
    // Map sources reach the scene through the globe engine's maps.
    engine,
    ...mapOptions,
    googleTileset: tileset,
    cesiumToken,
    initialStack: tileset ? 'photoreal' : 'esri-imagery',
    // Task 5 (height-datum fix): rebroadcast stack changes as a window
    // CustomEvent so data layers (CCTV per-regime ground resolution) can
    // react without coupling MapStackController to layer modules. Fires on
    // 'switching'/'ready'/'error'; listeners derive the surface regime from
    // live scene state, so intermediate emissions are harmless.
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
  return { viewer, engine, tileset, mapStackController };
}
