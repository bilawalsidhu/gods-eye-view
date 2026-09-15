import { AIS_FIRST_CONNECT_LABEL } from './recordPolicy.js';

/** Own source requests and classified feed state through explicit operations. */
export function createIngestion({
  feed,
  readSource,
  readViewer,
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
}) {
  async function loadLivePositions(viewer) {
    if (!viewer || feed.loading) return;
    feed.loading = true;
    feed.loadingLabel = feed.loaded ? 'refreshing...' : 'loading...';
    const requestController = new AbortController();
    const requestSessionId = feed.sessionId;
    feed.abort = requestController;

    try {
      // Combine the layer's teardown-abort with a hard timeout so a hung upstream
      // can't wedge the poll indefinitely (parity with the track fetch + flights).
      const signal =
        typeof AbortSignal.any === 'function'
          ? AbortSignal.any([
              requestController.signal,
              AbortSignal.timeout(10000),
            ])
          : requestController.signal;
      const snapshot = await readSource().getSnapshot(
        { maxRows: getRowLimit() },
        { signal },
      );
      if (!ownsAisRequest(requestController, requestSessionId)) return;
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
      });
    } catch (error) {
      if (
        ownsAisRequest(requestController, requestSessionId) &&
        error?.name !== 'AbortError'
      ) {
        markUnavailable(error?.message || 'AIS live load failed');
        console.warn('[Data:ais-live-vessels]', feed.error, error);
      }
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

    if (snapshot.acceptedRowCount === 0) {
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
    });
    feed.count = readCount();
    feed.stale =
      Boolean(payload?.refreshing) ||
      payload?.complete === false ||
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

  function vesselDisplayRow(record) {
    return {
      mmsi: record.id,
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
  const methods = {
    update(viewer) {
      if (!feed.enabled) return Promise.resolve();
      return loadLivePositions(viewer || readViewer());
    },
  };

  return {
    loadLivePositions,
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
  };
}
