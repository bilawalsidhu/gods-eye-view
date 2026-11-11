import { VESSEL_OVERLAY_SOURCE_ID } from '../../data/vesselLabels.js';
import { msg, t } from '../../i18n/index.js';
import { AIS_FIRST_CONNECT_GRACE_MS, AIS_HEALTHY_STATUSES } from './policy.js';

export function createLifecycle({
  vesselState,
  services,
  parts: components,
  layer,
  options,
}) {
  const { state } = vesselState;
  const { restoreSpriteOrderOnEnable } = services.sprites;
  const { releaseContinuousRender } = services.render;
  const { ensureGeoidReady } = services.geoid;
  const { registerPickOwner, unregisterPickOwner } = services.picking;

  function clearFirstConnectTimer() {
    if (state.feed.firstConnectTimer === null) return;
    vesselState._aisRuntime.clearTimeout(state.feed.firstConnectTimer);
    state.feed.firstConnectTimer = null;
  }

  function invalidateAisSession() {
    clearFirstConnectTimer();
    state.feed.sessionId = ++vesselState._aisSessionSequence;
    state.feed.firstConnectPhase = 'idle';
    state.feed.firstConnectStartedAt = null;
    state.feed.firstConnectDeadline = null;
  }

  function beginAisSession() {
    clearFirstConnectTimer();
    const sessionId = ++vesselState._aisSessionSequence;
    const startedAt = vesselState._aisRuntime.now();
    state.feed.sessionId = sessionId;
    state.feed.firstConnectPhase = 'loading';
    state.feed.firstConnectStartedAt = startedAt;
    state.feed.firstConnectDeadline = startedAt + AIS_FIRST_CONNECT_GRACE_MS;
    state.feed.error = null;
    state.feed.loadingLabel = t('awaiting first AIS position…');
    scheduleFirstConnectExpiry(sessionId, AIS_FIRST_CONNECT_GRACE_MS);
  }

  function scheduleFirstConnectExpiry(sessionId, delayMs) {
    state.feed.firstConnectTimer = vesselState._aisRuntime.setTimeout(() => {
      if (
        !state.feed.enabled ||
        state.feed.sessionId !== sessionId ||
        state.feed.firstConnectPhase !== 'loading'
      )
        return;
      const remainingMs =
        state.feed.firstConnectDeadline - vesselState._aisRuntime.now();
      if (remainingMs > 0) {
        scheduleFirstConnectExpiry(sessionId, remainingMs);
        return;
      }
      state.feed.firstConnectTimer = null;
      state.feed.firstConnectPhase = 'unavailable';
      state.feed.loadingLabel = '';
      state.feed.error = state.feed.lastMessageAt
        ? t('awaiting usable AIS positions…')
        : t('awaiting first AIS message…');
      state.feed.stale = state.feed.count > 0;
    }, delayMs);
  }

  function settleFirstConnectPhase(phase) {
    clearFirstConnectTimer();
    state.feed.firstConnectPhase = phase;
    state.feed.loadingLabel = '';
  }

  function isGraceEligibleTransport(status) {
    return AIS_HEALTHY_STATUSES.has(status) || status === 'connecting';
  }

  function isDefinitiveTransportFailure(status) {
    return Boolean(status) && !isGraceEligibleTransport(status);
  }

  function markAisUnavailable(reason) {
    settleFirstConnectPhase('unavailable');
    state.feed.error = reason || msg('AIS live load failed');
    state.feed.stale = state.feed.count > 0;
  }

  function resetState() {
    components.rendering.resetRecordVisuals();
    state.feed.abort?.abort();
    state.trailAbort?.abort();
    state.trailAbort = null;
    clearFirstConnectTimer();
    state.viewer = null;
    state.feed.enabled = false;
    state.feed.loading = false;
    state.feed.loaded = false;
    state.feed.stale = false;
    state.feed.partial = false;
    state.feed.error = null;
    state.feed.loadingLabel = '';
    state.feed.lastUpdate = null;
    state.feed.count = 0;
    state.feed.newestPositionAt = null;
    state.feed.transportStatus = null;
    state.feed.nextAttemptAt = null;
    state.feed.lastMessageAt = null;
    state.feed.rawRowCount = 0;
    state.feed.acceptedRowCount = 0;
    state.feed.sessionId = ++vesselState._aisSessionSequence;
    state.feed.firstConnectPhase = 'idle';
    state.feed.firstConnectStartedAt = null;
    state.feed.firstConnectDeadline = null;
    state.feed.firstConnectTimer = null;
    state.feed.abort = null;
    state.renderer?.destroy();
    state.renderer = null;
    state.records.all = [];
    state.records.byId = new Map();
    state.records.unkeyed = [];
    state.clickHandler = null;
    state.selectionRemove = null;
    state.keyTarget = null;
    state.keydownHandler = null;
    state.trackedEntityRemover = null;
    state.interactionHandlerFactory = null;
    state.interactionKeyTarget = null;
    state.preRenderRemover = null;
    components.rendering.cancelTrailingVisibilityPass();
    state.lastVisibilityUpdate = 0;
    state.lastFocusUpdate = 0;
    state.activeFocusCount = 0;
    state.activeLabelCount = 0;
    state.selectedRecord = null;
    state.trail = null;
    state.trailPositions = [];
    state.trailId = null;
    state.trailBackfillToken = 0;
  }
  const picks = {
    owner: 'ais-live-vessels',
    predicate: (pickedId) => state.records.byId.has(pickedId),
  };
  const methods = {
    /** Configure the source before initialization; an active layer keeps its owner. */
    setSource(source) {
      // Initialized: a viewer, or an engine's renderer without one.
      if (state.viewer || state.renderer?.engine || state.feed.enabled)
        throw new Error('Configure the source before layer initialization');
      if (typeof source?.getSnapshot !== 'function')
        throw new TypeError('A snapshot source is required');
      vesselState._source = source;
      this.source = source.label || this.source;
    },

    /**
     * Creates the engine's vessel display (render/display.js), its chevron
     * bank, the click rule and the per-frame pass.
     * @param {object|null} viewer The Cesium viewer (null on an engine
     *   without one).
     * @param {{ engine?: object }} [context] LayerLifecycle's context.
     */
    init(viewer, { engine = null } = {}) {
      if (typeof vesselState._source?.getSnapshot !== 'function')
        throw new TypeError('A snapshot source is required');
      if (viewer || engine) this.attachRenderer({ engine });
    },

    show(enabled) {
      components.rendering.setVisible(enabled);
    },
    picks,
    attachRenderer({ engine = null } = {}) {
      state.viewer = null;
      state.renderer ??= createRenderer(null, engine);
      const scene = state.renderer?.view || null;
      components.rendering.ensureCollections(scene);
      components.selection.installInteraction(scene);
      components.rendering.installRuntime(scene);
      this.show(state.feed.enabled);
      const horizon = components.rendering.makeOccluder();
      for (const record of state.records.all)
        components.rendering.addRecordPrimitives(record, horizon);
      if (!state.feed.enabled) return;
      bindVisibleScene(null, scene);
      components.tracking.attachSelectedVesselTrail();
      components.rendering.updateVisibility(true);
      if (state.selectedRecord)
        components.cards.updateSelectedVesselHud(state.selectedRecord);
    },

    detachRenderer() {
      removeViewListener();
      components.selection.removeVesselInteraction();
      state.preRenderRemover?.();
      state.preRenderRemover = null;
      components.rendering.cancelTrailingVisibilityPass();
      releaseContinuousRender('ais-vessels', state.renderer?.engine);
      unregisterPickOwner('ais-live-vessels', state.renderer?.engine);
      components.tracking.detachSelectedVesselTrail();
      for (const record of state.records.all)
        components.rendering.removeRecordPrimitives(record);
      components.rendering.setVisible(false);
      vesselState._vesselOverlayHost.clearSource(VESSEL_OVERLAY_SOURCE_ID);
      components.cards.resetSelectedVesselHud();
      detachFleet();
      state.renderer?.destroy();
      state.renderer = null;
      state.viewer = null;
      state.activeFocusCount = 0;
      state.activeLabelCount = 0;
    },

    enable(viewer) {
      const wasEnabled = state.feed.enabled;
      state.feed.enabled = true;
      if (!wasEnabled) beginAisSession();
      const activeViewer = viewer || state.viewer;
      // The scene the layer draws in: the viewer, or the renderer's view on
      // an engine without one.
      const scene = activeViewer || state.renderer?.view || null;
      components.rendering.ensureCollections(scene);
      components.selection.installInteraction(scene);
      components.rendering.setVisible(true);
      // Height-datum fix: warm the geoid grid once per layer-enable, never
      // blocking a poll. The first refresh may land pre-resolve (N = 0), and
      // the next is up to 60 s out — so re-floor in place on resolve. A load
      // failure leaves N = 0 forever, which is safe: sprites are depth-test-
      // free, so vessels stay visible either way.
      if (!vesselState._geoidReady) {
        const sessionId = state.feed.sessionId;
        ensureGeoidReady()
          .then(() => {
            if (!state.feed.enabled || state.feed.sessionId !== sessionId)
              return;
            vesselState._geoidReady = true;
            components.tracking.refloorVesselRecords();
          })
          .catch(() => {
            /* grid failed to load — anchors stay at ellipsoid 0 */
          });
      }
      bindVisibleScene(activeViewer, scene);
      vesselState.timeline?.start();
      return components.ingestion.loadLivePositions(scene);
    },

    disable() {
      vesselState.timeline?.stop();
      removeViewListener();
      state.feed.enabled = false;
      invalidateAisSession();
      releaseContinuousRender('ais-vessels', state.renderer?.engine);
      components.rendering.cancelTrailingVisibilityPass();
      unregisterPickOwner('ais-live-vessels', state.renderer?.engine);
      components.rendering.setVisible(false);
      vesselState._vesselOverlayHost.clearSource(VESSEL_OVERLAY_SOURCE_ID);
      components.selection.clearVesselInspection();
      components.tracking.destroySelectedVesselTrail();
      components.selection.removeVesselInteraction();
      if (state.feed.abort) {
        state.feed.abort.abort();
        state.feed.abort = null;
      }
      state.feed.loading = false;
      state.feed.loadingLabel = '';
    },

    destroy() {
      vesselState.timeline?.stop();
      removeViewListener();
      invalidateAisSession();
      releaseContinuousRender('ais-vessels', state.renderer?.engine); // direct-destroy path (perf wave 2 fix)
      components.rendering.cancelTrailingVisibilityPass();
      if (state.feed.abort) state.feed.abort.abort();
      unregisterPickOwner('ais-live-vessels', state.renderer?.engine);
      components.selection.clearVesselInspection();
      components.tracking.destroySelectedVesselTrail();
      detachFleet();
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

  /** The engine's vessel display (none without an engine). */
  function createRenderer(viewer, engine) {
    return services.renderer?.create({ viewer, engine }) ?? null;
  }

  function bindVisibleScene(activeViewer, scene) {
    // Only MMSI picks present in the live record map belong to this layer.
    registerPickOwner(picks.owner, picks.predicate, state.renderer?.engine);
    restoreSpriteOrderOnEnable('ais', activeViewer);
    // Vessels are asked for by view, so ask again when the view moves away.
    removeViewListener();
    const onMoveEnd = () => {
      components.ingestion.refreshIfMoved(scene);
    };
    if (state.renderer)
      state.feed.removeViewListener = state.renderer.view.on(
        'moveEnd',
        onMoveEnd,
      );
    else {
      const moveEnd = activeViewer?.camera?.moveEnd;
      if (typeof moveEnd?.addEventListener === 'function')
        state.feed.removeViewListener = moveEnd.addEventListener(onMoveEnd);
    }
  }

  function detachFleet() {
    state.renderer?.fleet.detach();
  }

  function removeViewListener() {
    const remove = state.feed.removeViewListener;
    state.feed.removeViewListener = null;
    if (typeof remove === 'function') remove();
  }

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
    createRenderer,
    methods,
  };
}
