import { AIS_FIRST_CONNECT_LABEL } from './policy.js';

export function createIngestion({
  vesselState,
  services,
  parts: components,
  layer,
  options,
}) {
  const { state } = vesselState;
  const aisLiveVesselsLayer = layer;

  async function loadLivePositions(viewer) {
    if (!viewer || state.loading) return;
    state.loading = true;
    state.loadingLabel = state.loaded ? 'refreshing...' : 'loading...';
    const requestController = new AbortController();
    const requestSessionId = state.sessionId;
    state.abort = requestController;

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
      const snapshot = await vesselState._source.getSnapshot(
        { maxRows: components.rendering.renderRowLimit() },
        { signal },
      );
      if (!ownsAisRequest(requestController, requestSessionId)) return;
      aisLiveVesselsLayer.source = snapshot.source;
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
        components.lifecycle.markAisUnavailable(
          error?.message || 'AIS live load failed',
        );
        console.warn('[Data:ais-live-vessels]', state.error, error);
      }
    } finally {
      if (
        state.abort === requestController &&
        state.sessionId === requestSessionId
      ) {
        state.loading = false;
        state.loadingLabel =
          state.firstConnectPhase === 'loading' ? AIS_FIRST_CONNECT_LABEL : '';
        state.abort = null;
      }
    }
  }

  /** True while a request still owns this enabled layer lifecycle. */

  function ownsAisRequest(controller, sessionId) {
    return (
      state.enabled &&
      state.sessionId === sessionId &&
      state.abort === controller &&
      !controller.signal.aborted
    );
  }

  /** Apply a classified snapshot while preserving warm state on zero accepted rows. */

  function applyAisFeedSnapshot(viewer, payload) {
    const snapshot = components.queries.classifyAisFeedSnapshot(payload);
    state.loaded = true;
    state.loadingLabel = '';
    state.transportStatus = snapshot.transportStatus;
    state.nextAttemptAt = Number(payload?.nextAttemptAt) || null;
    state.lastMessageAt = snapshot.lastMessageAt;
    state.rawRowCount = snapshot.rawRowCount;
    state.acceptedRowCount = snapshot.acceptedRowCount;

    if (snapshot.acceptedRowCount === 0) {
      state.count = state.vesselRecords.length;
      state.stale = state.count > 0 || Boolean(payload?.refreshing);
      if (
        components.lifecycle.isDefinitiveTransportFailure(
          snapshot.transportStatus,
        )
      ) {
        components.lifecycle.markAisUnavailable(snapshot.error);
        return { reconciled: false, ...snapshot };
      }
      if (
        state.firstConnectPhase === 'loading' &&
        components.lifecycle.isGraceEligibleTransport(snapshot.transportStatus)
      ) {
        state.error = null;
        state.loadingLabel = AIS_FIRST_CONNECT_LABEL;
        return { reconciled: false, ...snapshot };
      }
      if (state.firstConnectPhase === 'loading') {
        components.lifecycle.markAisUnavailable(snapshot.error);
        return { reconciled: false, ...snapshot };
      }
      state.error = snapshot.error;
      return { reconciled: false, ...snapshot };
    }

    components.lifecycle.settleFirstConnectPhase('ready');
    components.store.reconcileVessels(viewer, snapshot.acceptedRows, {
      complete: payload?.complete !== false,
    });
    state.count = state.vesselRecords.length;
    state.stale =
      Boolean(payload?.refreshing) ||
      payload?.complete === false ||
      payload?.freshness === 'unknown';
    state.newestPositionAt = payload?.newestPositionAt || null;
    // Not unconditionally null: a degraded feed keeps its reason even though the
    // cached vessels are still drawable, so the chip cannot go quiet on an
    // outage the user is still looking at.
    state.error = snapshot.error || payload?.reason || null;
    state.lastUpdate = Object.hasOwn(payload, 'observedAtMs')
      ? payload.observedAtMs
      : vesselState._aisRuntime.now();
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
      if (!state.enabled) return Promise.resolve();
      return loadLivePositions(viewer || state.viewer);
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
