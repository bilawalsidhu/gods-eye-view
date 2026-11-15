import {
  cableClassificationTypeForScene,
  cableClassificationTypeForStack,
} from './surface.js';

export function createLifecycle({ state, parts, source, mapStackEventTarget }) {
  return {
    id: 'telegeography-submarine-cables',
    name: 'Submarine Cables',
    icon: '≋',
    source: source.label,
    updateInterval: 0,
    statsRefreshInterval: 500,

    init(viewer) {
      state._viewer = viewer;
      state._classificationType = cableClassificationTypeForScene(
        viewer?.scene,
      );
      if (!state._mapStackListener && mapStackEventTarget?.addEventListener) {
        state._mapStackListener = (event) => {
          parts.rendering.applyCableClassification(
            event?.detail?.activeId
              ? cableClassificationTypeForStack(event.detail.activeId)
              : cableClassificationTypeForScene(state._viewer?.scene),
          );
        };
        mapStackEventTarget.addEventListener(
          'gev:map-stack-changed',
          state._mapStackListener,
        );
      }
      parts.interaction.beginInteraction(viewer);
      if (!state._preRenderRemover) {
        state._preRenderRemover = viewer.scene.preRender.addEventListener(
          () => {
            // The camera is handed to the gate so tracked/orbit cameras — which
            // never emit moveEnd — reach the motion fallback. No render is
            // requested for a fallback sweep: it only fires while the camera is
            // already moving, so frames are flowing by construction.
            if (!state._enabled || !state._loaded) return;
            // Markers left over from the last sweep, a few per frame; line
            // shows and rebuilt stems waiting for their geometry.
            parts.rendering.revealLandingMarkers();
            parts.rendering.syncLineShow();
            parts.rendering.settleStems();
            if (!state._referenceSweepGate.shouldRun(viewer.camera)) return;
            parts.rendering.updateReferenceVisibility();
          },
        );
      }
      if (!state._moveEndRemover) {
        state._moveEndRemover = viewer.camera.moveEnd.addEventListener(() => {
          if (!state._enabled) return;
          state._referenceSweepGate.markDirty();
          viewer.scene.requestRender?.();
        });
      }
    },

    enable(viewer) {
      state._enabled = true;
      parts.rendering.updateVisibility();
      state._overlayPublisher.show();
      // A hide() cleared the host source, so an identical cohort must still
      // republish on the next sweep.
      parts.rendering.resetPublishSignature();
      state._referenceSweepGate.markDirty();
      // The gate is dirty-only; ask for the frame its sweep needs in case the
      // camera is parked and nothing else is rendering.
      (viewer || state._viewer)?.scene?.requestRender?.();
      void parts.ingestion.load(viewer || state._viewer);
    },

    disable() {
      state._enabled = false;
      state._overlayPublisher.hide();
      parts.rendering.resetPublishSignature();
      if (state._loading && state._abort) {
        state._abort.abort();
        state._loading = false;
        state._loadingLabel = '';
      }
      // Hide what is built and keep it: a hidden primitive is skipped by
      // the scene, so it costs nothing per frame, and the next enable shows
      // it again without a rebuild. Only the stems go: they are sized for
      // the view and the next sweep redraws them in a worker. An in-flight load's own post-await
      // ownership check stops that stale generation from building anything.
      state._pendingLandingReveals.length = 0;
      parts.rendering.dropStems();
      parts.rendering.updateVisibility();
      state._viewer?.scene?.requestRender?.();
    },

    update(viewer) {
      return parts.ingestion.load(viewer || state._viewer);
    },

    destroy(viewer) {
      if (state._abort) state._abort.abort();
      parts.rendering.destroyScene(viewer || state._viewer);
      // hide() clears every published host entry and goes invisible while
      // keeping the publisher reusable — the legacy layer supported re-init
      // after destroy, and hidden publishers already drop late publishes.
      // Pinned by the direct-destroy host test: removing this line leaves a
      // visible overlay source with orphan labels.
      state._overlayPublisher.hide();
      if (state._clickHandler) {
        state._clickHandler.destroy();
        state._clickHandler = null;
      }
      if (state._preRenderRemover) {
        state._preRenderRemover();
        state._preRenderRemover = null;
      }
      if (state._moveEndRemover) {
        state._moveEndRemover();
        state._moveEndRemover = null;
      }
      if (state._mapStackListener && mapStackEventTarget?.removeEventListener) {
        mapStackEventTarget.removeEventListener(
          'gev:map-stack-changed',
          state._mapStackListener,
        );
        state._mapStackListener = null;
      }
      state._viewer = null;
      state._enabled = false;
      state._loading = false;
      state._loaded = false;
      state._count = 0;
      state._error = null;
      state._lastUpdate = null;
      state._loadingLabel = '';
      parts.rendering.resetPublishSignature();
      state._referenceSweepGate.reset();
    },

    getStats() {
      return {
        count: state._count,
        lastUpdate: state._lastUpdate,
        loading: state._loading,
        loadingLabel: state._loadingLabel,
        error: state._error,
        referenceLabelCount: state._referenceLabelCount,
      };
    },
  };
}
