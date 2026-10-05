import { ERROR_BACKOFF_INTERVAL } from './recordPolicy.js';

/** Own acquisition, cancellation, freshness and backoff independently of rendering. */
export function createIngestion({
  feed,
  getQuery,
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
        coverage: feed._lastCoverage,
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
        const sourceEpochMs = snapshot.observedAtMs;
        const sourceAgeMs = snapshot.ageMs;
        const sourceStale = snapshot.stale || snapshot.freshness === 'unknown';
        feed._backoff = sourceStale;
        feed._retryAt = 0;
        feed._lastError = sourceStale
          ? sourceAgeMs == null
            ? 'Source snapshot time unavailable'
            : `Source snapshot ${Math.max(2, Math.round(sourceAgeMs / 60_000))} min old`
          : null;
        feed._lastSource = snapshot.source;
        feed._lastCoverage = snapshot.coverage;
        setSourceLabel(feed._lastSource);
        const accepted = applySnapshot(snapshot, viewer);
        feed._count = accepted.count;
        // Freshness belongs to the source snapshot, not the moment this browser
        // received a cached 200 response.
        feed._lastUpdate = sourceEpochMs;
        feed._lastTrackingRefreshOutcome = {
          epoch: trackingRefreshEpoch,
          status: 'accepted',
          ids: accepted.ids,
          source: feed._lastSource,
          coverage: feed._lastCoverage,
        };
        console.log(`[Data:Flights] Updated: ${feed._count} aircraft`);
        applyPendingTrackingRestore();
      } catch (e) {
        if (updateSignal.aborted || e?.name === 'AbortError') {
          throw new DOMException('Flights update aborted', 'AbortError');
        }
        console.warn('[Data:Flights] Fetch error:', e);
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
      } finally {
        feed._activeUpdateControllers.delete(resourceController);
      }
    },
  };

  return { methods };
}

/** Construct a fresh source lifetime and its refresh status. */
export function createFlightFeed(source) {
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
  feed._lastCoverage = 'worldwide upstream snapshot';
  feed._trackingRefreshEpoch = 0;
  feed._lastTrackingRefreshOutcome = {
    epoch: 0,
    status: 'unavailable',
    ids: new Set(),
    source: feed._lastSource,
    coverage: null,
  };
  return feed;
}
