import { AIS_FIRST_CONNECT_LABEL } from './recordPolicy.js';
import { viewAreaMovedEnough } from './viewArea.js';

// A portable export (package.json): no i18n here. The text stays English data
// and the layer panel shows it translated.
const msg = (text) => text;

/** Own source requests and classified feed state through explicit operations. */
export function createIngestion({
  feed,
  readSource,
  readViewer,
  readArea = () => null,
  getRowLimit,
  readCount,
  applyRows,
  classifySnapshot,
  isDefinitiveTransportFailure,
  isGraceEligibleTransport,
  markUnavailable,
  settleFirstConnect,
  now,
  setSourceLabel,
  followsClock = () => false,
  reloadAtClock = () => {},
}) {
  async function loadLivePositions(viewer) {
    // Following the world clock, the layer shows the snapshots loadAt applies.
    if (followsClock()) return;
    await loadPositions(viewer);
  }

  /**
   * Apply the source's snapshot at world time `atMs` (its timeline says it
   * can answer one), in place of every vessel when `replace`. Resolves
   * whether it was applied.
   * @param {number} atMs
   * @param {{signal?: AbortSignal|null, replace?: boolean}} [options]
   * @returns {Promise<boolean>}
   */
  async function loadAt(atMs, { signal = null, replace = false } = {}) {
    // Whatever polls or loads for another time no longer applies.
    if (replace && feed.loading) {
      feed.abort?.abort();
      feed.loading = false;
      feed.abort = null;
    }
    return loadPositions(readViewer(), { atMs, replace, signal });
  }

  async function loadPositions(viewer, { atMs, replace = false, signal } = {}) {
    const timed = atMs !== undefined;
    if (!viewer || feed.loading) return false;
    feed.loading = true;
    feed.loadingLabel = feed.loaded ? 'refreshing...' : 'loading...';
    const requestController = new AbortController();
    const requestSessionId = feed.sessionId;
    feed.abort = requestController;

    try {
      // Combine the layer's teardown-abort with a hard timeout so a hung upstream
      // can't wedge the poll indefinitely (parity with the track fetch + flights).
      const requestSignal =
        typeof AbortSignal.any === 'function'
          ? AbortSignal.any([
              requestController.signal,
              AbortSignal.timeout(10000),
              ...(signal ? [signal] : []),
            ])
          : requestController.signal;
      // Ask for the vessels in view; a wide view asks for every vessel.
      const area = readArea(viewer);
      feed.lastArea = area;
      const snapshot = await readSource().getSnapshot(
        {
          maxRows: getRowLimit(),
          ...(area ? { area } : {}),
          ...(timed ? { atMs } : {}),
        },
        { signal: requestSignal },
      );
      if (!ownsAisRequest(requestController, requestSessionId)) return false;
      if (signal?.aborted) return false;
      // The clock left the live edge while this poll was out.
      if (!timed && followsClock()) return false;
      setSourceLabel(snapshot.source);
      // Map observations into the existing display store; source fields stop here.
      applyAisFeedSnapshot(viewer, {
        rows: snapshot.records.map(vesselDisplayRow),
        observedAtMs: snapshot.observedAtMs,
        freshness: snapshot.freshness,
        complete: snapshot.complete,
        rawRowCount: snapshot.rawRowCount,
        reason: snapshot.reason,
        status: snapshot.transportStatus,
        lastMessageAt: snapshot.lastMessageAt,
        nextAttemptAt: snapshot.nextAttemptAt,
        refreshing: snapshot.stale,
        newestPositionAt:
          snapshot.observedAtMs == null
            ? null
            : new Date(snapshot.observedAtMs).toISOString(),
        silentForMs: snapshot.silentForMs,
        reconnectAttempt: snapshot.reconnectAttempt,
        ...(replace && { replace }),
      });
      return true;
    } catch (error) {
      // A snapshot at a time the source dropped for a newer one is no failure.
      if (timed && error?.name === 'AbortError') throw error;
      if (
        ownsAisRequest(requestController, requestSessionId) &&
        error?.name !== 'AbortError'
      ) {
        markUnavailable(error?.message || msg('AIS live load failed'));
        console.warn('[Data:ais-live-vessels]', feed.error, error);
      }
      return false;
    } finally {
      if (
        feed.abort === requestController &&
        feed.sessionId === requestSessionId
      ) {
        feed.loading = false;
        feed.loadingLabel =
          feed.firstConnectPhase === 'loading' ? AIS_FIRST_CONNECT_LABEL : '';
        feed.abort = null;
      }
    }
  }

  /** True while a request still owns this enabled layer lifecycle. */

  function ownsAisRequest(controller, sessionId) {
    return (
      feed.enabled &&
      feed.sessionId === sessionId &&
      feed.abort === controller &&
      !controller.signal.aborted
    );
  }

  /** Apply a classified snapshot while preserving warm state on zero accepted rows. */

  function applyAisFeedSnapshot(viewer, payload) {
    const snapshot = classifySnapshot(payload);
    feed.loaded = true;
    feed.loadingLabel = '';
    feed.transportStatus = snapshot.transportStatus;
    feed.nextAttemptAt = Number(payload?.nextAttemptAt) || null;
    feed.lastMessageAt = snapshot.lastMessageAt;
    feed.rawRowCount = snapshot.rawRowCount;
    feed.acceptedRowCount = snapshot.acceptedRowCount;
    feed.partial = payload?.complete === false;

    // At another time, a snapshot with no vessels shows none, not the last.
    if (payload?.replace && snapshot.acceptedRowCount === 0)
      applyRows(viewer, [], { complete: true, replace: true });
    if (snapshot.acceptedRowCount === 0 && !snapshot.emptyCoverage) {
      feed.count = readCount();
      feed.stale = feed.count > 0 || Boolean(payload?.refreshing);
      if (isDefinitiveTransportFailure(snapshot.transportStatus)) {
        markUnavailable(snapshot.error);
        return { reconciled: false, ...snapshot };
      }
      if (
        feed.firstConnectPhase === 'loading' &&
        isGraceEligibleTransport(snapshot.transportStatus)
      ) {
        feed.error = null;
        feed.loadingLabel = AIS_FIRST_CONNECT_LABEL;
        return { reconciled: false, ...snapshot };
      }
      if (feed.firstConnectPhase === 'loading') {
        markUnavailable(snapshot.error);
        return { reconciled: false, ...snapshot };
      }
      feed.error = snapshot.error;
      return { reconciled: false, ...snapshot };
    }

    settleFirstConnect('ready');
    applyRows(viewer, snapshot.acceptedRows, {
      complete: payload?.complete !== false,
      ...(payload?.replace && { replace: true }),
    });
    feed.count = readCount();
    feed.stale =
      Boolean(payload?.refreshing) ||
      payload?.freshness === 'stale' ||
      snapshot.transportStatus === 'stale' ||
      payload?.freshness === 'unknown';
    feed.newestPositionAt = payload?.newestPositionAt || null;
    // Not unconditionally null: a degraded feed keeps its reason even though the
    // cached vessels are still drawable, so the chip cannot go quiet on an
    // outage the user is still looking at.
    feed.error = snapshot.error || payload?.reason || null;
    feed.lastUpdate = Object.hasOwn(payload, 'observedAtMs')
      ? payload.observedAtMs
      : now();
    return { reconciled: true, ...snapshot };
  }

  /** The layer's row for a source record: keyed by its id, MMSI shown when known. */
  function vesselDisplayRow(record) {
    return {
      id: record.id,
      mmsi: String(record.mmsi ?? '').trim(),
      reference: record.reference,
      lat: record.latitude,
      lon: record.longitude,
      name: record.name,
      imo: record.imo,
      type: record.type,
      destination: record.destination,
      speed: record.speedMps == null ? null : record.speedMps / 0.514444,
      course: record.courseDeg,
      heading: record.headingDeg,
      last_position_epoch:
        record.observedAtMs == null ? null : record.observedAtMs / 1000,
      last_position_UTC:
        record.observedAtMs == null
          ? ''
          : new Date(record.observedAtMs).toISOString(),
    };
  }
  /** Ask again when the view moved away from the last area asked for. */
  function refreshIfMoved(viewer) {
    const following = followsClock();
    if (!feed.enabled || (feed.loading && !following)) return Promise.resolve();
    const active = viewer || readViewer();
    if (!viewAreaMovedEnough(feed.lastArea ?? null, readArea(active)))
      return Promise.resolve();
    // Following the world clock, the new area is asked for at the same time.
    if (following) {
      reloadAtClock();
      return Promise.resolve();
    }
    return loadLivePositions(active);
  }

  const methods = {
    update(viewer) {
      if (!feed.enabled) return Promise.resolve();
      return loadLivePositions(viewer || readViewer());
    },
  };

  return {
    loadLivePositions,
    loadAt,
    refreshIfMoved,
    ownsAisRequest,
    applyAisFeedSnapshot,
    vesselDisplayRow,
    methods,
  };
}

/** Construct request admission and first-position status for one vessel layer. */
export function createVesselFeed() {
  return {
    enabled: false,
    loading: false,
    loaded: false,
    stale: false,
    partial: false,
    error: null,
    loadingLabel: '',
    lastUpdate: null,
    count: 0,
    newestPositionAt: null,
    transportStatus: null,
    nextAttemptAt: null,
    lastMessageAt: null,
    rawRowCount: 0,
    acceptedRowCount: 0,
    sessionId: 0,
    firstConnectPhase: 'idle',
    firstConnectStartedAt: null,
    firstConnectDeadline: null,
    firstConnectTimer: null,
    abort: null,
    /** The area last asked for, null for every vessel. */
    lastArea: null,
    /** Stops listening for camera moves. */
    removeViewListener: null,
  };
}
