import * as Cesium from 'cesium';
import { JET_MODEL_URL } from './policy.js';

export function createLifecycle({
  flightState,
  services,
  parts,
  layer,
  resolveAsset,
}) {
  const { clearFocusTarget } = services.focus;
  const { registerSpriteCollection, restoreSpriteOrder } = services.sprites;
  const { holdContinuousRender, releaseContinuousRender } = services.render;
  const { ensureGeoidReady } = services.geoid;
  const { registerPickOwner, unregisterPickOwner } = services.picking;
  const { setMilitaryLayerActive } = services.militaryRegistry;

  const methods = {
    /** Configure the source before initialization; an active layer keeps its owner. */
    setSource(source) {
      if (flightState._viewer)
        throw new Error('Configure the source before layer initialization');
      if (typeof source?.getSnapshot !== 'function')
        throw new TypeError('A snapshot source is required');
      flightState.feed._source = source;
      flightState.feed._lastSource =
        source.label || flightState.feed._lastSource;
      this.source = flightState.feed._lastSource;
    },

    /**
     * Initialize the layer: create the billboard collection, reset all state,
     * and install the click-to-track handler.
     * @param {Cesium.Viewer} viewer - The Cesium viewer instance
     */
    init(viewer) {
      if (flightState._viewer)
        throw new Error('Flight layer is already initialized');
      if (typeof flightState.feed._source?.getSnapshot !== 'function')
        throw new TypeError('A snapshot source is required');
      if (flightState.lifetime.signal.aborted)
        flightState.lifetime = new AbortController();
      clearFocusTarget('militaryFlights');
      flightState._viewer = viewer;
      flightState._billboardCollection = new Cesium.BillboardCollection();
      viewer.scene.primitives.add(flightState._billboardCollection);
      registerSpriteCollection('military', flightState._billboardCollection);
      flightState._modelCollection = new Cesium.PrimitiveCollection();
      viewer.scene.primitives.add(flightState._modelCollection);
      // Warm the glTF cache so the tracked plane's model instantiates instantly when first needed
      // (keeps the retained instance referenced; never rendered). Captured against this epoch so a
      // destroy/re-init mid-load doesn't flip the flag for a torn-down lifecycle.
      if (!flightState._preloadModel) {
        const epoch = flightState._modelEpoch;
        Cesium.Model.fromGltfAsync({
          url: resolveAsset(JET_MODEL_URL),
          asynchronous: false,
        })
          .then((m) => {
            if (epoch === flightState._modelEpoch) {
              flightState._preloadModel = m;
              flightState._planeModelLoaded = true;
            } else {
              try {
                m.destroy();
              } catch {
                /* gone */
              }
            }
          })
          .catch(() => {
            /* tracked plane just stays a billboard a beat longer */
          });
      }
      flightState._billboards = new Map();
      flightState._cullPositions.clear();
      flightState._detectionObjects = new Map();
      flightState.records.data = new Map();
      flightState._positionHistory = new Map();
      flightState._displayCourse.clear();
      flightState._groundSnap.clear();
      flightState.feed._count = 0;
      flightState.feed._lastUpdate = null;
      flightState.feed._backoff = false;
      flightState.feed._retryAt = 0;
      flightState.feed._lastError = null;
      flightState.feed._lastStatus = null;
      flightState._trackedIcao = null;
      parts.tracking._resetTrackedSelectionState();
      flightState._trackedEntity = null;
      flightState._cockpitSubjectId = null;
      flightState._cockpitContactMode =
        document.body.classList.contains('cockpit-mode');
      flightState._cockpitNearContacts = new Set();
      if (!flightState._cockpitModeListener) {
        flightState._cockpitModeListener = (event) =>
          parts.tracking._applyCockpitState(event?.detail);
        window.addEventListener(
          'gev:cockpit-mode-changed',
          flightState._cockpitModeListener,
        );
      }

      parts.tracking._installClickHandler(viewer);

      restoreSpriteOrder(viewer);

      console.log('[Data:Military] Initialized with billboard icons');
    },

    /**
     * Show the layer and re-install the click handler.
     * @param {Cesium.Viewer} viewer - The Cesium viewer instance
     */
    enable(viewer) {
      if (flightState._billboardCollection)
        flightState._billboardCollection.show = true;
      holdContinuousRender('military'); // per-frame animator (perf wave 2)
      if (flightState._modelCollection)
        flightState._modelCollection.show = true;
      parts.tracking._setCockpitContactMode(
        document.body.classList.contains('cockpit-mode'),
      );
      // Height-datum fix: warm the geoid grid once per layer-enable. The poll loop
      // only reads geoidHeight() synchronously after this resolves (guarded by
      // _geoidReady) — never awaited per-aircraft, never blocking a poll tick.
      if (!flightState.records.geoidReady) {
        const lifetime = flightState.lifetime;
        ensureGeoidReady()
          .then(() => {
            if (!lifetime.signal.aborted) flightState.records.geoidReady = true;
          })
          .catch(() => {
            /* geoid grid failed to load — baro path stays un-geoid-corrected until retried */
          });
      }
      parts.tracking._installClickHandler(viewer);
      registerPickOwner('military', (pickedId) =>
        flightState._billboards.has(pickedId),
      );
      // The flights layer suppresses its military duplicates while we render them
      setMilitaryLayerActive(true);
      // Force a fresh rotation pass on the first tick after re-enable
      flightState._lastCamPoseSig = '';
      if (!flightState._preRenderRemove && viewer?.scene) {
        flightState._preRenderRemove = viewer.scene.preRender.addEventListener(
          parts.rendering._fleetTick,
        );
      }
      if (!flightState._trackedModelPreUpdateRemove && viewer?.scene) {
        flightState._trackedModelPreUpdateRemove =
          viewer.scene.preUpdate.addEventListener(
            parts.rendering._updateTrackedModel,
          );
      }
      if (!flightState._moveEndRemove && viewer?.camera) {
        // Arrival polish (mirror of flights.js — see the comment there): a settled
        // camera move forces a full rotation pass on the very next frame, because
        // the pose-signature gate can eat the settle (final easing frames land
        // inside one quantization bucket) and leave stale noses for up to
        // ROTATION_REFRESH_MS. One extra pass per gesture — nothing per-frame.
        flightState._moveEndRemove = viewer.camera.moveEnd.addEventListener(
          () => {
            flightState._lastCamPoseSig = '';
            flightState._lastFleetTickMs = 0;
          },
        );
      }
      restoreSpriteOrder(viewer);
    },

    /**
     * Hide the layer, clear any active tracking, and remove input handlers
     * so clicks do not get intercepted while the layer is off.
     * @param {Cesium.Viewer} viewer - The Cesium viewer instance
     */
    disable(viewer) {
      parts.controller._abortActiveUpdates();
      parts.tracking._cancelPendingTrackingRestore();
      if (flightState._billboardCollection)
        flightState._billboardCollection.show = false;
      releaseContinuousRender('military');
      parts.rendering._releaseModels();
      if (flightState._modelCollection)
        flightState._modelCollection.show = false;
      parts.tracking._clearTracking();
      parts.tracking._destroyTrail();
      // Remove click handler + keydown listener while disabled to avoid
      // intercepting input when the layer is off
      if (flightState._clickHandler) {
        flightState._clickHandler.destroy();
        flightState._clickHandler = null;
      }
      if (flightState._trackedEntityChangedRemove) {
        flightState._trackedEntityChangedRemove();
        flightState._trackedEntityChangedRemove = null;
      }
      document.removeEventListener('keydown', parts.tracking._onKeyDown);
      unregisterPickOwner('military');
      // Flights layer takes over rendering known-military aircraft (amber)
      setMilitaryLayerActive(false);
      if (flightState._preRenderRemove) {
        flightState._preRenderRemove();
        flightState._preRenderRemove = null;
      }
      if (flightState._trackedModelPreUpdateRemove) {
        flightState._trackedModelPreUpdateRemove();
        flightState._trackedModelPreUpdateRemove = null;
      }
      if (flightState._moveEndRemove) {
        flightState._moveEndRemove();
        flightState._moveEndRemove = null;
      }
    },

    /**
     * Tear down the layer: clear tracking, remove handlers, remove the billboard
     * collection from the scene, and release all state.
     * @param {Cesium.Viewer} viewer - The Cesium viewer instance
     */
    destroy(viewer) {
      flightState.lifetime.abort();
      parts.controller._abortActiveUpdates();
      releaseContinuousRender('military'); // direct-destroy path (perf wave 2 fix)
      parts.tracking._clearTracking();
      parts.tracking._destroyTrail();
      parts.tracking._cancelPendingTrackingRestore();
      if (flightState._clickHandler) {
        flightState._clickHandler.destroy();
        flightState._clickHandler = null;
      }
      if (flightState._trackedEntityChangedRemove) {
        flightState._trackedEntityChangedRemove();
        flightState._trackedEntityChangedRemove = null;
      }
      document.removeEventListener('keydown', parts.tracking._onKeyDown);
      if (flightState._cockpitModeListener) {
        window.removeEventListener(
          'gev:cockpit-mode-changed',
          flightState._cockpitModeListener,
        );
        flightState._cockpitModeListener = null;
      }
      unregisterPickOwner('military');
      if (flightState._preRenderRemove) {
        flightState._preRenderRemove();
        flightState._preRenderRemove = null;
      }
      if (flightState._trackedModelPreUpdateRemove) {
        flightState._trackedModelPreUpdateRemove();
        flightState._trackedModelPreUpdateRemove = null;
      }
      if (flightState._moveEndRemove) {
        flightState._moveEndRemove();
        flightState._moveEndRemove = null;
      }
      parts.rendering._releaseModels();
      if (flightState._billboardCollection) {
        viewer.scene.primitives.remove(flightState._billboardCollection);
        flightState._billboardCollection = null;
      }
      if (flightState._modelCollection) {
        viewer.scene.primitives.remove(flightState._modelCollection); // removing destroys it + its models
        flightState._modelCollection = null;
      }
      flightState._modelEpoch += 1; // invalidate any in-flight load from this lifecycle (settles post-destroy)
      flightState._modelPending.clear();
      flightState._modelGen.clear();
      if (flightState._preloadModel) {
        try {
          flightState._preloadModel.destroy();
        } catch {
          /* gone */
        }
        flightState._preloadModel = null;
      }
      flightState._planeModelLoaded = false;
      flightState._billboards.clear();
      flightState._cullPositions.clear();
      flightState._detectionObjects.clear();
      flightState.records.data.clear();
      flightState._positionHistory.clear();
      flightState._displayCourse.clear();
      flightState._groundSnap.clear();
      flightState.records.missingPolls.clear();
      flightState.feed._count = 0;
      flightState.feed._lastUpdate = null;
      flightState._cockpitContactMode = false;
      flightState._cockpitNearContacts = new Set();
      flightState._cockpitSubjectId = null;
      flightState.feed._trackingRefreshEpoch += 1;
      flightState.feed._lastTrackingRefreshOutcome = {
        epoch: flightState.feed._trackingRefreshEpoch,
        status: 'destroyed',
        ids: new Set(),
        source: flightState.feed._lastSource,
      };
      parts.tracking._resetTrackedSelectionState(); // next lifecycle re-evaluates against the ENTER ceiling
      flightState._viewer = null;
    },
  };

  return { methods };
}
