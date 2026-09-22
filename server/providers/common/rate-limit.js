import { makeRateLimiter } from '../../../src/sources/rateLimit.js';
export { makeRateLimiter } from '../../../src/sources/rateLimit.js';

/**
 * Secure-by-default per-IP rate limiter for the cost-bearing API proxies
 * (OpenAI / Google). DEFAULT IS 30 REQ/MIN/IP: when the env var is unset,
 * this applies a safe default that prevents wallet-drain attacks where an
 * attacker (especially via DNS rebinding) makes unlimited requests consuming
 * the victim's API credits. Set to `0` to explicitly opt out of throttling.
 * The global backstop is set to a generous multiple of the per-IP cap so a
 * single host can't starve the rest.
 *
 * @param {string|undefined} envValue - Raw env value (requests/min/IP).
 * @param {number} [defaultMax=30] - Safe default when envValue is unset.
 * @returns {((key:string)=>boolean)|null} An `allow(key)` fn, or null when explicitly unlimited.
 */
export function makeOptInRateLimiter(envValue, defaultMax = 30) {
  const raw = Number(envValue);
  // Explicit 0 = opt-out (unlimited). Unset/garbage = use safe default.
  if (envValue !== undefined && envValue !== '' && raw === 0) return null;
  const max = Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : defaultMax;
  return makeRateLimiter({
    windowMs: 60_000,
    max,
    globalMax: max * 20,
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
