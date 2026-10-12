import { DEFAULT_AIS_RUNTIME } from './policy.js';

export function createTesting({
  vesselState,
  services,
  parts: components,
  layer,
  options,
}) {
  const { state } = vesselState;
  const aisLiveVesselsLayer = layer;

  /**
   * Bind the production interaction callbacks to mockable viewer/handler
   * surfaces. Test-only seam; behavior is shared with installInteraction().
   * @param {Object} viewer - Viewer-like object with scene.pick().
   * @param {Object} handler - Handler-like object with setInputAction().
   * @param {Object} keyTarget - EventTarget-like object with add/removeEventListener().
   * @returns {void}
   */

  function _bindVesselInteractionForTest(viewer, handler, keyTarget) {
    components.selection.bindVesselInteraction(viewer, handler, keyTarget);
  }

  /**
   * Prime the minimum live state needed by interaction/lifecycle wire tests.
   * @param {Object} [options={}] - Test state values.
   * @returns {void}
   */

  function _setVesselStateForTest(options = {}) {
    components.lifecycle.resetState();
    const records = Array.isArray(options.records) ? options.records : [];
    state.viewer = options.viewer || null;
    state.feed.enabled = options.enabled !== false;
    state.feed.loaded = options.loaded === true;
    state.feed.loading = options.loading === true;
    state.feed.stale = options.stale === true;
    state.feed.partial = options.partial === true;
    state.feed.error = options.error || null;
    state.feed.lastUpdate = options.lastUpdate ?? null;
    state.records.all = records;
    state.feed.count = records.length;
    state.records.byMmsi = new Map(
      records
        .filter((record) => record?.mmsi)
        .map((record) => [record.mmsi, record]),
    );
    state.selectedRecord = options.selectedRecord || null;
    state.billboardCollection = options.billboardCollection || { remove() {} };
    state.trail = options.trail || null;
    state.trailMmsi = options.trailMmsi || null;
    state.trailPositions = Array.isArray(options.trailPositions)
      ? [...options.trailPositions]
      : [];
    state.feed.transportStatus = options.transportStatus || null;
    state.feed.lastMessageAt = options.lastMessageAt ?? null;
    state.feed.rawRowCount = Number.isFinite(options.rawRowCount)
      ? options.rawRowCount
      : 0;
    state.feed.acceptedRowCount = Number.isFinite(options.acceptedRowCount)
      ? options.acceptedRowCount
      : records.length;
    state.feed.firstConnectPhase = options.firstConnectPhase || 'idle';
    state.feed.firstConnectStartedAt = options.firstConnectStartedAt ?? null;
    state.feed.firstConnectDeadline = options.firstConnectDeadline ?? null;
    state.interactionHandlerFactory = options.interactionHandlerFactory || null;
    state.interactionKeyTarget = options.interactionKeyTarget || null;
  }

  /** Inject a host recorder for lifecycle/contract tests; null restores production. */

  function _setVesselOverlayHostForTest(host = null) {
    vesselState._vesselOverlayHost =
      host || vesselState.DEFAULT_VESSEL_OVERLAY_HOST;
  }

  /** Exercise the production selector/publisher through a test-owned state. */

  function _updateVesselCardsForTest(records = []) {
    components.rendering.updateClusteredLabels(records);
  }

  /**
   * Reconcile AIS rows through the production lifecycle. Test-only seam.
   * @param {Object} viewer - Viewer-like object.
   * @param {Array<Object>} rows - Raw AIS rows.
   * @returns {void}
   */

  function _reconcileVesselsForTest(viewer, rows) {
    components.snapshots.reconcileVessels(viewer, rows);
  }

  /** Apply one server snapshot through the production pre-reconcile health gate. */

  function _applyAisFeedSnapshotForTest(viewer, payload) {
    return components.ingestion.applyAisFeedSnapshot(viewer, payload);
  }

  /** Exercise the request-owned live loader with a test-controlled fetch. */

  function _loadLivePositionsForTest(viewer) {
    return components.ingestion.loadLivePositions(viewer);
  }

  /** Start the production first-connect grace state without installing UI. */

  function _beginAisSessionForTest() {
    components.lifecycle.beginAisSession();
  }

  /** Inject a deterministic clock/scheduler; null restores production runtime. */

  function _setAisRuntimeForTest(runtime = null) {
    components.lifecycle.clearFirstConnectTimer();
    vesselState._aisRuntime = runtime
      ? {
          now: runtime.now,
          setTimeout: runtime.setTimeout,
          clearTimeout: runtime.clearTimeout,
        }
      : DEFAULT_AIS_RUNTIME;
  }

  /** Read feed-health fields without exposing mutable production state. */

  function _getVesselFeedStateForTest() {
    const stats = aisLiveVesselsLayer.getStats();
    return {
      count: state.feed.count,
      loaded: state.feed.loaded,
      loading: stats.loading,
      loadingLabel: stats.loadingLabel,
      stale: state.feed.stale,
      error: state.feed.error,
      status: stats.status,
      lastUpdate: state.feed.lastUpdate,
      transportStatus: state.feed.transportStatus,
      lastMessageAt: state.feed.lastMessageAt,
      rawRowCount: state.feed.rawRowCount,
      acceptedRowCount: state.feed.acceptedRowCount,
      selectedMmsi: state.selectedRecord?.mmsi || null,
      trailMmsi: state.trailMmsi,
      trailPositionCount: state.trailPositions.length,
      sessionId: state.feed.sessionId,
      firstConnectPhase: state.feed.firstConnectPhase,
      firstConnectStartedAt: state.feed.firstConnectStartedAt,
      firstConnectDeadline: state.feed.firstConnectDeadline,
    };
  }

  /**
   * Read lifecycle ownership state without exposing the mutable state object.
   * Test-only seam.
   * @returns {{trailMmsi: string|null, trailPositionCount: number, vesselCount: number}}
   */

  function _getVesselStateForTest() {
    return {
      trailMmsi: state.trailMmsi,
      trailPositionCount: state.trailPositions.length,
      vesselCount: state.records.byMmsi.size,
    };
  }
  return {
    _bindVesselInteractionForTest,
    _setVesselStateForTest,
    _setVesselOverlayHostForTest,
    _updateVesselCardsForTest,
    _reconcileVesselsForTest,
    _applyAisFeedSnapshotForTest,
    _loadLivePositionsForTest,
    _beginAisSessionForTest,
    _setAisRuntimeForTest,
    _getVesselFeedStateForTest,
    _getVesselStateForTest,
  };
}
