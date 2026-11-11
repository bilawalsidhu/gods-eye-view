import { ERROR_BACKOFF_INTERVAL } from './recordPolicy.js';

// Marks English the Layers panel translates when it shows the error. Kept
// local: this module stays free of browser globals (package boundaries).
const msg = (text) => text;

/** Own military source acquisition, cancellation, freshness and error backoff. */
export function createIngestion({
  feed,
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
      const snapshot = await feed._source.getSnapshot(timed ? { atMs } : {}, {
        signal: updateSignal,
      });
      updateSignal.throwIfAborted();
      // The clock left the live edge while this poll was out.
      if (!timed && followsClock()) return;
      feed._lastStatus = snapshot.status ?? 200;
      feed._lastSource = snapshot.source;
      setSourceLabel(feed._lastSource);
      feed._backoff = snapshot.stale || snapshot.freshness === 'unknown';
      feed._retryAt = 0;
      feed._lastError =
        snapshot.reason ||
        (snapshot.freshness === 'unknown'
          ? msg('Source snapshot time unavailable')
          : null);
      const accepted = timed
        ? applySnapshot(snapshot, viewer, { replace })
        : applySnapshot(snapshot, viewer);
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
      return true;
    } catch (e) {
      if (updateSignal.aborted || e?.name === 'AbortError') {
        throw new DOMException('Military update aborted', 'AbortError');
      }
      console.warn('[Data:Military] Fetch error:', e);
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
  feed._trackingRefreshEpoch = 0;
  feed._lastTrackingRefreshOutcome = {
    epoch: 0,
    status: 'unavailable',
    ids: new Set(),
    source: feed._lastSource,
  };
  return feed;
}
