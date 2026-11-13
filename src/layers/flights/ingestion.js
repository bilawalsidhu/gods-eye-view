import { ERROR_BACKOFF_INTERVAL } from './recordPolicy.js';

// Marks English the Layers panel translates when it shows the error. Kept
// local: this module stays free of browser globals (package boundaries).
const msg = (text) => text;

/** Own acquisition, cancellation, freshness and backoff independently of rendering. */
export function createIngestion({
  feed,
  getQuery,
  applySnapshot,
  setSourceLabel,
  applyPendingTrackingRestore,
  followsClock = () => false,
}) {
  const methods = {
    async update(viewer, { signal = null } = {}) {
      // Following the world clock, the layer shows the snapshots loadAt
      // applies; polling the live feed would put the live edge among them.
      if (followsClock()) return;
      await acquire(viewer, { signal });
    },

    /**
     * Apply the source's snapshot at world time `atMs` (its timeline says it
     * can answer one), in place of every contact when `replace`. Resolves
     * whether it was applied.
     * @param {number} atMs
     * @param {{signal?: AbortSignal|null, replace?: boolean, viewer?: object}} [options]
     * @returns {Promise<boolean>}
     */
    async loadAt(atMs, { signal = null, replace = false, viewer = null } = {}) {
      // Whatever polls or loads for another time no longer applies.
      if (replace)
        for (const controller of feed._activeUpdateControllers)
          controller.abort();
      return acquire(viewer, { signal, atMs, replace });
    },
  };

  async function acquire(viewer, { signal = null, atMs, replace = false }) {
    const nowMs = Date.now();
    const timed = atMs !== undefined;
    const trackingRefreshEpoch = ++feed._trackingRefreshEpoch;
    feed._lastTrackingRefreshOutcome = {
      epoch: trackingRefreshEpoch,
      status: 'source-unavailable',
      ids: new Set(),
      source: feed._lastSource,
      coverage: feed._lastCoverage,
    };
    if (!timed && feed._retryAt && nowMs < feed._retryAt) {
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
      const query = timed ? { ...getQuery(viewer), atMs } : getQuery(viewer);
      const snapshot = await feed._source.getSnapshot(query, {
        signal: updateSignal,
      });
      updateSignal.throwIfAborted();
      // The clock left the live edge while this poll was out.
      if (!timed && followsClock()) return;
      feed._lastStatus = snapshot.status ?? 200;
      const sourceEpochMs = snapshot.observedAtMs;
      const sourceAgeMs = snapshot.ageMs;
      const sourceStale = snapshot.stale || snapshot.freshness === 'unknown';
      feed._backoff = sourceStale;
      feed._retryAt = 0;
      // i18n-ignore: English data; the panel shows it through FEED_ERROR_PATTERNS (ui/statusText.js)
      feed._lastError = sourceStale
        ? sourceAgeMs == null
          ? msg('Source snapshot time unavailable')
          : `Source snapshot ${Math.max(2, Math.round(sourceAgeMs / 60_000))} min old`
        : null;
      feed._lastSource = snapshot.source;
      feed._lastCoverage = snapshot.coverage;
      setSourceLabel(feed._lastSource);
      const accepted = timed
        ? applySnapshot(snapshot, viewer, { replace })
        : applySnapshot(snapshot, viewer);
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
      return true;
    } catch (e) {
      if (updateSignal.aborted || e?.name === 'AbortError') {
        throw new DOMException('Flights update aborted', 'AbortError');
      }
      console.warn('[Data:Flights] Fetch error:', e);
      feed._backoff = true;
      // A snapshot at a time is asked again by the clock's follower.
      if (!timed)
        feed._retryAt =
          Date.now() + (e?.retryAfterMs ?? ERROR_BACKOFF_INTERVAL);
      feed._lastStatus = e?.status ?? null;
      if (e?.source) {
        feed._lastSource = e.source;
        setSourceLabel(feed._lastSource);
      }
      feed._lastError =
        e?.name === 'LiveSourceError'
          ? e.message
          : msg('Live data unavailable');
      return false;
    } finally {
      feed._activeUpdateControllers.delete(resourceController);
    }
  }

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
