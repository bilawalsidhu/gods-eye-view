import { normalizeFireballs } from '../../src/layers/fireballs/records.js';
import { coalesceProxyRequest, readResponseJsonCapped } from './common/http.js';
import { makeRateLimiter, clientKey } from './common/rate-limit.js';
import { admitSameSiteKeyless } from './common/same-site.js';
import { providerUserAgent } from './common/userAgent.js';

// Every located event the API holds (about a thousand rows since 1988).
// JPL serves no CORS headers, so the browser reads it through this proxy.
export const FIREBALL_API_URL =
  'https://ssd-api.jpl.nasa.gov/fireball.api?req-loc=true';
// New events arrive days to weeks after the fact; an hour is plenty fresh.
const TTL_MS = 60 * 60_000;
const STALE_MAX_MS = 7 * 24 * 60 * 60_000;
const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
const TIMEOUT_MS = 20_000;
const FAILURE_COOLDOWN_MS = 60_000;

/** `/api/fireballs/events`: the JPL CNEOS fireball table, normalized and cached. */
export function fireballsProxy({
  fetchImpl = (...args) => globalThis.fetch(...args),
  now = () => Date.now(),
  cache = new Map(),
  warn = (...args) => console.warn(...args),
} = {}) {
  const inFlight = new Map();
  const allow = makeRateLimiter({
    windowMs: 60_000,
    max: 30,
    globalMax: 300,
    now,
  });
  let cooldownUntil = 0;

  const unavailable = () =>
    Object.assign(new Error('fireballs_unavailable'), {
      status: 502,
      retryAfterS: Math.max(1, Math.ceil((cooldownUntil - now()) / 1000)),
    });

  async function load() {
    if (now() < cooldownUntil) throw unavailable();
    const signal = AbortSignal.timeout(TIMEOUT_MS);
    try {
      const response = await fetchImpl(FIREBALL_API_URL, {
        signal,
        redirect: 'error',
        headers: {
          Accept: 'application/json',
          'User-Agent': providerUserAgent('fireballs'),
        },
      });
      if (!response.ok) {
        await response.body?.cancel().catch(() => {});
        throw new Error(`HTTP ${response.status}`);
      }
      const payload = await readResponseJsonCapped(
        response,
        MAX_RESPONSE_BYTES,
        signal,
      );
      const rows = normalizeFireballs(payload);
      if (!rows) throw new Error('invalid_snapshot');
      return { fetchedAt: now(), rows };
    } catch (error) {
      cooldownUntil = now() + FAILURE_COOLDOWN_MS;
      warn('[fireballs-proxy] upstream refresh failed:', error?.message);
      throw unavailable();
    }
  }

  const age = (entry) => {
    if (!entry) return Infinity;
    const elapsed = now() - entry.savedAt;
    return elapsed < 0 ? Infinity : elapsed;
  };

  async function acquire() {
    const previous = cache.get('events');
    if (age(previous) < TTL_MS) return { value: previous.value, stale: false };
    if (age(previous) > STALE_MAX_MS) cache.delete('events');
    try {
      const { promise } = coalesceProxyRequest(inFlight, 'events', async () => {
        const value = await load();
        cache.set('events', { value, savedAt: now() });
        return value;
      });
      return { value: await promise, stale: false };
    } catch (error) {
      if (age(previous) <= STALE_MAX_MS)
        return { value: previous.value, stale: true };
      throw error;
    }
  }

  async function handler(req, res) {
    const json = (status, value, { stale = false, retryAfterS } = {}) => {
      if (res.destroyed) return;
      res.writeHead(status, {
        'Content-Type': 'application/json',
        'Cache-Control': 'no-store',
        ...(status === 405 ? { Allow: 'GET' } : {}),
        ...(retryAfterS ? { 'Retry-After': String(retryAfterS) } : {}),
        ...(stale ? { 'X-Data-Stale': 'true' } : {}),
      });
      res.end(JSON.stringify(value));
    };
    if (admitSameSiteKeyless(req, res)) return;
    if (req.method !== 'GET') return json(405, { error: 'method_not_allowed' });
    const pathname = (req.url || '/').split('?')[0];
    if (pathname !== '/events') return json(404, { error: 'unknown_route' });
    if (!allow(clientKey(req)))
      return json(429, { error: 'rate_limited' }, { retryAfterS: 60 });
    try {
      const { value, stale } = await acquire();
      return json(200, stale ? { ...value, stale: true } : value, { stale });
    } catch (error) {
      return json(
        502,
        { error: 'fireballs_unavailable' },
        { retryAfterS: error.retryAfterS },
      );
    }
  }

  return {
    name: 'fireballs',
    configureServer({ middlewares }) {
      middlewares.use('/api/fireballs', handler);
    },
    configurePreviewServer({ middlewares }) {
      middlewares.use('/api/fireballs', handler);
    },
  };
}
