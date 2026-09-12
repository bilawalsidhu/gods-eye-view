/**
 * Minimal fixed-window per-key rate limiter for the dev proxies. Not a hard
 * security boundary (dev-only), just a backstop so a runaway client can't hammer
 * the public Overpass / OSRM mirrors or exhaust this process.
 */
const RATE_LIMITER_MAX_KEYS = 2000;

export function makeRateLimiter({ windowMs, max, globalMax }) {
  const hits = new Map(); // key -> number[] (timestamps within window)
  let globalTimes = []; // all hits in window, for the global backstop
  return function allow(key) {
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
  };
}

/**
 * Opt-in per-IP rate limiter for the cost-bearing API proxies (OpenAI / Google).
 * DEFAULT IS UNLIMITED: when the env var is unset, `0`, or non-numeric, this
 * returns `null` and the caller skips the check entirely — a runtime no-op that
 * preserves the original behavior. Only a positive integer N enables a fixed
 * 60s window of N requests/IP (built lazily once, then reused so its per-IP
 * window state persists across requests). The global backstop is set to a
 * generous multiple of the per-IP cap so a single host can't starve the rest.
 *
 * @param {string|undefined} envValue - Raw env value (requests/min/IP).
 * @returns {((key:string)=>boolean)|null} An `allow(key)` fn, or null when unlimited.
 */
export function makeOptInRateLimiter(envValue) {
  const max = Number(envValue);
  if (!Number.isFinite(max) || max <= 0) return null; // unset/0/garbage -> unlimited
  return makeRateLimiter({
    windowMs: 60_000,
    max: Math.floor(max),
    globalMax: Math.floor(max) * 20,
  });
}

/**
 * Client key for rate limiting. Uses the real socket peer address only — we do
 * NOT trust X-Forwarded-For (client-controlled; a rotating value would mint fresh
 * quota and grow the limiter map). This is a localhost dev proxy, so the socket
 * address is the real client.
 */
export function clientKey(req) {
  return String(req.socket?.remoteAddress || 'local');
}
