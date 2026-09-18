import { ERROR_BACKOFF_INTERVAL } from './recordPolicy.js';

/** Own military source acquisition, cancellation, freshness and error backoff. */
export function createIngestion({
  feed,
  getQuery = () => ({}),
  applySnapshot,
  setSourceLabel,
  applyPendingTrackingRestore,
}) {
  const methods = {
    async update(viewer, { signal = null } = {}) {
      const nowMs = Date.now();
      const trackingRefreshEpoch = ++feed._trackingRefreshEpoch;
      feed._lastTrackingRefreshOutcome = {
        epoch: trackingRefreshEpoch,
        status: 'source-unavailable',
        ids: new Set(),
        source: feed._lastSource,
      };
      if (feed._retryAt && nowMs < feed._retryAt) {
        feed._backoff = true;
        return;
      }

      const resourceController = new AbortController();
      feed._activeUpdateControllers.add(resourceController);
      const updateSignal = signal
        ? AbortSignal.any([signal, resourceController.signal])
        : resourceController.signal;
      try {
        updateSignal.throwIfAborted();
        const snapshot = await feed._source.getSnapshot(getQuery(viewer), {
          signal: updateSignal,
        });
        updateSignal.throwIfAborted();
        feed._lastStatus = snapshot.status ?? 200;
        feed._lastSource = snapshot.source;
        setSourceLabel(feed._lastSource);
        // MOVEMENT proxy status (server/providers/common/upstream.js): a
        // `stale` last-good list backs off like a stale snapshot; a `degraded`
        // alternative feed is current data and stays out of `error` so the
        // global chip does not read LOAD FAILED — the row shows providerError.
        const providerStatus = snapshot.providerStatus ?? null;
        feed._providerStatus = providerStatus;
        feed._providerError = snapshot.providerError ?? null;
        feed._lastCoverage = snapshot.coverage ?? feed._lastCoverage;
        feed._backoff =
          snapshot.stale ||
          snapshot.freshness === 'unknown' ||
          providerStatus === 'stale';
        feed._retryAt = 0;
        feed._lastError =
          snapshot.reason ||
          (snapshot.freshness === 'unknown'
            ? 'Source snapshot time unavailable'
            : null);
        const accepted = applySnapshot(snapshot, viewer);
        feed._count = accepted.count;
        feed._lastUpdate = snapshot.observedAtMs;
        feed._lastTrackingRefreshOutcome = {
          epoch: trackingRefreshEpoch,
          status: 'accepted',
          ids: accepted.ids,
          source: feed._lastSource,
        };
        console.log(`[Data:Military] Updated: ${feed._count} aircraft`);
        applyPendingTrackingRestore();
      } catch (e) {
        if (updateSignal.aborted || e?.name === 'AbortError') {
          throw new DOMException('Military update aborted', 'AbortError');
        }
        console.warn('[Data:Military] Fetch error:', e);
        feed._backoff = true;
        feed._retryAt =
          Date.now() + (e?.retryAfterMs ?? ERROR_BACKOFF_INTERVAL);
        feed._lastStatus = e?.status ?? null;
        if (e?.source) {
          feed._lastSource = e.source;
          setSourceLabel(feed._lastSource);
        }
        feed._lastError =
          e?.name === 'LiveSourceError' ? e.message : 'Live data unavailable';
        // The proxy answered without data (HTTP 503 + structured status).
        feed._providerStatus = e?.status ? 'unavailable' : null;
        feed._providerError = e?.name === 'LiveSourceError' ? e.message : null;
      } finally {
        feed._activeUpdateControllers.delete(resourceController);
      }
    },
  };

  return { methods };
}

/** Construct an independent military source lifetime and status. */
export function createMilitaryFeed(source) {
  const feed = {};
  feed._source = source;
  feed._count = 0;
  feed._lastUpdate = null;
  feed._backoff = false;
  feed._retryAt = 0;
  feed._lastError = null;
  feed._activeUpdateControllers = new Set();
  feed._lastStatus = null;
  feed._lastSource = source?.label || 'Aircraft';
  feed._lastCoverage = 'military upstream snapshot';
  feed._providerStatus = null;
  feed._providerError = null;
  feed._trackingRefreshEpoch = 0;
  feed._lastTrackingRefreshOutcome = {
    epoch: 0,
    status: 'unavailable',
    ids: new Set(),
    source: feed._lastSource,
  };
  return feed;
}
