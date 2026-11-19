import { observeTrafficSurface } from './surface.js';
import { CAMERA_CHANGED_THRESHOLD, TRAFFIC_TIMING_ENABLED } from './policy.js';
import { resolveRoadMode } from './roadModes.js';
import { cameraOf, drawOf, frameOf } from '../../render/rendererOf.js';

/** Numbers each layer instance's draw sets apart. */
let instances = 0;

export function createLifecycle({
  state: layerState,
  services,
  parts,
  source,
}) {
  const { resetFlowTileCache } = source;

  const methods = {
    /**
     * One-time initialisation. Makes the dots' draw set (hidden; it is
     * shown and hidden with the layer) and the heat-lines' (emptied when
     * the layer is disabled); both are let go on destroy.
     *
     * @param {Cesium.Viewer} viewer - The Cesium viewer instance.
     */
    init(viewer) {
      layerState._viewer = viewer;
      layerState._dotSet?.dispose();
      layerState._heatSet?.dispose();
      layerState._heatOverSet?.dispose();
      const instance = ++instances;
      const draw = drawOf(viewer);
      layerState._dotSet = draw.points({
        id: `traffic:${instance}:dots`,
        blend: 'translucent',
        show: false,
      });
      // Heat-lines drape on the 3D tiles only, as the dots' roads are
      // sampled there; flow lines ask for terrain too, item by item.
      layerState._heatSet = draw.lines({
        id: `traffic:${instance}:heat`,
        clampTo: 'tiles',
      });
      // The slow heat-lines, made after the jam ones' set so they draw over
      // them, as their primitive was added after the jam lines'.
      layerState._heatOverSet = draw.lines({
        id: `traffic:${instance}:heat-over`,
        clampTo: 'tiles',
      });
      layerState._heatJam = [];
      layerState._heatLineCount = 0;
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
      layerState._flowRoads = null;
      layerState._flowError = null;
      layerState._flowStale = false;
      layerState._flowOldestTileAt = null;
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
     * Enable the traffic layer. Shows the dots, subscribes to the frame
     * port's preRender for the animation and to the camera port's events,
     * and kicks off an initial viewport check.
     *
     * @param {Cesium.Viewer} viewer - The Cesium viewer instance.
     */
    enable(viewer) {
      if (layerState._enabled) return;
      layerState._enabled = true;
      layerState._surfaceFrameRemover = observeTrafficSurface(viewer);
      // OpenFreeMap metadata, unless only TomTom roads can be drawn.
      if (
        resolveRoadMode(layerState._roadMode, true, layerState._roadModes) !==
        'tomtom'
      )
        source.prefetch?.();
      parts.animation.syncRenderDemand();
      layerState._lastAnimTime = 0;
      if (layerState._dotSet) layerState._dotSet.show = layerState._showDots;

      const camera = cameraOf(viewer);
      layerState._preRenderRemover = frameOf(viewer).on(
        'preRender',
        parts.animation.animate,
      );
      if (TRAFFIC_TIMING_ENABLED) {
        parts.timing.clearTrafficTimingEntries();
        layerState._trafficTimingCurrentAnchor = null;
        layerState._trafficTimingPostRenderRemovers = new Set();
        layerState._trafficTimingMoveEndRemover = camera.on(
          'moveEnd',
          parts.timing.markTrafficTimingMoveEnd,
        );
      }

      // Its own 5% movement threshold: the camera measures it for this
      // listener alone.
      layerState._cameraRemover = camera.on(
        'changed',
        () => parts.viewport.onCameraChanged(),
        { threshold: CAMERA_CHANGED_THRESHOLD },
      );
      // Always inspect the final view, even when the last flight step is below
      // the changed threshold.
      layerState._arrivalRemover = camera.on('moveEnd', () =>
        parts.viewport.onCameraChanged({ immediate: true }),
      );

      // Enabling is explicit intent, not a camera gesture that needs settling.
      parts.viewport.onCameraChanged({ immediate: true });

      // Boot-order guard (field-test round 1: layer sat empty until the user
      // moved): when the persisted layer state re-enables traffic during the
      // intro flyTo, the initial check bails at high altitude — and a camera
      // that then parks never re-fires camera.changed. Retry cheaply until the
      // first load commits, then self-clear. Also acts as a safety kick if a
      // failed first fetch left the viewport unloaded while parked.
      clearInterval(layerState._enableKickTimer);
      layerState._enableKickTimer = setInterval(() => {
        if (
          !layerState._enabled ||
          layerState._lastUpdate ||
          layerState._roadRetryStopped ||
          layerState._retryAttempts >= 3
        ) {
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
      services.credits?.hideOsmCredit?.(layerState._viewer, 'traffic');
      parts.animation.syncRenderDemand();
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
      parts.animation.clearDots();
      layerState._lastBounds = null;
      layerState._lastViewCenter = null;
      // A stale outage from the last session would misreport a fresh enable —
      // the next load re-derives feed health from real evidence.
      layerState._flowError = null;
      layerState._flowStale = false;
      layerState._flowOldestTileAt = null;

      layerState._surfaceFrameRemover?.();
      layerState._surfaceFrameRemover = null;
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

      layerState._cameraRemover?.();
      layerState._cameraRemover = null;
      layerState._arrivalRemover?.();
      layerState._arrivalRemover = null;
      if (layerState._dotSet) layerState._dotSet.show = false;
    },

    /**
     * Permanently tear down the layer. Disables it, lets the dots' and
     * heat-lines' draw sets go, and clears the tile cache.
     *
     * @param {Cesium.Viewer} viewer - The Cesium viewer instance.
     */
    destroy(viewer) {
      this.disable(viewer);
      parts.rendering.removeHeatLines();
      layerState._dotSet?.dispose();
      layerState._dotSet = null;
      layerState._heatSet?.dispose();
      layerState._heatSet = null;
      layerState._heatOverSet?.dispose();
      layerState._heatOverSet = null;
      layerState._tileCache.clear();
      resetFlowTileCache();
      layerState._count = 0;
      layerState._lastUpdate = null;
    },
  };

  return { methods };
}
