import { VESSEL_OVERLAY_SOURCE_ID } from '../../data/vesselLabels.js';
import { t } from '../../i18n/index.js';
import { AIS_FIRST_CONNECT_GRACE_MS, AIS_HEALTHY_STATUSES } from './policy.js';

export function createLifecycle({
  vesselState,
  services,
  parts: components,
  layer,
  options,
}) {
  const { state } = vesselState;
  const { restoreSpriteOrder, restoreSpriteOrderOnEnable } = services.sprites;
  const { holdContinuousRender, releaseContinuousRender } = services.render;
  const { ensureGeoidReady } = services.geoid;
  const { registerPickOwner, unregisterPickOwner } = services.picking;

  function clearFirstConnectTimer() {
    if (state.firstConnectTimer === null) return;
    vesselState._aisRuntime.clearTimeout(state.firstConnectTimer);
    state.firstConnectTimer = null;
  }

  function invalidateAisSession() {
    clearFirstConnectTimer();
    state.sessionId = ++vesselState._aisSessionSequence;
    state.firstConnectPhase = 'idle';
    state.firstConnectStartedAt = null;
    state.firstConnectDeadline = null;
  }

  function beginAisSession() {
    clearFirstConnectTimer();
    const sessionId = ++vesselState._aisSessionSequence;
    const startedAt = vesselState._aisRuntime.now();
    state.sessionId = sessionId;
    state.firstConnectPhase = 'loading';
    state.firstConnectStartedAt = startedAt;
    state.firstConnectDeadline = startedAt + AIS_FIRST_CONNECT_GRACE_MS;
    state.error = null;
    state.loadingLabel = t('layers.vessel.awaitingFirstPosition');
    scheduleFirstConnectExpiry(sessionId, AIS_FIRST_CONNECT_GRACE_MS);
  }

  function scheduleFirstConnectExpiry(sessionId, delayMs) {
    state.firstConnectTimer = vesselState._aisRuntime.setTimeout(() => {
      if (
        !state.enabled ||
        state.sessionId !== sessionId ||
        state.firstConnectPhase !== 'loading'
      )
        return;
      const remainingMs =
        state.firstConnectDeadline - vesselState._aisRuntime.now();
      if (remainingMs > 0) {
        scheduleFirstConnectExpiry(sessionId, remainingMs);
        return;
      }
      state.firstConnectTimer = null;
      state.firstConnectPhase = 'unavailable';
      state.loadingLabel = '';
      state.error = state.lastMessageAt
        ? t('layers.vessel.awaitingPositions')
        : t('layers.vessel.awaitingFirstMessage');
      state.stale = state.count > 0;
    }, delayMs);
  }

  function settleFirstConnectPhase(phase) {
    clearFirstConnectTimer();
    state.firstConnectPhase = phase;
    state.loadingLabel = '';
  }

  function isGraceEligibleTransport(status) {
    return AIS_HEALTHY_STATUSES.has(status) || status === 'connecting';
  }

  function isDefinitiveTransportFailure(status) {
    return Boolean(status) && !isGraceEligibleTransport(status);
  }

  function markAisUnavailable(reason) {
    settleFirstConnectPhase('unavailable');
    state.error = reason || 'AIS live load failed';
    state.stale = state.count > 0;
  }

  function resetState() {
    state.abort?.abort();
    state.trailAbort?.abort();
    state.trailAbort = null;
    clearFirstConnectTimer();
    state.viewer = null;
    state.enabled = false;
    state.loading = false;
    state.loaded = false;
    state.stale = false;
    state.error = null;
    state.loadingLabel = '';
    state.lastUpdate = null;
    state.count = 0;
    state.newestPositionAt = null;
    state.transportStatus = null;
    state.nextAttemptAt = null;
    state.lastMessageAt = null;
    state.rawRowCount = 0;
    state.acceptedRowCount = 0;
    state.sessionId = ++vesselState._aisSessionSequence;
    state.firstConnectPhase = 'idle';
    state.firstConnectStartedAt = null;
    state.firstConnectDeadline = null;
    state.firstConnectTimer = null;
    state.abort = null;
    state.billboardCollection = null;
    state.vesselRecords = [];
    state.vesselMap = new Map();
    state.unkeyedRecords = [];
    state.clickHandler = null;
    state.keyTarget = null;
    state.keydownHandler = null;
    state.trackedEntityRemover = null;
    state.interactionHandlerFactory = null;
    state.interactionKeyTarget = null;
    state.preRenderRemover = null;
    state.lastVisibilityUpdate = 0;
    state.lastFocusUpdate = 0;
    state.activeFocusCount = 0;
    state.activeLabelCount = 0;
    state.selectedRecord = null;
    state.trail = null;
    state.trailPositions = [];
    state.trailMmsi = null;
    state.trailBackfillToken = 0;
  }
  const methods = {
    /** Configure the source before initialization; an active layer keeps its owner. */
    setSource(source) {
      if (state.viewer)
        throw new Error('Configure the source before layer initialization');
      if (typeof source?.getSnapshot !== 'function')
        throw new TypeError('A snapshot source is required');
      vesselState._source = source;
      this.source = source.label || this.source;
    },

    init(viewer) {
      if (typeof vesselState._source?.getSnapshot !== 'function')
        throw new TypeError('A snapshot source is required');
      state.viewer = viewer;
      components.rendering.ensureCollections(viewer);
      vesselState._vesselOverlayHost.setVisible(
        VESSEL_OVERLAY_SOURCE_ID,
        false,
      );
      components.selection.installInteraction(viewer);
      components.rendering.installRuntime(viewer);
      restoreSpriteOrder(viewer);
    },

    enable(viewer) {
      const wasEnabled = state.enabled;
      state.enabled = true;
      if (!wasEnabled) beginAisSession();
      holdContinuousRender('ais-vessels'); // per-frame animator (perf wave 2)
      const activeViewer = viewer || state.viewer;
      components.rendering.ensureCollections(activeViewer);
      components.selection.installInteraction(activeViewer);
      components.rendering.setVisible(true);
      // Height-datum fix: warm the geoid grid once per layer-enable, never
      // blocking a poll. The first refresh may land pre-resolve (N = 0), and
      // the next is up to 60 s out — so re-floor in place on resolve. A load
      // failure leaves N = 0 forever, which is safe: sprites are depth-test-
      // free, so vessels stay visible either way.
      if (!vesselState._geoidReady) {
        const sessionId = state.sessionId;
        ensureGeoidReady()
          .then(() => {
            if (!state.enabled || state.sessionId !== sessionId) return;
            vesselState._geoidReady = true;
            components.tracking.refloorVesselRecords();
          })
          .catch(() => {
            /* grid failed to load — anchors stay at ellipsoid 0 */
          });
      }
      // Pick-ownership (H2): vessel picks carry the record OBJECT as their id;
      // the registry resolver reduces it to the record's mmsi (a string key).
      registerPickOwner('ais-live-vessels', (pickedId) =>
        state.vesselMap.has(pickedId),
      );
      restoreSpriteOrderOnEnable('ais', activeViewer);
      return components.ingestion.loadLivePositions(activeViewer);
    },

    disable() {
      state.enabled = false;
      invalidateAisSession();
      releaseContinuousRender('ais-vessels');
      unregisterPickOwner('ais-live-vessels');
      components.rendering.setVisible(false);
      vesselState._vesselOverlayHost.clearSource(VESSEL_OVERLAY_SOURCE_ID);
      components.selection.clearVesselInspection();
      components.tracking.destroySelectedVesselTrail();
      components.selection.removeVesselInteraction();
      if (state.abort) {
        state.abort.abort();
        state.abort = null;
      }
      state.loading = false;
      state.loadingLabel = '';
    },

    destroy(viewer) {
      const activeViewer = viewer || state.viewer;
      invalidateAisSession();
      releaseContinuousRender('ais-vessels'); // direct-destroy path (perf wave 2 fix)
      if (state.abort) state.abort.abort();
      unregisterPickOwner('ais-live-vessels');
      components.selection.clearVesselInspection();
      components.tracking.destroySelectedVesselTrail();
      if (state.billboardCollection && activeViewer?.scene?.primitives) {
        activeViewer.scene.primitives.remove(state.billboardCollection);
      }
      vesselState._vesselOverlayHost.clearSource(VESSEL_OVERLAY_SOURCE_ID);
      vesselState._vesselOverlayHost.setVisible(
        VESSEL_OVERLAY_SOURCE_ID,
        false,
      );
      components.selection.removeVesselInteraction();
      if (state.preRenderRemover) {
        state.preRenderRemover();
      }
      resetState();
    },
  };

  return {
    clearFirstConnectTimer,
    invalidateAisSession,
    beginAisSession,
    scheduleFirstConnectExpiry,
    settleFirstConnectPhase,
    isGraceEligibleTransport,
    isDefinitiveTransportFailure,
    markAisUnavailable,
    resetState,
    methods,
  };
}
