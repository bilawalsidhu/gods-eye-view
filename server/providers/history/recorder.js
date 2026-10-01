import { shouldKeep, inRegions } from './thinning.js';

/**
 * Track recorder: observations in, thinned fixes out to the store.
 *
 * Retention tiers:
 *   pinned   = inside a configured region of interest, or watchlisted
 *   unpinned = everything else the feeds delivered
 * When `recordUnpinned` is false only pinned fixes are written.
 */

export const DEFAULT_RETENTION = Object.freeze({
  unpinnedMs: 48 * 3_600_000,
  pinnedMs: 30 * 86_400_000,
  downsampleAfterMs: 7 * 86_400_000,
  downsampleBucketMs: 120_000,
  camMs: 30 * 86_400_000,
  alertsMs: 90 * 86_400_000,
});

/**
 * @param {object} opts
 * @param {() => Promise<object>} opts.getStore Store accessor.
 * @param {() => object[]} opts.regions Current regions of interest.
 * @param {(domain: string, id: string) => boolean} opts.isWatched Watch test.
 * @param {boolean} [opts.recordUnpinned]
 * @param {() => number} [opts.now]
 * @param {number} [opts.maxBuffer]
 */
export function createRecorder({
  getStore,
  regions,
  isWatched,
  recordUnpinned = true,
  now = Date.now,
  maxBuffer = 50_000,
  stateIdleMs = 2 * 3_600_000,
}) {
  /** @type {Map<string, object>} key -> last kept fix */
  const last = new Map();
  let buffer = [];
  let flushing = null;
  const counters = {
    received: 0,
    kept: 0,
    written: 0,
    dropped: 0,
    rejected: {},
    lastFlushAt: null,
    lastError: null,
  };

  function ingest(batch) {
    const roi = regions();
    for (const obs of batch) {
      counters.received++;
      const key = `${obs.domain}:${obs.id}`;
      const pinned =
        inRegions(roi, obs.lat, obs.lon) || isWatched(obs.domain, obs.id);
      if (!pinned && !recordUnpinned) continue;
      const decision = shouldKeep(last.get(key) || null, obs);
      if (!decision.keep) {
        counters.rejected[decision.reason] =
          (counters.rejected[decision.reason] || 0) + 1;
        continue;
      }
      const fix = { ...obs, pinned };
      last.set(key, fix);
      counters.kept++;
      if (buffer.length >= maxBuffer) {
        buffer.shift();
        counters.dropped++;
      }
      buffer.push(fix);
    }
  }

  async function flush() {
    if (flushing) return flushing;
    if (!buffer.length) return 0;
    const batch = buffer;
    buffer = [];
    flushing = (async () => {
      try {
        const store = await getStore();
        const written = await store.insertFixes(batch);
        counters.written += written;
        counters.lastFlushAt = now();
        counters.lastError = null;
        return written;
      } catch (error) {
        counters.lastError = String(error?.message || error).slice(0, 200);
        // Put the batch back (bounded) so a transient store error loses nothing.
        buffer = batch.concat(buffer).slice(-maxBuffer);
        throw error;
      } finally {
        flushing = null;
      }
    })();
    return flushing;
  }

  function evictIdle() {
    const cutoff = now() - stateIdleMs;
    for (const [key, fix] of last) if (fix.t < cutoff) last.delete(key);
  }

  return {
    ingest,
    flush,
    evictIdle,
    stats: () => ({
      ...counters,
      rejected: { ...counters.rejected },
      buffered: buffer.length,
      trackedAssets: last.size,
    }),
    /** Last kept fix per asset (the live picture the recorder holds). */
    lastFix: (domain, id) => last.get(`${domain}:${id}`) || null,
  };
}
