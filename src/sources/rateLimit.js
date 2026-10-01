/** Bounded per-key and aggregate request admission. */
const RATE_LIMITER_MAX_KEYS = 2000;

export function makeRateLimiter({ windowMs, max, globalMax }) {
  const hits = new Map(); // key -> number[] (timestamps within window)
  let globalTimes = []; // all hits in window, for the global backstop
  function allow(key) {
    const now = Date.now();
    globalTimes = globalTimes.filter((t) => now - t < windowMs);
    if (globalMax && globalTimes.length >= globalMax) return false; // global backstop
    const recent = (hits.get(key) || []).filter((t) => now - t < windowMs);
    if (recent.length >= max) {
      hits.set(key, recent);
      return false;
    }
    recent.push(now);
    hits.set(key, recent);
    globalTimes.push(now);
    // Hard key cap so a key-rotating caller can't grow the map without bound.
    if (hits.size > RATE_LIMITER_MAX_KEYS) {
      const oldest = hits.keys().next().value;
      if (oldest !== undefined) hits.delete(oldest);
    }
    if (hits.size > 256) {
      for (const [k, v] of hits) {
        if (!v.length || now - v[v.length - 1] > windowMs) hits.delete(k);
      }
    }
    return true;
  }
  /**
   * Milliseconds until `key` (or the global backstop) frees a slot; 0 when a
   * request would be admitted now. Read-only: it never records a hit.
   */
  allow.retryAfterMs = (key) => {
    const now = Date.now();
    const live = (times) => times.filter((t) => now - t < windowMs);
    const freeAt = (times, cap) =>
      times.length >= cap ? times[times.length - cap] + windowMs - now : 0;
    const perKey = freeAt(live(hits.get(key) || []), max);
    const global = globalMax ? freeAt(live(globalTimes), globalMax) : 0;
    return Math.max(0, perKey, global);
  };
  return allow;
}
