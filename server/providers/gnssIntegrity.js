import {
  GNSS_CLASSIFIER,
  GNSS_WINDOW_MS,
  normalizeGnssAircraft,
} from '../../src/layers/gnss/records.js';
import { adsbLolFallbackAnchor } from './aircraft/opensky.js';
import { coalesceProxyRequest, readResponseJsonCapped } from './common/http.js';
import { makeRateLimiter, clientKey } from './common/rate-limit.js';

// adsb.lol regional snapshot (keyless, ODbL). Only the integrity fields the
// GNSS layer needs leave this proxy, so the browser never sees the full feed.
// This is a separate read from the flights fallback on purpose: that point
// cache keeps only the fields the flights layer renders (no nic / nac_p), is
// keyed on 0.25° anchors and lives for 12 s, while integrity cells need
// whole-degree anchors held for a minute.
const RADIUS_NM = 250;
const CACHE_MS = 60_000;
const CACHE_MAX = 64;
/** Cooldown after a 429 or 5xx when upstream sends no usable Retry-After. */
const COOLDOWN_MS = 60_000;
/** Bounds for an upstream-supplied Retry-After. */
const COOLDOWN_MIN_MS = 5_000;
const COOLDOWN_MAX_MS = 120_000;
const MAX_RESPONSE_BYTES = 8 * 1024 * 1024;
const TIMEOUT_MS = 10_000;

/** Snap a view anchor to a whole degree so nearby views share one upstream read. */
export function gnssIntegrityAnchor(url) {
  const anchor = adsbLolFallbackAnchor({ url });
  if (!anchor) return null;
  return {
    lat: Math.round(anchor.latitude),
    lon: Math.round(anchor.longitude),
  };
}

/** Cooldown (ms) an upstream 429 earns, honouring Retry-After when sane. */
export function gnssRetryCooldownMs(raw, nowMs) {
  const clamp = (ms) =>
    Math.min(COOLDOWN_MAX_MS, Math.max(COOLDOWN_MIN_MS, ms));
  if (raw) {
    const seconds = Number(raw);
    if (Number.isFinite(seconds) && seconds > 0) return clamp(seconds * 1000);
    const at = Date.parse(raw);
    if (Number.isFinite(at) && at > nowMs) return clamp(at - nowMs);
  }
  return COOLDOWN_MS;
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
        cooldownUntil =
          now() +
          gnssRetryCooldownMs(response.headers.get('retry-after'), now());
        throw Object.assign(new Error('upstream_rate_limited'), {
          status: 429,
        });
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
      // `degraded` on each row is this classifier's verdict, not gpsjam's.
      classifier: GNSS_CLASSIFIER.id,
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
      // A stale answer keeps its original fetchedAt so the layer can age it;
      // past the layer's window it is no evidence at all, so it is not served.
      if (previous && now() - previous.fetchedAt <= GNSS_WINDOW_MS)
        return { value: previous, stale: true };
      throw error;
    }
  }

  async function handler(req, res) {
    const json = (status, value, stale = false, retryAfterS = 60) => {
      if (res.destroyed) return;
      res.writeHead(status, {
        'Content-Type': 'application/json',
        'Cache-Control': 'no-store',
        ...(status === 405 ? { Allow: 'GET' } : {}),
        ...(status === 429 ? { 'Retry-After': String(retryAfterS) } : {}),
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
      if (error.status === 429) {
        // Tell the browser how long the shared upstream cooldown has left.
        const retryAfterS = Math.max(
          1,
          Math.ceil((cooldownUntil - now()) / 1000),
        );
        return json(
          429,
          { error: 'gnss_integrity_rate_limited' },
          false,
          retryAfterS,
        );
      }
      json(502, { error: 'gnss_integrity_unavailable' });
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
