import * as Cesium from 'cesium';
import { ISS_OVERLAY_SOURCE_ID } from './policy.js';

export function createLifecycle({
  state: layerState,
  services,
  parts,
  source,
}) {
  const { clearFocusTarget } = services.focus;
  const { holdContinuousRender, releaseContinuousRender } = services.render;
  const { registerPickOwner, unregisterPickOwner } = services.picking;

  const methods = {
    // Catalog data refresh; propagation remains preRender-owned.

    async init(viewer) {
      parts.catalog._abortActiveUpdates();
      clearFocusTarget('satellites');
      layerState._viewer = viewer;
      layerState._catalog = new Map();
      layerState._points = new Map();
      layerState._detectionObjects = new Map();
      layerState._orbitPaths = new Map();
      layerState._count = 0;
      layerState._lastUpdate = null;
      layerState._trackedNorad = null;
      parts.tracking._cancelPendingTrackingRestore();
      layerState._trackedEntity = null;
      layerState._trackedFrameNumber = -1;
      layerState._trackedFrameGeo = null;
      layerState._trackedFrameNowForTest = null;
      layerState._lastFocusUpdate = 0;
      layerState._activeFocusCount = 0;
      layerState._enabled = false;
      layerState._overlayHost.clearSource(ISS_OVERLAY_SOURCE_ID);
      layerState._overlayHost.setVisible(ISS_OVERLAY_SOURCE_ID, false);
      // Dense extras rebuild via update() when _params.catalog === 'dense'
      // (the catalog-mode preference itself is sticky across init/destroy).
      layerState._denseIds = [];
      layerState._denseCursor = 0;
      layerState._denseLoadPromise = null;
      layerState._denseLoadToken++;
      layerState._denseStatus = 'idle';
      layerState._denseError = null;
      layerState._catalogRevision++;

      // Point primitives for satellite dots
      layerState._pointCollection = new Cesium.PointPrimitiveCollection();
      viewer.scene.primitives.add(layerState._pointCollection);

      parts.interaction._installClickHandler(viewer);

      // Pre-render listener for real-time position updates
      // (fleet propagation + tracked per-frame dot + orbit ring GMST rotation)
      layerState._preRenderListener = viewer.scene.preRender.addEventListener(
        parts.rendering._preRenderTick,
      );

      console.log('[Data:Satellites] Initialized');
    },

    enable(viewer) {
      layerState._enabled = true;
      holdContinuousRender('satellites'); // per-frame animator (perf wave 2)
      if (layerState._pointCollection)
        layerState._pointCollection.show =
          parts.controls.satelliteVisualsVisible(
            layerState._enabled,
            layerState._params.showPoints,
          );
      // Orbit ring primitives + persistent ISS host label — show them
      for (const path of layerState._orbitPaths.values())
        path.primitive.show = parts.controls.satelliteVisualsVisible(
          layerState._enabled,
          layerState._params.showOrbits,
        );
      parts.labels._syncIssOverlay();
      // Re-attach input handlers and preRender propagation
      parts.interaction._installClickHandler(viewer);
      // Pick-ownership (H2): satellite dot ids are numeric NORAD catalog numbers;
      // the registry hands predicates String()-coerced ids, so match via Number().
      registerPickOwner('satellites', (pickedId) => {
        const norad = Number(pickedId);
        return Number.isFinite(norad) && layerState._points.has(norad);
      });
      if (!layerState._preRenderListener && viewer) {
        layerState._preRenderListener = viewer.scene.preRender.addEventListener(
          parts.rendering._preRenderTick,
        );
      }
      parts.tracking._applyPendingTrackingRestore();
    },

    disable(viewer) {
      parts.catalog._abortActiveUpdates();
      parts.tracking._cancelPendingTrackingRestore();
      layerState._enabled = false;
      releaseContinuousRender('satellites');
      if (layerState._pointCollection) layerState._pointCollection.show = false;
      for (const path of layerState._orbitPaths.values())
        path.primitive.show = false;
      parts.tracking._clearTracking();
      parts.labels._syncIssOverlay();
      // Remove click handler + keydown listener + preRender propagation while disabled
      if (layerState._clickHandler) {
        layerState._clickHandler.destroy();
        layerState._clickHandler = null;
      }
      if (layerState._trackedEntityChangedRemove) {
        layerState._trackedEntityChangedRemove();
        layerState._trackedEntityChangedRemove = null;
      }
      document.removeEventListener('keydown', parts.interaction._onKeyDown);
      unregisterPickOwner('satellites');
      if (layerState._preRenderListener) {
        layerState._preRenderListener();
        layerState._preRenderListener = null;
      }
    },

    destroy(viewer) {
      parts.catalog._abortActiveUpdates();
      releaseContinuousRender('satellites'); // direct-destroy path (perf wave 2 fix)
      layerState._enabled = false;
      parts.tracking._clearTracking();
      parts.tracking._cancelPendingTrackingRestore();
      if (layerState._clickHandler) {
        layerState._clickHandler.destroy();
        layerState._clickHandler = null;
      }
      if (layerState._trackedEntityChangedRemove) {
        layerState._trackedEntityChangedRemove();
        layerState._trackedEntityChangedRemove = null;
      }
      document.removeEventListener('keydown', parts.interaction._onKeyDown);
      unregisterPickOwner('satellites');
      if (layerState._preRenderListener) {
        layerState._preRenderListener();
        layerState._preRenderListener = null;
      }
      layerState._overlayHost.clearSource(ISS_OVERLAY_SOURCE_ID);
      layerState._overlayHost.setVisible(ISS_OVERLAY_SOURCE_ID, false);
      if (layerState._pointCollection) {
        viewer.scene.primitives.remove(layerState._pointCollection);
        layerState._pointCollection = null;
      }
      // Orbit ring primitives are removed (and destroyed) here
      for (const path of layerState._orbitPaths.values()) {
        viewer.scene.primitives.remove(path.primitive);
      }
      layerState._points.clear();
      layerState._detectionObjects.clear();
      layerState._orbitPaths.clear();
      layerState._catalog.clear();
      layerState._denseIds = [];
      layerState._denseCursor = 0;
      layerState._denseLoadToken++;
      layerState._denseStatus = 'idle';
      layerState._denseError = null;
      layerState._catalogRevision++;
      layerState._rowControlsListener = null;
      layerState._count = 0;
      layerState._lastUpdate = null;
      layerState._lastError = null;
      layerState._lastFocusUpdate = 0;
      layerState._activeFocusCount = 0;
      layerState._trackingRefreshEpoch += 1;
      layerState._lastTrackingRefreshOutcome = {
        epoch: layerState._trackingRefreshEpoch,
        status: 'destroyed',
        failedGroups: [],
      };
      layerState._viewer = null;
    },
  };

  return { methods };
}
