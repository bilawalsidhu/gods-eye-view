import { makeRateLimiter } from '../../../src/sources/rateLimit.js';
export { makeRateLimiter } from '../../../src/sources/rateLimit.js';

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

/** name -> { value, limiter } for envRateLimiter. */
const envLimiters = new Map();

/**
 * The shared opt-in limiter for one environment variable. Read on each call
 * (never at import: `.env` is applied to process.env after providers load),
 * and memoised per variable, so every route that names the same variable
 * spends ONE per-IP budget. A changed value builds a fresh limiter.
 *
 * @param {string} name - Env var holding requests/min/IP.
 * @param {string} [fallbackName] - Var whose value is used when `name` is unset.
 * @returns {((key:string)=>boolean)|null} Limiter, or null when unlimited.
 */
export function envRateLimiter(name, fallbackName) {
  const raw = process.env[name];
  const value = String(
    (raw === undefined || raw === '') && fallbackName
      ? (process.env[fallbackName] ?? '')
      : (raw ?? ''),
  );
  const cached = envLimiters.get(name);
  if (cached && cached.value === value) return cached.limiter;
  const limiter = makeOptInRateLimiter(value);
  envLimiters.set(name, { value, limiter });
  return limiter;
}

/**
 * Whole seconds a refused client should wait, for a `Retry-After` header.
 * Uses the limiter's own window when it can tell, else a constant.
 *
 * @param {((key:string)=>boolean)&{retryAfterMs?:(key:string)=>number}} limiter
 * @param {string} key
 * @returns {string}
 */
export function retryAfterSeconds(limiter, key) {
  const ms = Number(limiter?.retryAfterMs?.(key));
  return String(Number.isFinite(ms) && ms > 0 ? Math.ceil(ms / 1000) : 5);
}

/**
 * Strip a port (and IPv6 brackets) from one X-Forwarded-For hop. App Service
 * appends `ip:port` for IPv4 and `[ip]:port` for IPv6; a bare IPv6 address
 * (several colons, no brackets) is returned unchanged.
 */
function hostOfForwardedHop(hop) {
  const value = hop.trim();
  if (value.startsWith('[')) {
    const end = value.indexOf(']');
    return end > 1 ? value.slice(1, end) : '';
  }
  const colons = value.split(':').length - 1;
  return colons === 1 ? value.slice(0, value.indexOf(':')) : value;
}

/**
 * Client key for rate limiting.
 *
 * Locally (dev server, `npm run preview`) the socket peer is the real client,
 * and X-Forwarded-For is NOT trusted: it is client-controlled, so a rotating
 * value would mint fresh quota and grow the limiter map.
 *
 * Behind Azure App Service (detected by WEBSITE_INSTANCE_ID, which the platform
 * sets on every instance) the socket peer is the front end, so every caller
 * would share one bucket. There the platform appends the real peer as the
 * RIGHT-MOST X-Forwarded-For entry; only that hop is trusted, never the
 * client-supplied entries to its left.
 */
export function clientKey(req) {
  const socketKey = String(req.socket?.remoteAddress || 'local');
  if (!process.env.WEBSITE_INSTANCE_ID) return socketKey;
  const raw = req.headers?.['x-forwarded-for'];
  const header = Array.isArray(raw) ? raw.join(',') : String(raw || '');
  const hops = header.split(',').filter((hop) => hop.trim());
  const last = hops.length ? hostOfForwardedHop(hops.at(-1)) : '';
  return last || socketKey;
}
