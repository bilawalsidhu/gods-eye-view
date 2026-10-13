import { createApplicationOperations } from './operations.js';
import * as Cesium from 'cesium';
import {
  createApplicationViewer,
  installTrackpadPinchZoom,
} from '../app/viewer.js';
import {
  canReloadAfterContextLoss,
  dismissCesiumErrorPanel,
  markContextLossReload,
  showContextLossNotice,
} from './contextLoss.js';
import { isEmbeddedInline } from './embed.js';
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

/** Construct the application globe using the caller's local configuration. */
export async function createApplicationScene({
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
  loaderStatus.textContent = 'Configuring viewer...';
  // Provider attribution stays visible, including clean-view and recording.
  const creditContainer = document.createElement('div');
  creditContainer.id = 'cesium-credits';
  document.body.appendChild(creditContainer);
  defer(() => creditContainer.remove());
  const viewer = createApplicationViewer({
    container: 'cesiumContainer',
    creditContainer,
    // Recovery for a dropped/evicted WebGL context (CesiumGS/cesium#5991).
    // The share-link hash already persists camera, layers and style, so a
    // fresh boot restores the view; see app/contextLoss.js for the routes.
    onContextLoss: ({ error } = {}) => {
      console.error(
        "[God's Eye View] WebGL context lost; recovering.",
        error ?? '',
      );
      // The error-first route (the loss event arriving after a frame
      // already rendered into the dead context) leaves Cesium's panel up;
      // recovery replaces it.
      dismissCesiumErrorPanel();
      // A panel embeds the app into a host page this document must never
      // reload; the panel runtime owns that UX (globePanelRuntime.js).
      if (isEmbeddedInline()) return;
      if (!canReloadAfterContextLoss()) {
        // Losing another context within the cooldown means this machine
        // (or this boot) cannot hold one — offer the manual way out.
        showContextLossNotice({ allowManualReload: true });
        return;
      }
      markContextLossReload();
      showContextLossNotice({ message: 'Restoring the 3D globe…' });
      window.location.reload();
    },
  });
  defer(() => {
    uninstallRenderGovernor(viewer);
    if (!viewer.isDestroyed()) viewer.destroy();
  });
  defer(installTrackpadPinchZoom(viewer));
  registerDataCredits(viewer, credits);
  configureCreditKeyboardAccess(document);
  loaderStatus.textContent =
    googleApiKey || googleTokens || cesiumToken
      ? 'Loading Google 3D Tiles...'
      : 'Loading the keyless globe...';
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
      loaderStatus.textContent = `Google 3D Tiles unavailable (${tileErrorDetail}). Loading the keyless globe...`;
    }
    viewer.scene.globe.show = true;
  }

  loaderStatus.textContent = 'Initializing systems...';

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
  return { viewer, tileset, mapStackController, operations };
}
