import { observeTrafficSurface } from './surface.js';
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
  const { resetFlowTileCache } = source;

  function readyForSurfaceWork() {
    const resolve = layerState._sceneReady;
    layerState._sceneReady = layerState._waitForScene = null;
    resolve?.();
  }

  function bindScene() {
    const viewer = layerState._viewer,
      engine = layerState._engine;
    const camera = engine?.camera ?? viewer.camera;
    const frames = engine?.frames ?? viewer.scene;
    if (viewer)
      layerState._surfaceFrameRemover = observeTrafficSurface(viewer.scene);
    layerState._pointCollection.show = true;
    layerState._lastAnimTime = 0;
    parts.animation.syncRenderDemand();
    layerState._preRenderRemover = frames.preRender.addEventListener(() => {
      parts.animation.animate();
      layerState._native?.points.flush();
    });
    if (TRAFFIC_TIMING_ENABLED) {
      parts.timing.clearTrafficTimingEntries();
      layerState._trafficTimingCurrentAnchor = null;
      layerState._trafficTimingPostRenderRemovers = new Set();
      layerState._trafficTimingMoveEndRemover = camera.moveEnd.addEventListener(
        parts.timing.markTrafficTimingMoveEnd,
      );
    }
    layerState._cameraRemover = camera.changed.addEventListener(
      parts.viewport.onCameraChanged,
    );
    layerState._arrivalRemover = camera.moveEnd.addEventListener(() =>
      parts.viewport.onCameraChanged({ immediate: true }),
    );
    claimCameraSensitivity(engine ?? camera, 'traffic', 0.05);
  }

  function unbindScene() {
    const camera = layerState._engine?.camera ?? layerState._viewer?.camera;
    layerState._surfaceFrameRemover?.();
    layerState._preRenderRemover?.();
    layerState._trafficTimingMoveEndRemover?.();
    for (const remove of layerState._trafficTimingPostRenderRemovers || [])
      remove();
    layerState._trafficTimingPostRenderRemovers = null;
    layerState._trafficTimingCurrentAnchor = null;
    layerState._cameraRemover?.();
    // Some legacy camera events do not return a remover.
    if (!layerState._cameraRemover)
      camera?.changed?.removeEventListener?.(parts.viewport.onCameraChanged);
    layerState._arrivalRemover?.();
    layerState._surfaceFrameRemover =
      layerState._preRenderRemover =
      layerState._cameraRemover =
      layerState._arrivalRemover =
      layerState._trafficTimingMoveEndRemover =
        null;
    releaseCameraSensitivity(layerState._engine ?? camera, 'traffic');
  }

  const methods = {
    /**
     * One-time initialisation. Creates the PointPrimitiveCollection and adds it
     * to the scene (hidden). The collection is never removed and re-added — only
     * toggled via `.show` to avoid destroy-on-remove errors.
     *
     * @param {Cesium.Viewer} viewer - The Cesium viewer instance.
     */
    init(viewer, options) {
      this.attachRenderer(viewer, options);
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
          layerState._styleListener = (e) =>
            parts.style.setStylePreset(e?.detail?.style);
          window.addEventListener(
            'gev:style-change',
            layerState._styleListener,
          );
          layerState._styleListenerBound = true;
        }
      }
      parts.style.refreshBucketColors();
      console.log('[Data:Traffic] Initialized');
    },

    attachRenderer(
      viewer,
      { engine = null, waitForCameraRestore = false } = {},
    ) {
      layerState._restoringViewport = waitForCameraRestore;
      layerState._viewer = viewer;
      layerState._engine = engine;
      layerState._native =
        !viewer && engine ? services.nativeRenderer(engine) : null;
      layerState._heatSupported = null;
      const points =
        layerState._native?.points ??
        new Cesium.PointPrimitiveCollection({
          blendOption: Cesium.BlendOption.TRANSLUCENT,
        });
      if (viewer) viewer.scene.primitives.add(points);
      layerState._pointCollection = points;
      for (const dot of layerState._dots) dot.point = points.add(dot.point);
      points.show = layerState._enabled;
      if (!waitForCameraRestore) readyForSurfaceWork();
      if (layerState._enabled) {
        bindScene();
        parts.rendering.rebuildHeatLines(layerState._roads);
        if (
          layerState._dots.length &&
          layerState._roads.some((r) => !r.directFlow)
        )
          services.credits?.showOsmCredit?.(engine ?? viewer, 'traffic', {
            openMapTiles: true,
          });
        if (layerState._liveMode)
          services.credits?.registerDynamicCredit?.(
            engine ?? viewer,
            services.credits.TOMTOM_CREDIT,
          );
        parts.viewport.onCameraChanged({ immediate: true });
      }
    },
    resumeViewport() {
      if (!layerState._restoringViewport) return;
      layerState._restoringViewport = false;
      readyForSurfaceWork();
      if (!layerState._enabled) return;
      if (layerState._populationPending) parts.retention.resume();
      const previous = layerState._surfaceInput;
      if (
        previous &&
        !layerState._fetching &&
        layerState._lastBounds === previous.bounds
      ) {
        // A completed pass, not a refinement: the incoming globe often still
        // shows coarse tiles, so it samples provisionally and refines once its
        // surface has loaded ('Handoff refined'). A refinement here never
        // refined again and left vehicles on those coarse heights.
        void parts.flow
          .applyFlowThenRender(
            previous.roads,
            previous.bounds,
            layerState._loadGeneration,
            parts.viewport.getCameraAltitude(),
            'Handoff',
          )
          .catch((error) => {
            if (error?.name !== 'AbortError')
              console.warn('[Data:Traffic] Surface refresh failed', error);
          });
      }
      parts.viewport.onCameraChanged({ immediate: true });
    },
    detachRenderer() {
      if (!layerState._pointCollection) return;
      unbindScene();
      clearTimeout(layerState._fetchTimeout);
      layerState._surfaceRefineRemove?.();
      layerState._surfaceRefineRemove = null;
      layerState._surfaceRevision = (layerState._surfaceRevision || 0) + 1;
      layerState._preparedRoads?.clear();
      parts.rendering.removeHeatLines();
      services.credits?.hideOsmCredit?.(
        layerState._engine ?? layerState._viewer,
        'traffic',
      );
      for (const dot of layerState._dots) {
        const p = dot.point;
        dot.point = {
          position: Cesium.Cartesian3.clone(p.position),
          pixelSize: p.pixelSize,
          color: p.color,
          show: p.show,
          outlineColor: p.outlineColor,
          outlineWidth: p.outlineWidth,
          scaleByDistance: p.scaleByDistance,
          translucencyByDistance: p.translucencyByDistance,
          disableDepthTestDistance: 0,
        };
      }
      layerState._viewer?.scene.primitives.remove(layerState._pointCollection);
      layerState._native?.destroy();
      if (layerState._renderHeld)
        services.render.releaseContinuousRender('traffic');
      layerState._renderHeld = false;
      layerState._pointCollection =
        layerState._viewer =
        layerState._engine =
        layerState._native =
          null;
      layerState._waitForScene ??= new Promise((resolve) => {
        layerState._sceneReady = resolve;
      });
    },

    /**
     * Enable the traffic layer. Shows the point collection, subscribes to the
     * preRender animation loop and camera-change events, and kicks off an
     * initial viewport check.
     *
     * @param {Cesium.Viewer} viewer - The Cesium viewer instance.
     */
    enable(viewer) {
      if (layerState._enabled) return;
      if (viewer) layerState._viewer = viewer;
      layerState._enabled = true;
      if (layerState._roadMode !== 'tomtom') source.prefetch?.();
      bindScene();
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
      layerState._surfaceInput = null;
      services.credits?.hideOsmCredit?.(
        layerState._engine ?? layerState._viewer,
        'traffic',
      );
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

      unbindScene();
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
        layerState._viewer?.scene.primitives.remove(
          layerState._pointCollection,
        );
        layerState._native?.destroy();
        layerState._native = null;
        layerState._pointCollection = null;
      }
      parts.rendering.removeHeatLines();
      layerState._tileCache.clear();
      if (layerState._styleListenerBound && typeof window !== 'undefined') {
        window.removeEventListener(
          'gev:style-change',
          layerState._styleListener,
        );
        layerState._styleListenerBound = false;
      }
      layerState._sceneReady?.();
      layerState._waitForScene = layerState._sceneReady = null;
      resetFlowTileCache();
      layerState._count = 0;
      layerState._lastUpdate = null;
    },
  };

  return { methods };
}
