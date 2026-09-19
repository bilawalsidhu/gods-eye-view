import * as Cesium from 'cesium';
import { TRAFFIC_TIMING_ENABLED } from './policy.js';
import {
  claimCameraSensitivity,
  releaseCameraSensitivity,
} from '../../data/cameraSensitivity.js';

export function createLifecycle({
  state: layerState,
  services,
  parts,
  source,
}) {
  const { holdContinuousRender, releaseContinuousRender } = services.render;
  const { resetFlowTileCache } = source;

  const methods = {
    /**
     * One-time initialisation. Creates the PointPrimitiveCollection and adds it
     * to the scene (hidden). The collection is never removed and re-added — only
     * toggled via `.show` to avoid destroy-on-remove errors.
     *
     * @param {Cesium.Viewer} viewer - The Cesium viewer instance.
     */
    init(viewer) {
      layerState._viewer = viewer;
      layerState._pointCollection = new Cesium.PointPrimitiveCollection({
        blendOption: Cesium.BlendOption.TRANSLUCENT,
      });
      // Add permanently — toggle with .show to avoid destroy-on-remove errors
      viewer.scene.primitives.add(layerState._pointCollection);
      layerState._pointCollection.show = false;
      layerState._dots = [];
      layerState._roads = [];
      layerState._count = 0;
      layerState._lastUpdate = null;
      layerState._lastBounds = null;
      layerState._fetching = false;
      layerState._loadGeneration = 0;
      layerState._densityScale = 1.0;
      layerState._speedScale = 1.0;
      layerState._lastViewCenter = null;
      layerState._flowCoveragePct = 0;
      layerState._flowError = null;
      if (TRAFFIC_TIMING_ENABLED) {
        layerState._trafficTimingCurrentAnchor = null;
        layerState._trafficTimingSequence = 0;
        layerState._trafficTimingTracesCreated = 0;
        layerState._trafficTimingDroppedTraces = 0;
      }

      // Preset-aware dot styling: adopt the active post-FX style (persisted
      // style restore may run before layer registration, so read the dataset)
      // and follow StyleManager's gev:style-change event thereafter. Guarded
      // for non-browser contexts; bound once per page (init survives layer
      // destroy/re-register).
      if (typeof window !== 'undefined') {
        layerState._stylePreset =
          document?.documentElement?.dataset?.gevStyle || 'normal';
        if (!layerState._styleListenerBound) {
          window.addEventListener('gev:style-change', (e) =>
            parts.style.setStylePreset(e?.detail?.style),
          );
          layerState._styleListenerBound = true;
        }
      }
      parts.style.refreshBucketColors();
      console.log('[Data:Traffic] Initialized');
    },

    /**
     * Enable the traffic layer. Shows the point collection, subscribes to the
     * preRender animation loop and camera-change events, and kicks off an
     * initial viewport check.
     *
     * @param {Cesium.Viewer} viewer - The Cesium viewer instance.
     */
    enable(viewer) {
      layerState._enabled = true;
      holdContinuousRender('traffic'); // per-frame animator (perf wave 2)
      layerState._lastAnimTime = 0;
      layerState._pointCollection.show = true;

      // One status check per session decides sim vs live-TomTom mode.
      parts.flow.ensureFlowStatus();

      layerState._preRenderRemover = viewer.scene.preRender.addEventListener(
        parts.animation.animate,
      );
      if (TRAFFIC_TIMING_ENABLED) {
        parts.timing.clearTrafficTimingEntries();
        layerState._trafficTimingCurrentAnchor = null;
        layerState._trafficTimingPostRenderRemovers = new Set();
        layerState._trafficTimingMoveEndRemover =
          viewer.camera.moveEnd.addEventListener(
            parts.timing.markTrafficTimingMoveEnd,
          );
      }

      // Share the 5% movement threshold with other camera-driven layers.
      viewer.camera.changed.addEventListener(parts.viewport.onCameraChanged);
      // Always inspect the final view, even when the last flight step is below
      // camera.changed's movement threshold.
      layerState._arrivalRemover = viewer.camera.moveEnd.addEventListener(
        parts.viewport.onCameraChanged,
      );
      claimCameraSensitivity(viewer.camera, 'traffic', 0.05);

      // Kick off initial viewport check
      parts.viewport.onCameraChanged();

      // Boot-order guard (field-test round 1: layer sat empty until the user
      // moved): when the persisted layer state re-enables traffic during the
      // intro flyTo, the initial check bails at high altitude — and a camera
      // that then parks never re-fires camera.changed. Retry cheaply until the
      // first load commits, then self-clear. Also acts as a safety kick if a
      // failed first fetch left the viewport unloaded while parked.
      clearInterval(layerState._enableKickTimer);
      layerState._enableKickTimer = setInterval(() => {
        if (!layerState._enabled || layerState._lastUpdate) {
          clearInterval(layerState._enableKickTimer);
          layerState._enableKickTimer = null;
          return;
        }
        if (!layerState._fetching && !layerState._retryTimer)
          parts.viewport.onCameraChanged();
      }, 1500);
    },

    /**
     * Disable the traffic layer. Cancels pending fetches, clears all dots,
     * unsubscribes from events, and hides the point collection.
     *
     * @param {Cesium.Viewer} viewer - The Cesium viewer instance.
     */
    disable(viewer) {
      layerState._enabled = false;
      releaseContinuousRender('traffic');
      clearTimeout(layerState._fetchTimeout);
      clearInterval(layerState._enableKickTimer);
      layerState._enableKickTimer = null;
      clearTimeout(layerState._retryTimer);
      layerState._retryTimer = null;
      layerState._retryDelayMs = 1500;
      parts.ingestion.cancelActiveFetch();
      layerState._loadGeneration++;
      layerState._fetching = false;
      layerState._flowPending = 0;
      layerState._roadError = null;
      layerState._roadProvider = null;
      parts.animation.clearDots();
      layerState._lastViewCenter = null;
      // A stale outage from the last session would misreport a fresh enable —
      // the next load re-derives feed health from real evidence.
      layerState._flowError = null;

      if (layerState._preRenderRemover) {
        layerState._preRenderRemover();
        layerState._preRenderRemover = null;
      }
      if (TRAFFIC_TIMING_ENABLED) {
        layerState._trafficTimingMoveEndRemover?.();
        layerState._trafficTimingMoveEndRemover = null;
        for (const remove of layerState._trafficTimingPostRenderRemovers || [])
          remove();
        layerState._trafficTimingPostRenderRemovers = null;
        layerState._trafficTimingCurrentAnchor = null;
      }

      viewer.camera.changed.removeEventListener(parts.viewport.onCameraChanged);
      layerState._arrivalRemover?.();
      layerState._arrivalRemover = null;
      releaseCameraSensitivity(viewer.camera, 'traffic');
      if (layerState._pointCollection) layerState._pointCollection.show = false;
    },

    /**
     * Permanently tear down the layer. Disables it, removes the point collection
     * from the scene, and clears the tile cache.
     *
     * @param {Cesium.Viewer} viewer - The Cesium viewer instance.
     */
    destroy(viewer) {
      this.disable(viewer);
      if (layerState._pointCollection) {
        viewer.scene.primitives.remove(layerState._pointCollection);
        layerState._pointCollection = null;
      }
      parts.rendering.removeHeatLines();
      layerState._tileCache.clear();
      resetFlowTileCache();
      layerState._count = 0;
      layerState._lastUpdate = null;
    },
  };

  return { methods };
}
