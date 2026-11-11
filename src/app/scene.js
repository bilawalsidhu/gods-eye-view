import { createApplicationOperations } from './operations.js';
import { registerDataCredits } from '../data/dataCredits.js';
import { MapStackController } from '../mapStackController.js';
import { mapEngineFor } from '../maps/engine.js';
import { initLogoGaze } from '../logoGaze.js';
import { inputFor } from '../input/dispatcher.js';
import {
  holdContinuousRender,
  installRenderGovernor,
  uninstallRenderGovernor,
  governorRequestRender,
} from '../renderGovernor.js';
import { describeError } from './errors.js';
import { worldClock, worldTimeFor } from '../time/worldClock.js';
import { followWorldTime } from '../time/viewerClock.js';
import { t } from '../i18n/index.js';
import { applicationHooksOf } from '../render/applicationHooks.js';
import { createSceneHost } from '../render/rendererOf.js';

/**
 * The application's composition root picks the renderer: the one given, else
 * the default (Cesium), loaded only then, so a page on the stub never
 * loads it. This is the only part of an adapter the application imports.
 */
async function defaultRenderer() {
  const { cesiumRenderer } = await import('../render/cesium/application.js');
  return cesiumRenderer;
}

/**
 * Construct the application globe using the caller's local configuration.
 * `renderer` is the `RendererPlugin` that draws it (default: Cesium). The
 * application runs on a renderer with only the contract's required members:
 * what a renderer's plugin hands it beside the contract
 * (`src/render/applicationHooks.js`) it uses where given, and does without
 * where not.
 */
export async function createApplicationScene({
  renderer: givenPlugin,
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
  const rendererPlugin = givenPlugin ?? (await defaultRenderer());
  signal.throwIfAborted();
  const container = document.getElementById('cesiumContainer');
  const renderer = await rendererPlugin.create({
    container,
    googleApiKey: googleApiKey || undefined,
    googleTokens: googleTokens
      ? (options) => googleTokens.token(options)
      : undefined,
    worldDataToken: cesiumToken || undefined,
    signal,
  });
  // The scene object every layer and tool is handed: the application's own,
  // bound to the renderer.
  const scene = createSceneHost(renderer, { container });
  const viewer = scene.host;
  const hooks = applicationHooksOf(renderer);
  // The governor keeps its holds on the renderer's frame port. The loop
  // draws every frame until the application's tools are up (they release
  // 'boot'), as it did before anything could hold it.
  installRenderGovernor(renderer.frame);
  holdContinuousRender('boot');
  defer(() => {
    try {
      uninstallRenderGovernor(renderer.frame);
    } finally {
      try {
        renderer.destroy();
      } finally {
        scene.release();
      }
    }
  });
  // Before any layer binds a click: every layer and tool shares this one.
  // Deferred after the renderer, so it is released before the renderer goes.
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
  registerDataCredits(viewer, credits);
  loaderStatus.textContent =
    googleApiKey || googleTokens || cesiumToken
      ? t('Loading Google 3D Tiles...')
      : t('Loading the keyless globe...');
  // The map stacks, and the photoreal base among them, switch through the
  // scene's map engine: the renderer's own, or its globe port.
  const engine = mapOptions.engine ?? mapEngineFor(viewer);
  const photoreal = (await engine.loadPhotoreal?.(viewer, {
    googleApiKey,
    googleTokens,
    cesiumToken,
  })) ?? { tileset: null, route: 'none', errors: [] };
  const tileset = photoreal.tileset;
  // A provider can finish after cancellation; retain ownership of its result.
  defer(() => {
    if (!tileset || engine.isDestroyed(tileset)) return;
    engine.removeTileset(viewer, tileset);
    engine.release(tileset);
  });
  signal.throwIfAborted();
  if (tileset) {
    engine.addTileset(viewer, tileset);
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
    engine,
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
    // What the renderer's plugin hands the application beside the contract,
    // each optional: trims stale draw commands, keeps an inline panel
    // drawing, says whether an entity is the renderer's own, installs the
    // zoom-out guard, and what QA scripts read (render/applicationHooks.js).
    trimStaleCommands: hooks.trimStaleCommands,
    keepPanelRendering: hooks.keepPanelRendering,
    viewerDrawsEntity: hooks.viewerDrawsEntity,
    installZoomOutGuard: hooks.installZoomOutGuard,
    qaHandles: hooks.qaHandles,
  };
}
