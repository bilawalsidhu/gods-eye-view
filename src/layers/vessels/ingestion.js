import { AIS_FIRST_CONNECT_LABEL } from './recordPolicy.js';
import { viewAreaMovedEnough } from './viewArea.js';

/** Longest a vessel request may take before it is given up. */
const REQUEST_TIMEOUT_MS = 10_000;

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
  timedAnswer = () => true,
}) {
  // The live load in flight: its result, and its request, whose `handover`
  // may still be set while it loads (see resumeLive).
  let liveLoad = null;

  /**
   * Poll the live vessels (or take the live poll already out). Resolves
   * when it is done, with nothing: a feed that fails is shown on the layer,
   * and turning the layer on still succeeds.
   * @param {object} viewer
   * @returns {Promise<void>}
   */
  async function loadLivePositions(viewer) {
    await pollLive(viewer);
  }

  /**
   * The live poll: resolves what loadPositions answers (false when it could
   * not be had), or that of the live poll already out.
   */
  async function pollLive(viewer, { handover = false } = {}) {
    // Following the world clock, the layer shows the snapshots loadAt applies.
    if (followsClock()) return false;
    // Back at live, a snapshot at a time still loading no longer applies:
    // it would hold the live poll back until the next refresh.
    if (feed.loading && feed.loadingAtTime) dropLoad();
    // A live load already out answers this one too.
    if (feed.loading && liveLoad) {
      if (handover) liveLoad.request.handover = true;
      return liveLoad.promise;
    }
    const request = { handover };
    const promise = loadPositions(viewer, { request });
    const load = { request, promise };
    liveLoad = load;
    try {
      return await promise;
    } finally {
      if (liveLoad === load) liveLoad = null;
    }
  }

  /**
   * Back at live from another time: poll at once (or take the live poll
   * already out), and let its snapshot stand in for every vessel. Those it has keep their
   * icon and model and move on from where they are; those it lacks go.
   * Resolves true once it is applied, else false (it could not be had).
   * @param {object} [viewer]
   * @returns {Promise<boolean>}
   */
  async function resumeLive(viewer) {
    const applied = await pollLive(viewer || readViewer(), {
      handover: true,
    });
    return applied === true;
  }

  /** Let go of the load in flight, so another can start now. */
  function dropLoad() {
    feed.abort?.abort();
    feed.loading = false;
    feed.loadingAtTime = false;
    feed.abort = null;
  }

  /**
   * Apply the source's snapshot at world time `atMs` (its timeline says it
   * can answer one), in place of every vessel when `replace`. Resolves
   * whether it was applied: `{ reachMs }`, the newest fix its records carry,
   * when they carry fixes; else true, or false when it was not.
   * @param {number} atMs
   * @param {{signal?: AbortSignal|null, replace?: boolean}} [options]
   * @returns {Promise<boolean|{reachMs: number}>}
   */
  async function loadAt(atMs, { signal = null, replace = false } = {}) {
    // Whatever polls or loads for another time no longer applies: the
    // timeline asks for one time at a time.
    if (feed.loading) dropLoad();
    return loadPositions(readViewer(), { atMs, replace, signal });
  }

  async function loadPositions(
    viewer,
    { atMs, replace = false, signal, request = null } = {},
  ) {
    const timed = atMs !== undefined;
    if (!viewer || feed.loading) return false;
    feed.loading = true;
    feed.loadingAtTime = timed;
    feed.loadingLabel = feed.loaded ? 'refreshing...' : 'loading...';
    const requestController = new AbortController();
    const requestSessionId = feed.sessionId;
    feed.abort = requestController;
    let timeout = null;

    try {
      // Combine the layer's teardown-abort with a hard timeout so a hung upstream
      // can't wedge the poll indefinitely (parity with the track fetch + flights).
      let requestSignal;
      if (typeof AbortSignal.any === 'function')
        requestSignal = AbortSignal.any([
          requestController.signal,
          AbortSignal.timeout(REQUEST_TIMEOUT_MS),
          ...(signal ? [signal] : []),
        ]);
      else {
        // Without it, the request's own controller takes the timeout and
        // the caller's abort.
        timeout = setTimeout(
          () =>
            requestController.abort(
              new DOMException('Vessel request timed out', 'TimeoutError'),
            ),
          REQUEST_TIMEOUT_MS,
        );
        signal?.addEventListener(
          'abort',
          () => requestController.abort(signal.reason),
          { once: true },
        );
        requestSignal = requestController.signal;
      }
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
      const takesOver = !timed && request?.handover === true;
      setSourceLabel(snapshot.source);
      // Map observations into the existing display store; source fields stop here.
      const applied = applyAisFeedSnapshot(viewer, {
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
        ...(takesOver && { handover: true }),
      });
      // Back at live, a snapshot that placed no vessel could not take over.
      if (takesOver) return applied.reconciled;
      // At a time, what the clock's follower is told of it.
      return timed ? timedAnswer(snapshot) : true;
    } catch (error) {
      // A snapshot at a time the source dropped for a newer one is no failure.
      if (timed && error?.name === 'AbortError') throw error;
      if (
        ownsAisRequest(requestController, requestSessionId) &&
        error?.name !== 'AbortError'
      ) {
        // The key is missing only while the source says so; any other
        // failure is an outage, not a key to add.
        feed.transportStatus =
          error?.code === 'key-required' ? 'missing-key' : null;
        markUnavailable(error?.message || msg('AIS live load failed'));
        console.warn('[Data:ais-live-vessels]', feed.error, error);
      }
      return false;
    } finally {
      if (timeout !== null) clearTimeout(timeout);
      if (
        feed.abort === requestController &&
        feed.sessionId === requestSessionId
      ) {
        feed.loading = false;
        feed.loadingAtTime = false;
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
      ...(payload?.handover && { handover: true }),
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
      fixes: record.fixes,
      name: record.name,
      imo: record.imo,
      type: record.type,
      destination: record.destination,
      length: record.lengthM ?? null,
      beam: record.beamM ?? null,
      speed: record.speedMps == null ? null : record.speedMps / 0.514444,
      course: record.courseDeg,
      heading: record.headingDeg,
      virtual: record.virtual === true,
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
    resumeLive,
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
    /** Whether the load in flight is a snapshot at a time, not a poll. */
    loadingAtTime: false,
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
