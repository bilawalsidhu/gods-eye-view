import {
  ISS_NORAD,
  ISS_OVERLAY_SOURCE_ID,
  SATELLITE_COVERAGE_MS,
} from './policy.js';
import { worldClock } from '../../time/worldClock.js';

export function createLifecycle({
  state: layerState,
  services,
  parts,
  source,
  getRenderer,
}) {
  const { clearFocusTarget } = services.focus;
  // While on with a catalog, satellites can be shown at any time in reach of
  // their element sets. Registered once; off, the layer has no time to show,
  // and each step tells the clock once it has settled.
  worldClock.register({
    id: 'satellites',
    coverage: () => {
      if (!layerState._enabled || !layerState._catalog.size) return null;
      const now = worldClock.wallNow();
      return {
        start: now - SATELLITE_COVERAGE_MS,
        end: now + SATELLITE_COVERAGE_MS,
      };
    },
  });
  const { holdContinuousRender, releaseContinuousRender } = services.render;
  const { registerPickOwner, unregisterPickOwner } = services.picking;

  const picks = {
    owner: 'satellites',
    predicate: (pickedId) => {
      const norad = Number(pickedId);
      return Number.isFinite(norad) && layerState._points.has(norad);
    },
  };
  const methods = {
    cameraOwner: {
      suspend: () => methods.suspendCamera(),
      resume: () => methods.resumeViewport(),
    },
    // Catalog data refresh; propagation remains preRender-owned.

    // The display draws on `engine` (none without one: nothing is drawn).
    async init(_viewer, { engine = null } = {}) {
      parts.catalog._abortActiveUpdates();
      clearFocusTarget('satellites');
      layerState._engine = engine;
      layerState._renderer?.destroy();
      layerState._renderer = engine
        ? (services.renderer.create({ engine }) ?? null)
        : null;
      layerState._catalog = new Map();
      layerState._points = new Map();
      layerState._detectionObjects = new Map();
      layerState._orbitPaths = new Map();
      layerState._count = 0;
      layerState._lastUpdate = null;
      layerState._coreStale = false;
      layerState._denseStale = false;
      layerState._trackedNorad = null;
      parts.tracking._cancelPendingTrackingRestore();
      layerState._trackedEntity = null;
      layerState._trackedFrameNumber = -1;
      layerState._trackedFrameGeo = null;
      layerState._trackedFrameNowForTest = null;
      // The new catalog's points and rings carry no hold.
      layerState._cockpitHiddenPoints = new Set();
      layerState._cockpitHiddenPath = null;
      layerState._cockpitHiddenDot = false;
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
      layerState.coverageChanged();

      const renderer = getRenderer();
      if (renderer) {
        // Point primitives for satellite dots
        layerState._pointCollection = renderer.createPoints();

        parts.interaction._installClickHandler();

        // Pre-render listener for real-time position updates
        // (fleet propagation + tracked per-frame dot + orbit ring GMST rotation)
        layerState._preRenderListener = renderer.onFrame(
          parts.rendering._preRenderTick,
        );
      }

      console.log('[Data:Satellites] Initialized');
    },

    suspendCamera() {
      // Outgoing tools release their cameras during teardown. That release
      // must not classify a retained follow as a user deselection.
      layerState._trackedEntityChangedRemove?.();
      layerState._trackedEntityChangedRemove = null;
    },
    detachRenderer() {
      const renderer = layerState._renderer;
      if (!renderer) return;
      layerState._waitForRenderer ??= new Promise((resolve) => {
        layerState._resumeRenderer = resolve;
      });
      layerState._clickHandler?.destroy();
      layerState._trackedEntityChangedRemove?.();
      layerState._preRenderListener?.();
      layerState._clickHandler =
        layerState._trackedEntityChangedRemove =
        layerState._preRenderListener =
          null;
      document.removeEventListener('keydown', parts.interaction._onKeyDown);
      unregisterPickOwner('satellites', layerState._engine);
      if (layerState._trackedEntity) {
        layerState._handoffOrigin =
          layerState._trackedEntity.gevSelectionOrigin;
        renderer.follow.release();
        renderer.removeTracked(layerState._trackedEntity);
        layerState._trackedEntity = null;
      }
      for (const [id, point] of layerState._points) {
        const {
          position,
          show,
          pixelSize,
          color,
          outlineColor,
          outlineWidth,
          scaleByDistance,
          disableDepthTestDistance,
        } = point;
        layerState._points.set(id, {
          id,
          position: { ...position },
          show,
          pixelSize,
          color,
          outlineColor,
          outlineWidth,
          scaleByDistance,
          disableDepthTestDistance,
        });
      }
      for (const path of layerState._orbitPaths.values()) {
        renderer.removeOrbit(path.primitive);
        path.primitive = null;
      }
      layerState._detectionObjects.clear();
      renderer.removePoints(layerState._pointCollection);
      if (layerState._enabled)
        releaseContinuousRender('satellites', layerState._engine);
      renderer.destroy();
      layerState._engine =
        layerState._renderer =
        layerState._pointCollection =
          null;
      layerState._overlayHost.clearSource(ISS_OVERLAY_SOURCE_ID);
    },

    show(enabled) {
      if (layerState._pointCollection)
        layerState._pointCollection.show =
          enabled && layerState._params.showPoints;
      for (const [id, path] of layerState._orbitPaths) {
        if (path.primitive)
          path.primitive.show =
            enabled &&
            (id === ISS_NORAD
              ? parts.controls._issOrbitVisible()
              : layerState._params.showOrbits);
      }
    },
    picks,
    attachRenderer(context = {}) {
      const { engine = null } = context;
      layerState._sceneContext = context;
      layerState._engine = engine;
      const renderer = engine
        ? (services.renderer.create({ engine }) ?? null)
        : null;
      layerState._renderer = renderer;
      if (!renderer) return;
      // The new engine counts its own frames.
      layerState._trackedFrameNumber = -1;
      layerState._pointCollection = renderer.createPoints();
      for (const [id, spec] of layerState._points)
        layerState._points.set(id, layerState._pointCollection.add(spec));
      layerState._pointCollection.show =
        layerState._enabled && layerState._params.showPoints;
      for (const [id, path] of layerState._orbitPaths) {
        path.primitive = renderer.createOrbit({
          positions: path.basePositions,
          width: id === ISS_NORAD ? 2.5 : 2,
          color: path.color,
        });
        path.alphaFactor = 1;
        path.primitive.show =
          id === ISS_NORAD
            ? parts.controls._issOrbitVisible()
            : layerState._enabled && layerState._params.showOrbits;
      }
      parts.rendering._updateOrbitPathRotations(new Date(layerState.now()));
      parts.cockpit?._syncCockpitSubjectVisuals();
      // Source work can publish as soon as GPU collections exist. Restoring
      // share-selected camera state may itself wait for that publication.
      layerState._resumeRenderer?.();
      layerState._waitForRenderer = layerState._resumeRenderer = null;
      // The restored camera runs before a retained follow gets its new native target.
      if (!context.viewRestored) this.resumeViewport();
    },

    resumeViewport() {
      if (!layerState._renderer) return;
      if (layerState._enabled) {
        if (layerState._trackedNorad != null && !layerState._trackedEntity)
          parts.tracking._trackSatellite(layerState._trackedNorad, {
            origin: layerState._handoffOrigin,
            resuming: true,
          });
        this.enable();
      }
      layerState._resumeRenderer?.();
      layerState._waitForRenderer = layerState._resumeRenderer = null;
    },

    enable() {
      layerState._enabled = true;
      holdContinuousRender('satellites', layerState._engine); // per-frame animator (perf wave 2)
      if (layerState._pointCollection)
        layerState._pointCollection.show =
          parts.controls.satelliteVisualsVisible(
            layerState._enabled,
            layerState._params.showPoints,
          );
      // Orbit ring primitives + persistent ISS host label — show them
      for (const [noradId, path] of layerState._orbitPaths)
        if (path.primitive)
          path.primitive.show =
            noradId === ISS_NORAD
              ? parts.controls._issOrbitVisible()
              : parts.controls.satelliteVisualsVisible(
                  layerState._enabled,
                  layerState._params.showOrbits,
                );
      parts.labels._syncIssOverlay();
      // Re-attach input handlers and preRender propagation
      if (layerState._renderer) parts.interaction._installClickHandler();
      // Pick-ownership (H2): satellite dot ids are numeric NORAD catalog numbers;
      // the registry hands predicates String()-coerced ids, so match via Number().
      registerPickOwner(picks.owner, picks.predicate, layerState._engine);
      if (!layerState._preRenderListener && layerState._renderer) {
        layerState._preRenderListener = getRenderer().onFrame(
          parts.rendering._preRenderTick,
        );
      }
      parts.tracking._applyPendingTrackingRestore();
      layerState.coverageChanged();
    },

    disable() {
      parts.catalog._abortActiveUpdates();
      parts.tracking._cancelPendingTrackingRestore();
      layerState._enabled = false;
      releaseContinuousRender('satellites', layerState._engine);
      if (layerState._pointCollection) layerState._pointCollection.show = false;
      for (const path of layerState._orbitPaths.values())
        if (path.primitive) path.primitive.show = false;
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
      unregisterPickOwner('satellites', layerState._engine);
      if (layerState._preRenderListener) {
        layerState._preRenderListener();
        layerState._preRenderListener = null;
      }
      layerState.coverageChanged();
    },

    destroy() {
      layerState._resumeRenderer?.();
      layerState._waitForRenderer = layerState._resumeRenderer = null;
      parts.catalog._abortActiveUpdates();
      releaseContinuousRender('satellites', layerState._engine); // direct-destroy path (perf wave 2 fix)
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
      unregisterPickOwner('satellites', layerState._engine);
      if (layerState._preRenderListener) {
        layerState._preRenderListener();
        layerState._preRenderListener = null;
      }
      layerState._overlayHost.clearSource(ISS_OVERLAY_SOURCE_ID);
      layerState._overlayHost.setVisible(ISS_OVERLAY_SOURCE_ID, false);
      if (layerState._pointCollection) {
        getRenderer().removePoints(layerState._pointCollection);
        layerState._pointCollection = null;
      }
      // Orbit ring primitives are removed (and destroyed) here
      for (const path of layerState._orbitPaths.values()) {
        if (path.primitive) getRenderer()?.removeOrbit(path.primitive);
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
      layerState._coreStale = false;
      layerState._denseStale = false;
      layerState._lastError = null;
      layerState._lastFocusUpdate = 0;
      layerState._activeFocusCount = 0;
      layerState._trackingRefreshEpoch += 1;
      layerState._lastTrackingRefreshOutcome = {
        epoch: layerState._trackingRefreshEpoch,
        status: 'destroyed',
        failedGroups: [],
      };
      layerState._renderer?.destroy();
      layerState._renderer = null;
      layerState._engine = null;
      layerState.coverageChanged();
    },
  };

  return { methods };
}
