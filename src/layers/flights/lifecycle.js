import { findCamera, findFrame } from '../../render/rendererOf.js';
import { PLANE_MODEL_URL } from './policy.js';

export function createLifecycle({
  flightState,
  services,
  parts,
  layer,
  resolveAsset,
}) {
  const { clearFocusTarget } = services.focus;
  const { registerSpriteSet, restoreSpriteOrder, restoreSpriteOrderOnEnable } =
    services.sprites;
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
     * Creates the icon set and its primitive, resets all state, and installs the
     * click-to-track handler on the scene canvas.
     * @param {object} viewer - The viewer.
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
      registerSpriteSet('flights', parts.icons._createIcons(viewer));
      // The models' draw sets; a hidden item keeps the tracked asset loaded so
      // the tracked plane's model draws as soon as it is wanted.
      parts.rendering._createModelSets(viewer, {
        preloadUrl: resolveAsset(PLANE_MODEL_URL),
      });
      flightState._grounded.clear();
      flightState._floorPinned.clear();
      flightState._iconFocusActive = 0;
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

      console.log('[Data:Flights] Initialized with GPU icons');
    },

    /**
     * Show the icons and re-install the click handler.
     * @param {object} viewer
     */
    enable(viewer) {
      if (flightState._icons) flightState._icons.show = true;
      holdContinuousRender('flights'); // per-frame animator (perf wave 2)
      parts.rendering._setModelsShown(true);
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
      registerPickOwner(
        'flights',
        (pickedId) => flightState._icons?.has(pickedId) === true,
      );
      const frame = findFrame(viewer);
      if (!flightState._preRenderRemove && frame) {
        flightState._preRenderRemove = frame.on('preRender', () =>
          parts.rendering._fleetTick(),
        );
      }
      if (!flightState._trackedModelPreUpdateRemove && frame) {
        flightState._trackedModelPreUpdateRemove = frame.on('preUpdate', () =>
          parts.rendering._updateTrackedModel(),
        );
      }
      const camera = findCamera(viewer);
      if (!flightState._moveEndRemove && camera) {
        // A settled camera move (voice fly-to, fast pan release) runs the fleet
        // pass on the very next preRender rather than up to FLEET_DR_INTERVAL_MS
        // later, so the model handoff and focus land with the camera.
        flightState._moveEndRemove = camera.on('moveEnd', () => {
          flightState._lastFleetTickMs = 0;
        });
      }
      restoreSpriteOrderOnEnable('flights', viewer);
    },

    /**
     * Hide all flight icons and tear down click/keyboard handlers.
     * Also clears any active flight tracking so the camera is released.
     * @param {object} viewer
     */
    disable(viewer) {
      parts.controller._abortActiveUpdates();
      parts.tracking._cancelPendingTrackingRestore();
      if (flightState._icons) flightState._icons.show = false;
      releaseContinuousRender('flights');
      parts.rendering._releaseModels();
      parts.rendering._setModelsShown(false);
      parts.tracking._clearTracking();
      parts.tracking._destroyTrail();
      // Remove click handler + keydown listener while disabled to avoid
      // intercepting input when the layer is off
      flightState._clickSubscription?.();
      flightState._clickSubscription = null;
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
     * @param {object} viewer
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
      flightState._clickSubscription?.();
      flightState._clickSubscription = null;
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
      parts.icons._disposeIcons();
      parts.tracking._disposeTrackedIcon();
      parts.rendering._disposeModelSets();
      flightState._grounded.clear();
      flightState._floorPinned.clear();
      flightState._iconFocusActive = 0;
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
