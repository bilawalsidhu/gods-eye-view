import { PLANE_MODEL_URL } from './policy.js';

export function createLifecycle({
  flightState,
  services,
  parts,
  layer,
  resolveAsset,
}) {
  const { clearFocusTarget } = services.focus;
  const { onMilitaryLayerActiveChange } = services.militaryRegistry;
  const { holdContinuousRender, releaseContinuousRender } = services.render;
  const { ensureGeoidReady } = services.geoid;
  const { registerPickOwner, unregisterPickOwner } = services.picking;

  const methods = {
    /** Configure the source before initialization; an active layer keeps its owner. */
    setSource(source) {
      if (flightState._renderer)
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
     * Creates the engine's aircraft renderer (fleet sprites, models), resets
     * all state, and joins the engine's selection dispatcher.
     * @param {object|null} viewer - The Cesium viewer (null on an engine
     *   without one).
     * @param {{ engine?: object }} [context] - LayerLifecycle's context.
     */
    init(viewer, { engine = null } = {}) {
      if (flightState._renderer)
        throw new Error('Flight layer is already initialized');
      if (typeof flightState.feed._source?.getSnapshot !== 'function')
        throw new TypeError('A snapshot source is required');
      if (flightState.lifetime.signal.aborted)
        flightState.lifetime = new AbortController();
      clearFocusTarget('flights');
      flightState._focusEvidenceIds.clear();
      const renderer = services.renderer.create({ viewer, engine });
      flightState._renderer = renderer;
      renderer.fleet.attach();
      // Warm the glTF cache so the tracked plane's model instantiates instantly when first needed
      // (keeps the retained instance referenced; never rendered). Captured against this epoch so a
      // destroy/re-init mid-load doesn't flip the flag for a torn-down lifecycle.
      if (!flightState._preloadModel) {
        const epoch = flightState._modelEpoch;
        renderer.models
          .preload(resolveAsset(PLANE_MODEL_URL))
          .then((m) => {
            if (epoch === flightState._modelEpoch) {
              flightState._preloadModel = m;
              flightState._planeModelLoaded = true;
            } else {
              renderer.models.destroy(m);
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

      parts.tracking._installClickHandler();

      // React to Military-layer toggles IMMEDIATELY (suppress/restore sweep)
      // instead of waiting out the 30 s poll (M2).
      if (!flightState._milActiveChangeUnsub) {
        flightState._milActiveChangeUnsub = onMilitaryLayerActiveChange(
          parts.tracking._onMilitaryActiveChange,
        );
      }

      renderer.fleet.restoreOrder();

      console.log('[Data:Flights] Initialized with billboard icons');
    },

    /**
     * Show the fleet and re-join the selection dispatcher.
     */
    enable() {
      const renderer = flightState._renderer;
      renderer?.fleet.setVisible(true);
      holdContinuousRender('flights'); // per-frame animator (perf wave 2)
      renderer?.models.setVisible(true);
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
      parts.tracking._installClickHandler();
      registerPickOwner('flights', (pickedId) =>
        flightState._billboards.has(pickedId),
      );
      // Force a fresh rotation pass on the first tick after re-enable
      flightState._lastCamPoseSig = '';
      if (!flightState._preRenderRemove && renderer) {
        flightState._preRenderRemove = renderer.view.on(
          'preRender',
          parts.rendering._fleetTick,
        );
      }
      if (!flightState._trackedModelPreUpdateRemove && renderer) {
        flightState._trackedModelPreUpdateRemove = renderer.view.on(
          'preUpdate',
          parts.rendering._updateTrackedModel,
        );
      }
      if (!flightState._moveEndRemove && renderer) {
        // Arrival polish (field test 2026-07-03: "planes look weird when you first
        // come to them"): when a camera move SETTLES (voice fly-to, fast pan
        // release), force a full rotation pass on the very next frame. The
        // pose-signature gate alone can eat the settle — the final easing frames
        // of a flight land inside one quantization bucket (10 m / 0.06°), leaving
        // every icon wearing its last mid-flight rotation for up to
        // ROTATION_REFRESH_MS. Zeroing the tick throttle too means the pass runs
        // on the next preRender, not up to FLEET_DR_INTERVAL_MS later. Cost: one
        // extra rotation pass per completed camera gesture — nothing per-frame.
        flightState._moveEndRemove = renderer.view.on('moveEnd', () => {
          flightState._lastCamPoseSig = '';
          flightState._lastFleetTickMs = 0;
        });
      }
      renderer?.fleet.restoreOrderOnEnable();
    },

    /**
     * Hide all flight billboards and leave the selection dispatcher.
     * Also clears any active flight tracking so the camera is released.
     */
    disable() {
      parts.controller._abortActiveUpdates();
      parts.tracking._cancelPendingTrackingRestore();
      flightState._renderer?.fleet.setVisible(false);
      releaseContinuousRender('flights');
      parts.rendering._releaseModels();
      flightState._renderer?.models.setVisible(false);
      parts.tracking._clearTracking();
      parts.tracking._destroyTrail();
      // Leave the selection dispatcher (clicks, Escape) while disabled to
      // avoid intercepting input when the layer is off
      parts.tracking._removeClickHandler();
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
     * Fully tear down the flights layer — remove its drawings, handlers,
     * the tracked visual, and clear all internal state maps.
     * @param {object|null} viewer - The viewer the layer was drawn on.
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
      parts.tracking._removeClickHandler();
      if (flightState._milActiveChangeUnsub) {
        flightState._milActiveChangeUnsub();
        flightState._milActiveChangeUnsub = null;
      }
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
      // Removing the model collection destroys it and its models.
      flightState._renderer?.fleet.detach(viewer);
      flightState._modelEpoch += 1; // invalidate any in-flight load from this lifecycle (settles post-destroy)
      flightState._modelPending.clear();
      flightState._modelGen.clear();
      if (flightState._preloadModel) {
        flightState._renderer?.models.destroy(flightState._preloadModel);
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
      flightState._renderer?.destroy();
      flightState._renderer = null;
    },
  };

  return { methods };
}
