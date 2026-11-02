import * as Cesium from 'cesium';
import { PLANE_MODEL_URL } from './policy.js';

export function createLifecycle({
  flightState,
  services,
  parts,
  layer,
  resolveAsset,
}) {
  const { clearFocusTarget } = services.focus;
  const {
    registerSpriteCollection,
    restoreSpriteOrder,
    restoreSpriteOrderOnEnable,
  } = services.sprites;
  const { onMilitaryLayerActiveChange } = services.militaryRegistry;
  const { holdContinuousRender, releaseContinuousRender } = services.render;
  const { ensureGeoidReady } = services.geoid;
  const { registerPickOwner, unregisterPickOwner } = services.picking;

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
     * Initialize the flights layer.
     * Creates the BillboardCollection, resets all state, and installs the
     * click-to-track handler on the scene canvas.
     * @param {Cesium.Viewer} viewer - The CesiumJS viewer instance.
     */
    init(viewer) {
      if (flightState._viewer)
        throw new Error('Flight layer is already initialized');
      if (typeof flightState.feed._source?.getSnapshot !== 'function')
        throw new TypeError('A snapshot source is required');
      if (flightState.lifetime.signal.aborted)
        flightState.lifetime = new AbortController();
      clearFocusTarget('flights');
      flightState._focusEvidenceIds.clear();
      flightState._viewer = viewer;
      flightState._billboardCollection = new Cesium.BillboardCollection();
      viewer.scene.primitives.add(flightState._billboardCollection);
      registerSpriteCollection('flights', flightState._billboardCollection);
      flightState._modelCollection = new Cesium.PrimitiveCollection();
      viewer.scene.primitives.add(flightState._modelCollection);
      // Warm the glTF cache so the tracked plane's model instantiates instantly when first needed
      // (keeps the retained instance referenced; never rendered). Captured against this epoch so a
      // destroy/re-init mid-load doesn't flip the flag for a torn-down lifecycle.
      if (!flightState._preloadModel) {
        const epoch = flightState._modelEpoch;
        Cesium.Model.fromGltfAsync({
          url: resolveAsset(PLANE_MODEL_URL),
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
      flightState.feed._lastSource =
        flightState.feed._source.label || 'Aircraft';
      flightState.feed._lastCoverage = 'worldwide upstream snapshot';
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
      // Fresh session — full bucket, anchor re-seeded on the first sweep.
      flightState._enrichAmbientBudget =
        parts.enrichment._ambientBudgetKnobs().ceil;
      flightState._enrichAmbientRefillAnchorMs = 0;

      parts.tracking._installClickHandler(viewer);

      // React to Military-layer toggles IMMEDIATELY (suppress/restore sweep)
      // instead of waiting out the 30 s poll (M2).
      if (!flightState._milActiveChangeUnsub) {
        flightState._milActiveChangeUnsub = onMilitaryLayerActiveChange(
          parts.tracking._onMilitaryActiveChange,
        );
      }

      restoreSpriteOrder(viewer);

      console.log('[Data:Flights] Initialized with billboard icons');
    },

    /**
     * Show the billboard collection and re-install the click handler.
     * @param {Cesium.Viewer} viewer
     */
    enable(viewer) {
      if (flightState._billboardCollection)
        flightState._billboardCollection.show = true;
      holdContinuousRender('flights'); // per-frame animator (perf wave 2)
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
      registerPickOwner('flights', (pickedId) =>
        flightState._billboards.has(pickedId),
      );
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
        // Arrival polish (field test 2026-07-03: "planes look weird when you first
        // come to them"): when a camera move SETTLES (voice fly-to, fast pan
        // release), force a full rotation pass on the very next frame. The
        // pose-signature gate alone can eat the settle — the final easing frames
        // of a flight land inside one quantization bucket (10 m / 0.06°), leaving
        // every icon wearing its last mid-flight rotation for up to
        // ROTATION_REFRESH_MS. Zeroing the tick throttle too means the pass runs
        // on the next preRender, not up to FLEET_DR_INTERVAL_MS later. Cost: one
        // extra rotation pass per completed camera gesture — nothing per-frame.
        flightState._moveEndRemove = viewer.camera.moveEnd.addEventListener(
          () => {
            flightState._lastCamPoseSig = '';
            flightState._lastFleetTickMs = 0;
          },
        );
      }
      restoreSpriteOrderOnEnable('flights', viewer);
    },

    /**
     * Hide all flight billboards and tear down click/keyboard handlers.
     * Also clears any active flight tracking so the camera is released.
     * @param {Cesium.Viewer} viewer
     */
    disable(viewer) {
      parts.controller._abortActiveUpdates();
      parts.tracking._cancelPendingTrackingRestore();
      if (flightState._billboardCollection)
        flightState._billboardCollection.show = false;
      releaseContinuousRender('flights');
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
      unregisterPickOwner('flights');
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
     * Fully tear down the flights layer — remove primitives, handlers,
     * tracked entities, and clear all internal state maps.
     * @param {Cesium.Viewer} viewer
     */
    destroy(viewer) {
      flightState.lifetime.abort();
      flightState._enrichActive = 0;
      flightState._enrichLastDispatchMs = 0;
      parts.controller._abortActiveUpdates();
      releaseContinuousRender('flights'); // direct-destroy path (perf wave 2 fix)
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
      if (flightState._milActiveChangeUnsub) {
        flightState._milActiveChangeUnsub();
        flightState._milActiveChangeUnsub = null;
      }
      document.removeEventListener('keydown', parts.tracking._onKeyDown);
      if (flightState._cockpitModeListener) {
        window.removeEventListener(
          'gev:cockpit-mode-changed',
          flightState._cockpitModeListener,
        );
        flightState._cockpitModeListener = null;
      }
      unregisterPickOwner('flights');
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
      flightState._displayFloorState.clear();
      flightState._enrichQueue.length = 0;
      flightState._enrichSeen.clear();
      if (flightState._enrichDripTimer) {
        clearTimeout(flightState._enrichDripTimer);
        flightState._enrichDripTimer = null;
      }
      flightState.records.missingPolls.clear();
      flightState._focusEvidenceIds.clear();
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
        coverage: flightState.feed._lastCoverage,
      };
      parts.tracking._resetTrackedSelectionState(); // next lifecycle re-evaluates against the ENTER ceiling
      flightState._viewer = null;
    },
  };

  return { methods };
}
