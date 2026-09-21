import { makeRateLimiter } from '../../../src/sources/rateLimit.js';
export { makeRateLimiter } from '../../../src/sources/rateLimit.js';

/**
 * Resolve the per-IP, per-minute cap for a cost-bearing proxy from its env var.
 *
 * The default is ON. An unset or blank value takes `defaultPerMin`; a positive
 * integer overrides it; an explicit `0` disables the limiter for deployments
 * that genuinely want no throttle.
 *
 * A value that cannot be read as a number — a typo, a stray unit, a negative —
 * also takes the default rather than disabling the guard. That asymmetry is the
 * point: `GEV_RATELIMIT_OPENAI_PER_MIN=3O` should not quietly hand an exposed
 * server's API key to whoever asks. Removing the throttle stays possible, but
 * only by saying `0`, which cannot be typed by accident.
 *
 * @param {string|number|undefined|null} envValue - Raw env value (requests/min/IP).
 * @param {number} defaultPerMin - Cap to apply when the value is absent or unreadable.
 * @returns {number} Requests/min/IP; `0` means unlimited.
 */
export function resolvePerMinuteCap(envValue, defaultPerMin) {
  const raw = typeof envValue === 'string' ? envValue.trim() : envValue;
  if (raw === undefined || raw === null || raw === '') return defaultPerMin;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed < 0) return defaultPerMin;
  return Math.floor(parsed); // includes the explicit 0 = unlimited opt-out
}

/**
 * Per-IP rate limiter for the cost-bearing API proxies (OpenAI / Google).
 * Returns `null` only when the cap resolves to `0` (the explicit opt-out), in
 * which case the caller skips the check entirely. Otherwise a fixed 60s window
 * of N requests/IP, built lazily once and reused so its per-IP window state
 * persists across requests. The global backstop is a generous multiple of the
 * per-IP cap so a single host can't starve the rest.
 *
 * @param {string|number|undefined|null} envValue - Raw env value (requests/min/IP).
 * @param {number} defaultPerMin - Cap to apply when the value is absent or unreadable.
 * @returns {((key:string)=>boolean)|null} An `allow(key)` fn, or null when unlimited.
 */
export function makeCostRateLimiter(envValue, defaultPerMin) {
  const max = resolvePerMinuteCap(envValue, defaultPerMin);
  if (max <= 0) return null; // explicit opt-out
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
