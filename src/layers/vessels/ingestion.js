import {
  AIS_EMPTY_SCENE_MESSAGE,
  AIS_FIRST_CONNECT_LABEL,
  AIS_NON_FAULT_STATUSES,
  AIS_SCENE_HALF_WIDTH_DEG,
} from './recordPolicy.js';

const DEG_PER_RAD = 180 / Math.PI;

/**
 * Scene bounding box (degrees, ± `degrees` around the camera, clamped to the
 * globe) from a Cesium-like viewer — read through plain arithmetic so this
 * portable module never imports the renderer. Null when the viewer has no
 * camera position yet.
 *
 * @param {{camera?: {positionCartographic?: {latitude:number, longitude:number}}}|null} viewer
 * @param {number} [degrees]
 * @returns {{lamin:number, lomin:number, lamax:number, lomax:number}|null}
 */
export function vesselSceneBbox(viewer, degrees = AIS_SCENE_HALF_WIDTH_DEG) {
  const cartographic = viewer?.camera?.positionCartographic;
  if (!cartographic) return null;
  const lat = Number(cartographic.latitude) * DEG_PER_RAD;
  const lon = Number(cartographic.longitude) * DEG_PER_RAD;
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;
  const d = Math.max(0.05, Math.min(10, Number(degrees) || 1.5));
  return {
    lamin: Math.max(-90, +(lat - d).toFixed(3)),
    lamax: Math.min(90, +(lat + d).toFixed(3)),
    lomin: Math.max(-180, +(lon - d).toFixed(3)),
    lomax: Math.min(180, +(lon + d).toFixed(3)),
  };
}

/**
 * Whether a zero-row snapshot describes a legitimately empty scene (the
 * provider answered; there is simply nothing there) rather than a feed that
 * has not delivered: an explicit 'empty' status, or a non-fault status that
 * carries the provider's guidance text.
 */
export function isEmptySceneSnapshot(payload, transportStatus) {
  if (transportStatus === 'empty') return true;
  const hasGuidance =
    typeof payload?.statusMessage === 'string' &&
    payload.statusMessage.trim().length > 0;
  return (
    hasGuidance &&
    (transportStatus === 'live' ||
      transportStatus === 'idle' ||
      AIS_NON_FAULT_STATUSES.has(transportStatus))
  );
}

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
      // The scene box lets the serverless collector subscribe to just this
      // view (the dev relay ignores it); null while the camera is unknown.
      const snapshot = await readSource().getSnapshot(
        { maxRows: getRowLimit(), bbox: vesselSceneBbox(viewer) },
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
        // MOVEMENT provider status (X-Provider-*) and collector provenance,
        // surfaced verbatim in getStats() for the DATA LAYERS row.
        source: snapshot.source,
        providerStatus: snapshot.providerStatus ?? null,
        providerError: snapshot.providerError ?? null,
        providerSource: snapshot.providerSource ?? null,
        collectorMode: snapshot.collectorMode ?? null,
        statusMessage: snapshot.statusMessage ?? null,
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
    feed.partial = payload?.complete === false;
    feed.providerStatus = payload?.providerStatus ?? null;
    feed.providerError = payload?.providerError ?? null;
    feed.source = payload?.source ?? null;
    feed.collectorMode = payload?.collectorMode ?? null;
    feed.sceneEmpty = false;
    feed.statusMessage = null;

    if (snapshot.acceptedRowCount === 0) {
      feed.count = readCount();
      feed.stale = feed.count > 0 || Boolean(payload?.refreshing);
      if (isEmptySceneSnapshot(payload, snapshot.transportStatus)) {
        // The provider answered and the scene is simply empty: guidance
        // ("AISStream · No vessels in scene"), never UNAVAILABLE. Warm
        // records from a previous scene are kept, as on every zero-row poll.
        settleFirstConnect('ready');
        feed.error = null;
        feed.sceneEmpty = true;
        feed.statusMessage =
          typeof payload?.statusMessage === 'string' &&
          payload.statusMessage.trim()
            ? payload.statusMessage.trim()
            : AIS_EMPTY_SCENE_MESSAGE;
        return { reconciled: false, ...snapshot };
      }
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
      payload?.freshness === 'stale' ||
      snapshot.transportStatus === 'stale' ||
      payload?.freshness === 'unknown';
    feed.newestPositionAt = payload?.newestPositionAt || null;
    // Not unconditionally null: a degraded feed keeps its reason even though the
    // cached vessels are still drawable, so the chip cannot go quiet on an
    // outage the user is still looking at. A provider-reported `degraded`
    // (demo replay, AISHub fallback, last-good after upstream silence) keeps
    // the provider's own reason for the same purpose.
    feed.error =
      snapshot.error ||
      payload?.reason ||
      (feed.providerStatus === 'degraded' ? feed.providerError : null) ||
      null;
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
    // MOVEMENT provider status + collector provenance of the last poll.
    providerStatus: null,
    providerError: null,
    source: null,
    collectorMode: null,
    // Legitimately empty scene (guidance, not a fault) and its prompt.
    sceneEmpty: false,
    statusMessage: null,
  };
}
