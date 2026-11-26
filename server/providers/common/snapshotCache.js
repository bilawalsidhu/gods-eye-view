/**
 * One national snapshot shared by every request: fresh for `ttlMs`, one
 * refresh at a time, `retryMs` between failed refreshes, and the last good
 * snapshot answered as stale for up to `staleMs`.
 */
export function cachedSnapshot({
  ttlMs,
  retryMs,
  staleMs,
  acquire,
  now = Date.now,
}) {
  let snapshot = null,
    at = 0,
    inflight = null,
    retryAt = 0,
    failure = null;
  return {
    /**
     * `{ snapshot, stale, failure }`, `failure` being the last refresh's error
     * until a good one follows; rejects with it when no snapshot is young enough.
     */
    async get(...args) {
      if (snapshot && now() - at < ttlMs)
        return { snapshot, stale: false, failure: null };
      if (!inflight && now() >= retryAt)
        inflight = Promise.resolve()
          .then(() => acquire(...args))
          .then(
            (value) => {
              snapshot = value;
              at = now();
              retryAt = 0;
              failure = null;
            },
            (error) => {
              retryAt = now() + retryMs;
              failure = error;
            },
          )
          .finally(() => {
            inflight = null;
          });
      await inflight;
      if (snapshot && now() - at <= staleMs)
        return { snapshot, stale: now() - at >= ttlMs, failure };
      throw failure ?? new Error('Snapshot unavailable');
    },
  };
}
