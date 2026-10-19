import {
  GDACS_EVENT_TYPES,
  normalizeGdacsCollection,
} from '../../src/layers/gdacs/records.js';
import { coalesceProxyRequest, readResponseJsonCapped } from './common/http.js';
import { makeRateLimiter, clientKey } from './common/rate-limit.js';

// GDACS map feeds (keyless, CC BY 4.0). One fixed URL per hazard type: the
// same feeds the gdacs.org map loads. The drought feed carries footprint
// polygons (about 3 MB), so only event centroids leave this proxy and each
// type is held for as long as GDACS takes to change it.
const FEED_URL =
  'https://www.gdacs.org/gdacsapi/api/events/geteventlist/MAP?eventtype=';
const MINUTE = 60_000;
export const GDACS_TTL_MS = Object.freeze({
  FL: 60 * MINUTE,
  VO: 30 * MINUTE,
  DR: 180 * MINUTE,
});
/**
 * After a failed feed, wait this long (or the type's TTL, if shorter) before
 * asking GDACS for that feed again, so one broken feed is not re-fetched on
 * every request.
 */
const FAILURE_RETRY_MS = 5 * MINUTE;
/** Cooldown after a 429 when upstream sends no usable Retry-After. */
const COOLDOWN_MS = 5 * MINUTE;
/** Floor for an upstream-supplied Retry-After; it only ever lengthens it. */
const COOLDOWN_MIN_MS = 30_000;
/** A Retry-After further out than this is treated as a broken header. */
const COOLDOWN_MAX_MS = 24 * 60 * MINUTE;
const MAX_RESPONSE_BYTES = 8 * 1024 * 1024;
const TIMEOUT_MS = 20_000;

/**
 * Cooldown (ms) an upstream 429 earns. A valid Retry-After (delay-seconds or
 * a future HTTP-date, up to 24 h out) is honoured in full; a missing or
 * unusable one earns the default five minutes.
 */
export function gdacsRetryCooldownMs(raw, nowMs) {
  const honour = (ms) =>
    ms <= COOLDOWN_MAX_MS ? Math.max(COOLDOWN_MIN_MS, ms) : COOLDOWN_MAX_MS;
  const value = typeof raw === 'string' ? raw.trim() : '';
  if (/^\d+$/.test(value)) {
    const seconds = Number(value);
    if (seconds > 0) return honour(seconds * 1000);
  } else if (value) {
    const at = Date.parse(value);
    if (Number.isFinite(at) && at > nowMs) return honour(at - nowMs);
  }
  return COOLDOWN_MS;
}

/**
 * GDACS answers a valid event type with no current events (volcanoes, most
 * days) with a 404 problem document rather than an empty FeatureCollection.
 * That is an empty feed, not an outage; any other 404 still counts as one.
 */
const isEmptyFeed = (response) =>
  response.status === 404 &&
  (response.headers.get('content-type') || '')
    .toLowerCase()
    .startsWith('application/problem+json');

/** Fixed-origin, bounded GDACS alert route for dev and preview. */
export function gdacsProxy({
  fetchImpl = (...args) => globalThis.fetch(...args),
  now = () => Date.now(),
} = {}) {
  const cache = new Map();
  /** type -> time before which a failed feed is not asked for again. */
  const failedUntil = new Map();
  const inFlight = new Map();
  const allow = makeRateLimiter({ windowMs: 60_000, max: 30, globalMax: 600 });
  let cooldownUntil = 0;

  async function load(type) {
    if (now() < cooldownUntil)
      throw Object.assign(new Error('cooling_down'), { status: 429 });
    const signal = AbortSignal.timeout(TIMEOUT_MS);
    const response = await fetchImpl(`${FEED_URL}${type}`, {
      signal,
      redirect: 'error',
      headers: {
        Accept: 'application/json',
        'User-Agent': 'gods-eye-view-gdacs/1.0',
      },
    });
    if (!response.ok) {
      await response.body?.cancel();
      if (isEmptyFeed(response)) return { fetchedAt: now(), events: [] };
      if (response.status === 429) {
        // Concurrent feeds may each carry a deadline: keep the longest.
        cooldownUntil = Math.max(
          cooldownUntil,
          now() +
            gdacsRetryCooldownMs(response.headers.get('retry-after'), now()),
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
    const events = normalizeGdacsCollection(payload);
    if (!events) throw new Error('invalid_feed');
    return { fetchedAt: now(), events };
  }

  // Each feed fails on its own: a failure serves that feed's last good copy
  // (stale) or reports it missing, and holds off re-fetching it for a while,
  // without touching the other feeds.
  async function acquire(type) {
    const previous = cache.get(type);
    if (previous && now() - previous.fetchedAt < GDACS_TTL_MS[type])
      return { value: previous, stale: false };
    const failure = failedUntil.get(type);
    if (failure && now() < failure.until) {
      if (previous) return { value: previous, stale: true };
      throw failure.error;
    }
    try {
      const { promise } = coalesceProxyRequest(inFlight, type, async () => {
        try {
          const value = await load(type);
          cache.set(type, value);
          failedUntil.delete(type);
          return value;
        } catch (error) {
          // A 429 is held off by the shared cooldown instead.
          if (error?.status !== 429)
            failedUntil.set(type, {
              until: now() + Math.min(FAILURE_RETRY_MS, GDACS_TTL_MS[type]),
              error,
            });
          throw error;
        }
      });
      return { value: await promise, stale: false };
    } catch (error) {
      if (previous) return { value: previous, stale: true };
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
    const settled = await Promise.allSettled(GDACS_EVENT_TYPES.map(acquire));
    const feeds = [];
    const events = [];
    let rateLimited = false;
    settled.forEach((result, index) => {
      const type = GDACS_EVENT_TYPES[index];
      if (result.status === 'fulfilled') {
        const { value, stale } = result.value;
        feeds.push({ type, fetchedAt: value.fetchedAt, stale });
        events.push(...value.events);
      } else {
        rateLimited ||= result.reason?.status === 429;
        feeds.push({ type, fetchedAt: null, stale: false, missing: true });
      }
    });
    if (feeds.every((feed) => feed.missing)) {
      if (rateLimited) {
        // Tell the browser how long the shared upstream cooldown has left.
        const retryAfterS = Math.max(
          1,
          Math.ceil((cooldownUntil - now()) / 1000),
        );
        return json(429, { error: 'gdacs_rate_limited' }, false, retryAfterS);
      }
      return json(502, { error: 'gdacs_unavailable' });
    }
    // Only a cached copy makes the answer stale; a missing feed is reported
    // on its own entry and leaves the fresh ones fresh.
    const stale = feeds.some((feed) => feed.stale);
    json(
      200,
      {
        fetchedAt: now(),
        feeds,
        events,
        ...(stale ? { stale: true } : {}),
      },
      stale,
    );
  }

  return {
    name: 'gdacs',
    configureServer({ middlewares }) {
      middlewares.use('/api/gdacs', handler);
    },
    configurePreviewServer({ middlewares }) {
      middlewares.use('/api/gdacs', handler);
    },
  };
}
