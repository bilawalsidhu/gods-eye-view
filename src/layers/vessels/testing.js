import { DEFAULT_AIS_RUNTIME } from './policy.js';
import { createVesselIconBook } from './iconBook.js';

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
   * Prime the minimum live state needed by interaction/lifecycle wire tests.
   * @param {Object} [options={}] - Test state values.
   * @returns {void}
   */

  function _setVesselStateForTest(options = {}) {
    components.lifecycle.resetState();
    const records = Array.isArray(options.records) ? options.records : [];
    // A test record that names no id is keyed by its MMSI, as an AIS feed's
    // own rows are (see normalizeVessel).
    for (const record of [...records, options.selectedRecord])
      if (record && typeof record === 'object' && record.id === undefined)
        record.id = String(record.mmsi || '').trim();
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
    state.records.byId = new Map(
      records
        .filter((record) => record?.id)
        .map((record) => [record.id, record]),
    );
    state.selectedRecord = options.selectedRecord || null;
    // `icons: null` leaves the layer to make its own draw set.
    state.icons =
      options.icons === null ? null : options.icons || createVesselIconBook();
    state.trail = options.trail || null;
    state.trailId = options.trailId || null;
    state.trailPositions = Array.isArray(options.trailPositions)
      ? [...options.trailPositions]
      : [];
    state.trailTimes = state.trailPositions.map(() => Number.NaN);
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
      selectedId: state.selectedRecord?.id || null,
      trailId: state.trailId,
      trailPositionCount: state.trailPositions.length,
      sessionId: state.feed.sessionId,
      firstConnectPhase: state.feed.firstConnectPhase,
      firstConnectStartedAt: state.feed.firstConnectStartedAt,
      firstConnectDeadline: state.feed.firstConnectDeadline,
    };
  }

  /** Run one world-clock pass at world time `atMs`. Test-only seam. */

  function _runClockPassForTest(atMs) {
    vesselState.worldNow = () => atMs;
    components.rendering.followClock();
  }

  /**
   * Follow the world clock, standing at world time `atMs`; `null` goes back
   * to live. Test-only seam.
   */

  function _followClockForTest(atMs) {
    vesselState.timeline = { active: () => atMs !== null };
    vesselState.worldNow = () => atMs ?? 0;
  }

  /**
   * Read lifecycle ownership state without exposing the mutable state object.
   * Test-only seam.
   * @returns {{trailId: string|null, trailPositionCount: number, vesselCount: number}}
   */

  function _getVesselStateForTest() {
    return {
      trailId: state.trailId,
      trailPositionCount: state.trailPositions.length,
      vesselCount: state.records.byId.size,
    };
  }
  return {
    vesselState,
    parts: components,
    _setVesselStateForTest,
    _followClockForTest,
    _setAisRuntimeForTest,
    _getVesselFeedStateForTest,
    _getVesselStateForTest,
    _runClockPassForTest,
  };
}
