import { normalizeGnssAircraft } from '../../src/layers/gnss/records.js';
import { coalesceProxyRequest, readResponseJsonCapped } from './common/http.js';
import { requiredFiniteQueryNumber } from './common/query.js';
import { makeRateLimiter, clientKey } from './common/rate-limit.js';

// adsb.lol regional snapshot (keyless, ODbL). Only the integrity fields the
// GNSS layer needs leave this proxy, so the browser never sees the full feed.
const RADIUS_NM = 250;
const CACHE_MS = 60_000;
const CACHE_MAX = 64;
const COOLDOWN_MS = 60_000;
const MAX_RESPONSE_BYTES = 8 * 1024 * 1024;
const TIMEOUT_MS = 10_000;

/** Snap a view anchor to a whole degree so nearby views share one upstream read. */
export function gnssIntegrityAnchor(url) {
  const params = new URL(url || '/', 'http://localhost').searchParams;
  const lat = requiredFiniteQueryNumber(params, 'lat');
  const lon = requiredFiniteQueryNumber(params, 'lon');
  if (!Number.isFinite(lat) || lat < -90 || lat > 90) return null;
  if (!Number.isFinite(lon) || lon < -180 || lon > 180) return null;
  return { lat: Math.round(lat), lon: Math.round(lon) };
}

/** Fixed-origin, bounded adsb.lol integrity route for dev and preview. */
export function gnssIntegrityProxy({
  fetchImpl = (...args) => globalThis.fetch(...args),
  now = () => Date.now(),
} = {}) {
  const cache = new Map();
  const inFlight = new Map();
  const allow = makeRateLimiter({ windowMs: 60_000, max: 30, globalMax: 600 });
  let cooldownUntil = 0;

  async function load({ lat, lon }) {
    if (now() < cooldownUntil)
      throw Object.assign(new Error('cooling_down'), { status: 429 });
    const signal = AbortSignal.timeout(TIMEOUT_MS);
    const response = await fetchImpl(
      `https://api.adsb.lol/v2/lat/${lat}/lon/${lon}/dist/${RADIUS_NM}`,
      {
        signal,
        redirect: 'error',
        headers: {
          Accept: 'application/json',
          'User-Agent': 'gods-eye-view-gnss-integrity/1.0',
        },
      },
    );
    if (!response.ok) {
      await response.body?.cancel();
      if (response.status === 429) {
        const retryS = Number(response.headers.get('retry-after'));
        cooldownUntil =
          now() +
          (Number.isFinite(retryS) && retryS > 0
            ? Math.min(retryS * 1000, 10 * COOLDOWN_MS)
            : COOLDOWN_MS);
      }
      throw new Error('upstream_unavailable');
    }
    const payload = await readResponseJsonCapped(
      response,
      MAX_RESPONSE_BYTES,
      signal,
    );
    const rows = normalizeGnssAircraft(payload);
    if (!rows) throw new Error('invalid_snapshot');
    return {
      fetchedAt: now(),
      anchor: { lat, lon },
      radiusNm: RADIUS_NM,
      rows,
    };
  }

  async function acquire(anchor) {
    const key = `${anchor.lat},${anchor.lon}`;
    const previous = cache.get(key);
    if (previous && now() - previous.fetchedAt < CACHE_MS)
      return { value: previous, stale: false };
    try {
      const { promise } = coalesceProxyRequest(inFlight, key, async () => {
        const value = await load(anchor);
        cache.delete(key);
        cache.set(key, value);
        while (cache.size > CACHE_MAX) cache.delete(cache.keys().next().value);
        return value;
      });
      return { value: await promise, stale: false };
    } catch (error) {
      if (previous) return { value: previous, stale: true };
      throw error;
    }
  }

  async function handler(req, res) {
    const json = (status, value, stale = false) => {
      if (res.destroyed) return;
      res.writeHead(status, {
        'Content-Type': 'application/json',
        'Cache-Control': 'no-store',
        ...(status === 405 ? { Allow: 'GET' } : {}),
        ...(status === 429 ? { 'Retry-After': '60' } : {}),
        ...(stale ? { 'X-Data-Stale': 'true' } : {}),
      });
      res.end(JSON.stringify(value));
    };
    if (req.method !== 'GET') return json(405, { error: 'method_not_allowed' });
    const path = (req.url || '/').split('?')[0];
    if (path !== '/' && path !== '')
      return json(404, { error: 'unknown_route' });
    const anchor = gnssIntegrityAnchor(req.url);
    if (!anchor) return json(400, { error: 'invalid_anchor' });
    if (!allow(clientKey(req))) return json(429, { error: 'rate_limited' });
    try {
      const { value, stale } = await acquire(anchor);
      json(200, stale ? { ...value, stale: true } : value, stale);
    } catch (error) {
      json(error.status === 429 ? 429 : 502, {
        error: 'gnss_integrity_unavailable',
      });
    }
  }

  return {
    name: 'gnss-integrity',
    configureServer({ middlewares }) {
      middlewares.use('/api/gnss-integrity', handler);
    },
    configurePreviewServer({ middlewares }) {
      middlewares.use('/api/gnss-integrity', handler);
    },
  };
}
