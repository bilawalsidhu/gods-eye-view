import {
  RADIATION_SOURCES,
  normalizeBfsCollection,
  radiationMaxAgeMs,
  normalizeSafecastDevices,
} from '../../src/layers/radiation/records.js';
import { coalesceProxyRequest, readResponseJsonCapped } from './common/http.js';
import { makeRateLimiter, clientKey } from './common/rate-limit.js';

// Two keyless dose-rate networks, one fixed URL each:
// - BfS ODL (Germany, dl-de/by-2-0): the open WFS layer of each station's
//   latest 1-hour mean. BfS updates it hourly.
// - Safecast realtime (worldwide, CC0): the latest record per device. The
//   records also carry owner contact details, so only normalised readings
//   leave this proxy.
const FEEDS = Object.freeze({
  bfs: Object.freeze({
    url: 'https://www.imis.bfs.de/ogc/opendata/ows?service=WFS&version=1.1.0&request=GetFeature&typeName=opendata:odlinfo_odl_1h_latest&outputFormat=application/json',
    normalize: normalizeBfsCollection,
    rows: (payload) => payload?.features?.length || 0,
  }),
  safecast: Object.freeze({
    url: 'https://tt.safecast.org/devices',
    normalize: normalizeSafecastDevices,
    rows: (payload) => (Array.isArray(payload) ? payload.length : 0),
  }),
});
const MINUTE = 60_000;
export const RADIATION_TTL_MS = Object.freeze({
  bfs: 15 * MINUTE,
  safecast: 10 * MINUTE,
});
/** Cooldown after a 429 when upstream sends no usable Retry-After. */
const COOLDOWN_MS = 5 * MINUTE;
/** Bounds for an upstream-supplied Retry-After. */
const COOLDOWN_MIN_MS = 30_000;
const COOLDOWN_MAX_MS = 60 * MINUTE;
const MAX_RESPONSE_BYTES = 8 * 1024 * 1024;
const TIMEOUT_MS = 20_000;

/** Cooldown (ms) an upstream 429 earns, honouring Retry-After when sane. */
export function radiationRetryCooldownMs(raw, nowMs) {
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

/** Fixed-origin, bounded dose-rate route for dev and preview. */
export function radiationProxy({
  fetchImpl = (...args) => globalThis.fetch(...args),
  now = () => Date.now(),
} = {}) {
  const cache = new Map();
  const inFlight = new Map();
  /** feed -> time its upstream 429 cooldown ends */
  const cooldownUntil = new Map();
  const allow = makeRateLimiter({ windowMs: 60_000, max: 30, globalMax: 600 });

  async function load(feed) {
    if (now() < (cooldownUntil.get(feed) || 0))
      throw Object.assign(new Error('cooling_down'), { status: 429 });
    const signal = AbortSignal.timeout(TIMEOUT_MS);
    const response = await fetchImpl(FEEDS[feed].url, {
      signal,
      redirect: 'error',
      headers: {
        Accept: 'application/json',
        'User-Agent': 'gods-eye-view-radiation/1.0',
      },
    });
    if (!response.ok) {
      await response.body?.cancel();
      if (response.status === 429) {
        cooldownUntil.set(
          feed,
          now() +
            radiationRetryCooldownMs(
              response.headers.get('retry-after'),
              now(),
            ),
        );
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
    const readings = FEEDS[feed].normalize(payload, now());
    if (!readings) throw new Error('invalid_feed');
    // A feed that published rows but none current (a late BfS hour, say) is
    // a failure: it must not replace the last good copy.
    if (!readings.length && FEEDS[feed].rows(payload))
      throw new Error('no_current_readings');
    return { fetchedAt: now(), readings };
  }

  async function acquire(feed) {
    const previous = cache.get(feed);
    if (previous && now() - previous.fetchedAt < RADIATION_TTL_MS[feed])
      return { value: previous, stale: false };
    try {
      const { promise } = coalesceProxyRequest(inFlight, feed, async () => {
        const value = await load(feed);
        cache.set(feed, value);
        return value;
      });
      return { value: await promise, stale: false };
    } catch (error) {
      // The last good copy only serves readings that are still current; a
      // long outage empties it and the feed is reported missing.
      const maxAgeMs = radiationMaxAgeMs(feed);
      const current = previous?.readings.filter(
        (reading) => now() - reading.atMs <= maxAgeMs,
      );
      if (current?.length)
        return { value: { ...previous, readings: current }, stale: true };
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
    if (!allow(clientKey(req))) return json(429, { error: 'rate_limited' });
    const settled = await Promise.allSettled(RADIATION_SOURCES.map(acquire));
    const feeds = [];
    const readings = [];
    let rateLimited = false;
    settled.forEach((result, index) => {
      const source = RADIATION_SOURCES[index];
      if (result.status === 'fulfilled') {
        const { value, stale } = result.value;
        feeds.push({ source, fetchedAt: value.fetchedAt, stale });
        readings.push(...value.readings);
      } else {
        rateLimited ||= result.reason?.status === 429;
        feeds.push({ source, fetchedAt: null, stale: false, missing: true });
      }
    });
    if (feeds.every((feed) => feed.missing)) {
      if (rateLimited) {
        // Tell the browser how long the shortest upstream cooldown has left.
        // When the other feed failed some other way this is only a hint: the
        // browser's next poll simply tries again.
        const until = Math.min(
          ...[...cooldownUntil.values()].filter((at) => at > now()),
        );
        const retryAfterS = Number.isFinite(until)
          ? Math.max(1, Math.ceil((until - now()) / 1000))
          : 60;
        return json(
          429,
          { error: 'radiation_rate_limited' },
          false,
          retryAfterS,
        );
      }
      return json(502, { error: 'radiation_unavailable' });
    }
    const stale = feeds.some((feed) => feed.stale || feed.missing);
    json(
      200,
      {
        fetchedAt: now(),
        feeds,
        readings,
        ...(stale ? { stale: true } : {}),
      },
      stale,
    );
  }

  return {
    name: 'radiation',
    configureServer({ middlewares }) {
      middlewares.use('/api/radiation', handler);
    },
    configurePreviewServer({ middlewares }) {
      middlewares.use('/api/radiation', handler);
    },
  };
}
