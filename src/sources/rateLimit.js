/** Bounded per-key and aggregate request admission. */
const RATE_LIMITER_MAX_KEYS = 2000;

export function makeRateLimiter({
  windowMs,
  max,
  globalMax,
  now = () => Date.now(),
}) {
  const hits = new Map(); // key -> number[] (timestamps within window)
  let globalTimes = []; // all hits in window, for the global backstop
  return function allow(key) {
    const at = now();
    globalTimes = globalTimes.filter((t) => at - t < windowMs);
    if (globalMax && globalTimes.length >= globalMax) return false; // global backstop
    const recent = (hits.get(key) || []).filter((t) => at - t < windowMs);
    if (recent.length >= max) {
      hits.set(key, recent);
      return false;
    }
    recent.push(at);
    hits.set(key, recent);
    globalTimes.push(at);
    // Hard key cap so a key-rotating caller can't grow the map without bound.
    if (hits.size > RATE_LIMITER_MAX_KEYS) {
      const oldest = hits.keys().next().value;
      if (oldest !== undefined) hits.delete(oldest);
    }
    if (hits.size > 256) {
      for (const [k, v] of hits) {
        if (!v.length || at - v[v.length - 1] > windowMs) hits.delete(k);
      }
    }
    return true;
  };
}
