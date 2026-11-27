import {
  TURBULENCE_SCHEMA_VERSION,
  REPORT_WINDOW_MS,
  normalizeGairmet,
  normalizePireps,
  normalizeSigmets,
} from '../../src/layers/turbulence/records.js';
import { readResponseJsonCapped, coalesceProxyRequest } from './common/http.js';
import { makeRateLimiter, clientKey } from './common/rate-limit.js';
import { admitSameSiteKeyless } from './common/same-site.js';
import { providerUserAgent } from './common/userAgent.js';

// NOAA/NWS Aviation Weather Center Data API (public, keyless; US government
// work). Its documented limit is 100 requests a minute and it asks clients
// to keep requests few and spaced: one refresh is seven requests, one after
// another, at most once every ten minutes for every viewer together.
const ORIGIN = 'https://aviationweather.gov';
const FORECAST_HOURS = Object.freeze([0, 3, 6, 9, 12]);
const KIB = 1024;
const MIB = 1024 * KIB;
const FRESH_MS = 10 * 60_000;
/** Longest a failed feed keeps serving its last good records, marked stale. */
const STALE_MAX_MS = 6 * 60 * 60_000;
/** After a failed refresh, the feeds are not asked again for this long. */
const RETRY_AFTER_FAILURE_MS = 60_000;
const REQUEST_TIMEOUT_MS = 15_000;
const PAUSE_BETWEEN_REQUESTS_MS = 250;
/** Forecast snapshots older than this are no longer offered. */
const FORECAST_MAX_AGE_MS = 12 * 60 * 60_000;
export const TURBULENCE_UNAVAILABLE = 'Turbulence data unavailable';

const url = (path, query) =>
  `${ORIGIN}${path}?${new URLSearchParams(query).toString()}`;

/**
 * The three feeds: fixed paths and parameters only (nothing from the
 * browser reaches an upstream URL), each normalized by records.js.
 */
const FEEDS = Object.freeze({
  forecasts: {
    requests: FORECAST_HOURS.map((fore) => ({
      url: url('/api/data/gairmet', {
        product: 'tango',
        fore: String(fore),
        format: 'geojson',
      }),
      cap: 1 * MIB,
    })),
    normalize: (payloads, now) =>
      payloads.flatMap((payload) => {
        const records = normalizeGairmet(payload, { now });
        if (!records) throw new Error('invalid_gairmet');
        return records;
      }),
  },
  warnings: {
    requests: [
      { url: url('/api/data/sigmet', { format: 'geojson' }), cap: 4 * MIB },
    ],
    normalize: ([payload], now) => {
      const records = normalizeSigmets(payload, { now });
      if (!records) throw new Error('invalid_sigmet');
      return records;
    },
  },
  reports: {
    requests: [
      {
        url: url('/api/data/pirep', {
          bbox: '-90,-180,90,180',
          age: '3',
          inten: 'lgt',
          format: 'geojson',
        }),
        cap: 4 * MIB,
      },
    ],
    normalize: ([payload], now) => {
      const records = normalizePireps(payload, { now });
      if (!records) throw new Error('invalid_pirep');
      return records;
    },
  },
});
const FEED_KEYS = Object.freeze(Object.keys(FEEDS));

/** Records still worth serving at `now`, from a feed's last good copy. */
const current = {
  forecasts: (records, now) =>
    records.filter((r) => r.validAt >= now - FORECAST_MAX_AGE_MS),
  warnings: (records, now) => records.filter((r) => r.validTo > now),
  reports: (records, now) =>
    records.filter((r) => r.observedAt >= now - REPORT_WINDOW_MS),
};

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Fixed-origin, bounded NOAA AWC turbulence route for dev and preview. */
export function turbulenceProxy({
  fetchImpl = (...args) => globalThis.fetch(...args),
  now = () => Date.now(),
  pauseMs = PAUSE_BETWEEN_REQUESTS_MS,
} = {}) {
  /** @type {Map<string, {records: object[], savedAt: number}>} */
  const cache = new Map();
  const inFlight = new Map();
  const allow = makeRateLimiter({ windowMs: 60_000, max: 60, globalMax: 1200 });
  let attemptedAt = -Infinity;
  let failedAt = -Infinity;

  async function upstream({ url: target, cap }) {
    const signal = AbortSignal.timeout(REQUEST_TIMEOUT_MS);
    const response = await fetchImpl(target, {
      signal,
      redirect: 'error',
      headers: {
        Accept: 'application/geo+json, application/json',
        'User-Agent': providerUserAgent('turbulence'),
      },
    });
    // No content: nothing in force for this query.
    if (response.status === 204) {
      await response.body?.cancel();
      return { type: 'FeatureCollection', features: [] };
    }
    if (!response.ok) {
      await response.body?.cancel();
      throw new Error('upstream_unavailable');
    }
    return readResponseJsonCapped(response, cap, signal);
  }

  let first = true;
  async function loadFeed(key) {
    const feed = FEEDS[key];
    const payloads = [];
    for (const request of feed.requests) {
      if (!first && pauseMs > 0) await wait(pauseMs);
      first = false;
      payloads.push(await upstream(request));
    }
    return feed.normalize(payloads, now());
  }

  /** Refresh every feed that is not fresh; one failing leaves the others. */
  async function refresh() {
    attemptedAt = now();
    first = true;
    let failed = false;
    for (const key of FEED_KEYS) {
      const previous = cache.get(key);
      if (previous && now() - previous.savedAt < FRESH_MS) continue;
      try {
        cache.set(key, { records: await loadFeed(key), savedAt: now() });
      } catch {
        failed = true;
      }
    }
    if (failed) failedAt = now();
  }

  function snapshot() {
    const at = now();
    const result = {
      schemaVersion: TURBULENCE_SCHEMA_VERSION,
      fetchedAt: null,
      stale: false,
      partial: false,
      unavailable: false,
      reason: null,
      forecasts: [],
      warnings: [],
      reports: [],
    };
    let served = 0;
    for (const key of FEED_KEYS) {
      const entry = cache.get(key);
      if (!entry || at - entry.savedAt > STALE_MAX_MS) {
        result.partial = true;
        continue;
      }
      served++;
      if (at - entry.savedAt >= FRESH_MS) result.stale = true;
      result.fetchedAt =
        result.fetchedAt === null
          ? entry.savedAt
          : Math.min(result.fetchedAt, entry.savedAt);
      result[key] = current[key](entry.records, at);
    }
    if (!served) {
      result.unavailable = true;
      result.partial = false;
      result.stale = false;
      result.reason = TURBULENCE_UNAVAILABLE;
    }
    return result;
  }

  async function acquire() {
    const at = now();
    const fresh = FEED_KEYS.every((key) => {
      const entry = cache.get(key);
      return entry && at - entry.savedAt < FRESH_MS;
    });
    // A failed refresh is not repeated for a minute: viewers are served what
    // is cached, marked stale or partial, meanwhile.
    const backingOff =
      failedAt >= attemptedAt && at - attemptedAt < RETRY_AFTER_FAILURE_MS;
    if (!fresh && !backingOff) {
      const { promise } = coalesceProxyRequest(inFlight, 'refresh', refresh);
      await promise;
    }
    return snapshot();
  }

  async function handler(req, res) {
    const json = (status, value) => {
      if (res.destroyed) return;
      res.writeHead(status, {
        'Content-Type': 'application/json',
        'Cache-Control': 'no-store',
        ...(status === 405 ? { Allow: 'GET' } : {}),
        ...(status === 429 ? { 'Retry-After': '60' } : {}),
        ...(value?.stale ? { 'X-Data-Stale': 'true' } : {}),
      });
      res.end(JSON.stringify(value));
    };
    // Keyless and needed to render the layer: refuse cross-site browsers
    // before they spend the shared upstream allowance.
    if (admitSameSiteKeyless(req, res)) return;
    if (req.method !== 'GET') return json(405, { error: 'method_not_allowed' });
    const path = (req.url || '/').split('?')[0];
    if (path !== '/' && path !== '')
      return json(404, { error: 'unknown_route' });
    if (!allow(clientKey(req))) return json(429, { error: 'rate_limited' });
    try {
      json(200, await acquire());
    } catch {
      json(502, { error: 'turbulence_unavailable' });
    }
  }

  return {
    name: 'turbulence',
    configureServer({ middlewares }) {
      middlewares.use('/api/turbulence', handler);
    },
    configurePreviewServer({ middlewares }) {
      middlewares.use('/api/turbulence', handler);
    },
  };
}
