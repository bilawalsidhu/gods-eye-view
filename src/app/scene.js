import { createApplicationOperations } from './operations.js';
import * as Cesium from 'cesium';
import { installTrackpadPinchZoom } from '../app/viewer.js';
import { cesiumRenderer, cesiumViewerOf } from './renderer.js';
import { registerDataCredits } from '../data/dataCredits.js';
import { configureCreditKeyboardAccess } from '../creditKeyboard.js';
import { MapStackController } from '../mapStackController.js';
import { loadPhotorealisticTileset } from '../mapStartup.js';
import { initLogoGaze } from '../logoGaze.js';
import { inputFor } from '../input/dispatcher.js';
import {
  uninstallRenderGovernor,
  governorRequestRender,
} from '../renderGovernor.js';
import { describeError } from './errors.js';
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
  defer(() => {
    try {
      uninstallRenderGovernor(viewer);
    } finally {
      renderer.destroy();
    }
  });
  // Before any layer binds a click: every layer and tool shares this one.
  // Deferred after the viewer, so it is released before the viewer goes.
  const input = inputFor(viewer);
  defer(() => input.destroy());
  defer(installTrackpadPinchZoom(viewer));
  registerDataCredits(viewer, credits);
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
  };
}
