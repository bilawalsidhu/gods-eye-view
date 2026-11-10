import { createApplicationOperations } from './operations.js';
// The application's composition root: it picks the Cesium renderer, and
// this is the only part of the adapter it imports.
import {
  applicationViewerHooks,
  cesiumRenderer,
  cesiumViewerOf,
  loadApplicationPhotoreal,
  releaseApplicationPhotoreal,
  showApplicationPhotoreal,
} from '../render/cesium/application.js';
import { registerDataCredits } from '../data/dataCredits.js';
import { configureCreditKeyboardAccess } from '../creditKeyboard.js';
import { MapStackController } from '../mapStackController.js';
import { initLogoGaze } from '../logoGaze.js';
import { inputFor } from '../input/dispatcher.js';
import {
  holdContinuousRender,
  installRenderGovernor,
  uninstallRenderGovernor,
  governorRequestRender,
} from '../renderGovernor.js';
import { describeError } from './errors.js';
import { FREE_LOOK_MAX_HEIGHT_METERS } from '../globeInView.js';
import { worldClock, worldTimeFor } from '../time/worldClock.js';
import { followWorldTime } from '../time/viewerClock.js';
import { onLocaleChange, t } from '../i18n/index.js';

/**
 * Construct the application globe using the caller's local configuration.
 * `renderer` is the `RendererPlugin` that draws it (default: Cesium). The
 * application still runs on the Cesium viewer until its layers are ported,
 * so a plugin whose renderer has none is refused.
 */
export async function createApplicationScene({
  renderer: rendererPlugin = cesiumRenderer,
  requestServices,
  googleApiKey,
  googleTokens = null,
  cesiumToken,
  credits,
  MapController = MapStackController,
  mapOptions = {},
  loaderStatus,
  signal,
  defer,
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
  loaderStatus.textContent = t('Configuring viewer...');
  // The scene still loads the tiles, so their credentials stay here.
  const renderer = await rendererPlugin.create({
    container: document.getElementById('cesiumContainer'),
    signal,
  });
  const viewer = cesiumViewerOf(renderer);
  if (!viewer) {
    const refusal = new Error(
      `The ${rendererPlugin.id} renderer cannot run the application yet`,
    );
    try {
      renderer.destroy();
    } catch (error) {
      console.warn('[Init] Refused renderer failed to destroy:', error);
    }
    throw refusal;
  }
  // The governor keeps its holds on the renderer's frame port. The loop
  // draws every frame until the application's tools are up (they release
  // 'boot'), as it did before anything could hold it.
  installRenderGovernor(renderer.frame);
  holdContinuousRender('boot');
  defer(() => {
    try {
      uninstallRenderGovernor(renderer.frame);
    } finally {
      renderer.destroy();
    }
  });
  // Before any layer binds a click: every layer and tool shares this one.
  // Deferred after the viewer, so it is released before the viewer goes.
  const input = inputFor(viewer);
  defer(() => input.destroy());
  // Ctrl+wheel and trackpad pinches zoom the globe, not the page.
  const { controls } = renderer.camera;
  if (!controls.zoomInputs.includes('ctrlWheel'))
    controls.zoomInputs = [...controls.zoomInputs, 'ctrlWheel'];
  defer(
    followWorldTime(viewer, worldTimeFor('sky'), {
      subscribe: worldClock.subscribe,
      requestRender: () => governorRequestRender('world-time'),
    }),
  );
  // What the adapter hands the application about its viewer; free look is
  // limited to low heights from the start.
  const viewerHooks = applicationViewerHooks(viewer);
  defer(viewerHooks.installFreeLookHeightLimit(FREE_LOOK_MAX_HEIGHT_METERS));
  registerDataCredits(viewer, credits);
  configureCreditKeyboardAccess(document);
  defer(onLocaleChange(() => configureCreditKeyboardAccess(document)));
  loaderStatus.textContent =
    googleApiKey || googleTokens || cesiumToken
      ? t('Loading Google 3D Tiles...')
      : t('Loading the keyless globe...');
  const photoreal = await loadApplicationPhotoreal({
    googleApiKey,
    googleTokens,
    cesiumToken,
  });
  const tileset = photoreal.tileset;
  // A provider can finish after cancellation; retain ownership of its result.
  defer(() => releaseApplicationPhotoreal(viewer, tileset));
  signal.throwIfAborted();
  if (tileset) {
    showApplicationPhotoreal(viewer, tileset);
    // NOTE: Cesium World Terrain intentionally disabled — conflicts with Google 3D Tiles at high zoom.
    // Google Photorealistic 3D Tiles provide their own terrain/elevation.
    renderer.globe.setGlobeVisible(false);
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
    renderer.globe.setGlobeVisible(true);
  }

  loaderStatus.textContent = t('Initializing systems...');

  const mapStackController = new MapController(viewer, {
    requestRender: governorRequestRender,
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
  return {
    renderer,
    viewer,
    tileset,
    mapStackController,
    operations,
    input,
    // Trims stale draw commands, keeps an inline panel drawing, says
    // whether an entity is the viewer's own, and installs the zoom-out
    // guard (render/cesium/application.js).
    ...viewerHooks,
  };
}
