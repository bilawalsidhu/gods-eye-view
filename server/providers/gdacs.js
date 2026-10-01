import {
  GDACS_EVENT_TYPES,
  normalizeGdacsCollection,
} from '../../src/layers/gdacs/records.js';
import { coalesceProxyRequest, readResponseJsonCapped } from './common/http.js';
import { makeRateLimiter, clientKey } from './common/rate-limit.js';

// GDACS map feeds (keyless, CC BY 4.0). One fixed URL per hazard type: the
// same feeds the gdacs.org map loads. Tropical cyclone and drought feeds carry
// track, cone and footprint polygons (2–3 MB), so only event centroids leave
// this proxy and each type is held for as long as GDACS takes to change it.
const FEED_URL =
  'https://www.gdacs.org/gdacsapi/api/events/geteventlist/MAP?eventtype=';
const MINUTE = 60_000;
export const GDACS_TTL_MS = Object.freeze({
  EQ: 10 * MINUTE,
  TC: 30 * MINUTE,
  FL: 60 * MINUTE,
  VO: 30 * MINUTE,
  DR: 180 * MINUTE,
  WF: 60 * MINUTE,
});
/** Cooldown after a 429 when upstream sends no usable Retry-After. */
const COOLDOWN_MS = 5 * MINUTE;
/** Bounds for an upstream-supplied Retry-After. */
const COOLDOWN_MIN_MS = 30_000;
const COOLDOWN_MAX_MS = 30 * MINUTE;
const MAX_RESPONSE_BYTES = 8 * 1024 * 1024;
const TIMEOUT_MS = 20_000;

/** Cooldown (ms) an upstream 429 earns, honouring Retry-After when sane. */
export function gdacsRetryCooldownMs(raw, nowMs) {
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

/** Fixed-origin, bounded GDACS alert route for dev and preview. */
export function gdacsProxy({
  fetchImpl = (...args) => globalThis.fetch(...args),
  now = () => Date.now(),
} = {}) {
  const cache = new Map();
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
      if (response.status === 429) {
        cooldownUntil =
          now() +
          gdacsRetryCooldownMs(response.headers.get('retry-after'), now());
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

  async function acquire(type) {
    const previous = cache.get(type);
    if (previous && now() - previous.fetchedAt < GDACS_TTL_MS[type])
      return { value: previous, stale: false };
    try {
      const { promise } = coalesceProxyRequest(inFlight, type, async () => {
        const value = await load(type);
        cache.set(type, value);
        return value;
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
    const stale = feeds.some((feed) => feed.stale || feed.missing);
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
