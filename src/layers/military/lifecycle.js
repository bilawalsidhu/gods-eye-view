import { createAircraftSceneBinding } from '../aircraft/sceneBinding.js';

export function createLifecycle({ flightState, services, parts, layer }) {
  const { clearFocusTarget } = services.focus;
  const { holdContinuousRender, releaseContinuousRender } = services.render;
  const { ensureGeoidReady } = services.geoid;
  const { registerPickOwner } = services.picking;
  const { setMilitaryLayerActive } = services.militaryRegistry;

  const binding = createAircraftSceneBinding({
    id: 'military',
    flightState,
    services,
    parts,
    enable: () => methods.enable(),
  });
  const picks = {
    owner: 'military',
    predicate: (pickedId) => flightState._billboards.has(pickedId),
  };
  const methods = {
    picks,
    attachRenderer: binding.attachRenderer,
    cameraOwner: binding.cameraOwner,
    show: binding.show,
    detachRenderer: binding.detachRenderer,
    /** Configure the source before initialization; an active layer keeps its owner. */
    setSource(source) {
      if (flightState.initialized)
        throw new Error('Configure the source before layer initialization');
      if (typeof source?.getSnapshot !== 'function')
        throw new TypeError('A snapshot source is required');
      flightState.feed._source = source;
      flightState.feed._lastSource =
        source.label || flightState.feed._lastSource;
      this.source = flightState.feed._lastSource;
    },

    /**
     * Initialize the layer: create the engine's aircraft renderer (fleet
     * sprites, models), reset all state, and join the engine's selection
     * dispatcher.
     * @param {object|null} viewer - The Cesium viewer (null on an engine
     *   without one).
     * @param {{ engine?: object }} [context] - LayerLifecycle's context.
     */
    init(viewer, { engine = null } = {}) {
      if (flightState.initialized)
        throw new Error('Flight layer is already initialized');
      if (typeof flightState.feed._source?.getSnapshot !== 'function')
        throw new TypeError('A snapshot source is required');
      if (flightState.lifetime.signal.aborted)
        flightState.lifetime = new AbortController();
      clearFocusTarget('militaryFlights');
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
        globalThis.document?.body.classList.contains('cockpit-mode') === true;
      flightState._cockpitNearContacts = new Set();
      if (globalThis.window && !flightState._cockpitModeListener) {
        flightState._cockpitModeListener = (event) =>
          parts.tracking._applyCockpitState(event?.detail);
        window.addEventListener(
          'gev:cockpit-mode-changed',
          flightState._cockpitModeListener,
        );
      }

      flightState.initialized = true;
      try {
        if (viewer || engine) binding.attachRenderer({ engine });
      } catch (error) {
        methods.destroy(viewer);
        throw error;
      }
    },

    /**
     * Show the layer and re-join the selection dispatcher.
     */
    enable() {
      const renderer = flightState._renderer;
      flightState.enabled = true;
      renderer?.fleet.setVisible(true);
      if (renderer)
        holdContinuousRender('military', flightState._renderer?.engine); // per-frame animator
      renderer?.models.setVisible(true);
      parts.tracking._setCockpitContactMode(
        globalThis.document?.body.classList.contains('cockpit-mode') === true,
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
      setMilitaryLayerActive(true);
      if (!renderer) return;
      parts.tracking._installClickHandler();
      registerPickOwner(
        picks.owner,
        picks.predicate,
        flightState._renderer?.engine,
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
        // Arrival polish (mirror of flights.js — see the comment there): a settled
        // camera move forces a full rotation pass on the very next frame, because
        // the pose-signature gate can eat the settle (final easing frames land
        // inside one quantization bucket) and leave stale noses for up to
        // ROTATION_REFRESH_MS. One extra pass per gesture — nothing per-frame.
        flightState._moveEndRemove = renderer.view.on('moveEnd', () => {
          flightState._lastCamPoseSig = '';
          flightState._lastFleetTickMs = 0;
        });
      }
      renderer?.fleet.restoreOrder();
    },

    /**
     * Hide the layer, clear any active tracking, and leave the selection
     * dispatcher so clicks do not get intercepted while the layer is off.
     */
    disable() {
      flightState.enabled = false;
      parts.controller._abortActiveUpdates();
      parts.tracking._cancelPendingTrackingRestore();
      flightState._renderer?.fleet.setVisible(false);
      releaseContinuousRender('military', flightState._renderer?.engine);
      parts.rendering._releaseModels();
      flightState._renderer?.models.setVisible(false);
      parts.tracking._clearTracking();
      parts.tracking._destroyTrail();
      binding.removeSceneListeners();
      setMilitaryLayerActive(false);
    },

    /**
     * Tear down the layer: clear tracking, remove handlers, remove its
     * drawings, and release all state.
     * @param {object|null} viewer - The viewer the layer was drawn on.
     */
    destroy(viewer) {
      flightState.initialized = false;
      flightState.enabled = false;
      setMilitaryLayerActive(false);
      flightState.lifetime.abort();
      parts.controller._abortActiveUpdates();
      releaseContinuousRender('military', flightState._renderer?.engine); // direct-destroy path (perf wave 2 fix)
      parts.tracking._clearTracking();
      parts.tracking._destroyTrail();
      parts.tracking._cancelPendingTrackingRestore();
      parts.tracking._removeClickHandler();
      if (flightState._cockpitModeListener) {
        window.removeEventListener(
          'gev:cockpit-mode-changed',
          flightState._cockpitModeListener,
        );
        flightState._cockpitModeListener = null;
      }
      binding.detachRenderer(viewer);
      flightState.records.data.clear();
      flightState._positionHistory.clear();
      flightState._displayCourse.clear();
      flightState._groundSnap.clear();
      flightState.records.missingPolls.clear();
      flightState.records.geoidNCache.clear();
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
    },
  };

  return { methods };
}
