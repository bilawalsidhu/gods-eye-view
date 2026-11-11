import { isIPv6 } from 'node:net';
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
  // Only an explicit 0 disables the guard: a positive fraction such as 0.5
  // would floor to 0, so it takes the strictest real cap instead.
  if (parsed > 0 && parsed < 1) return 1;
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

const IPV4_MAPPED_RE = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i;

/**
 * Whether a socket peer address is this machine: IPv4 loopback in any of its
 * forms (`127.0.0.0/8`, including the IPv4-mapped `::ffff:127.x` a dual-stack
 * listener reports) or the IPv6 loopback. Non-address keys are not loopback.
 * @param {string} address - A `clientKey` value.
 * @returns {boolean}
 */
export function isLoopbackPeer(address) {
  const raw = String(address || '');
  const v4 = IPV4_MAPPED_RE.exec(raw)?.[1] ?? raw;
  return v4.startsWith('127.') || raw === '::1';
}

/**
 * Rate-limit key that survives address rotation, for limiters whose global
 * backstop everyone shares. IPv6 privacy extensions hand one host a fresh
 * address at will inside its /64, so keying by the full address lets a single
 * host mint per-peer quota until the global window closes for everyone else.
 * IPv6 peers are keyed by their /64 prefix instead, and an IPv4-mapped
 * address folds to its IPv4 form so one host cannot hold two buckets. Any
 * other value (IPv4, or the `local` fallback) passes through unchanged.
 * @param {import('node:http').IncomingMessage} req
 * @returns {string}
 */
export function clientNetworkKey(req) {
  const address = clientKey(req);
  const mapped = IPV4_MAPPED_RE.exec(address);
  if (mapped) return mapped[1];
  const bare = address.replace(/%.*$/, ''); // link-local zone id
  if (!isIPv6(bare)) return address;
  const [head, tail = ''] = bare.split('::');
  const headParts = head ? head.split(':') : [];
  const tailParts = tail ? tail.split(':') : [];
  const missing = Math.max(0, 8 - headParts.length - tailParts.length);
  const hextets = [...headParts, ...Array(missing).fill('0'), ...tailParts];
  return `${hextets
    .slice(0, 4)
    .map((h) => h.toLowerCase().replace(/^0+(?=.)/, ''))
    .join(':')}::/64`;
}
