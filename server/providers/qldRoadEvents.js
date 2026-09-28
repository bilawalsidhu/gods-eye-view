import { normalizeQldRoadEventSnapshot } from '../../src/layers/qldRoadEvents/records.js';
import { readResponseJsonCapped, coalesceProxyRequest } from './common/http.js';
import { makeRateLimiter, clientKey } from './common/rate-limit.js';

// Public key published in the QLDTraffic API specification. It is shared by
// every consumer and limited upstream to 100 requests/minute in total, so this
// proxy serves one cached snapshot to all clients. QLDTRAFFIC_API_KEY
// overrides it with a registered key.
export const QLDTRAFFIC_PUBLIC_API_KEY = '3e83add325cbb69ac4d8e5bf433d770b';
const EVENTS_URL = 'https://api.qldtraffic.qld.gov.au/v2/events';
const MIB = 1024 * 1024;

/** Cache and failure policy; exported for tests and docs. */
export const QLD_ROAD_EVENTS_POLICY = Object.freeze({
  freshMs: 120_000,
  retryAfterFailureMs: 60_000,
  staleLimitMs: 6 * 3_600_000,
  timeoutMs: 20_000,
  maxBytes: 12 * MIB,
});

/** Resolve the QLDTraffic key: a sane env override, else the public key. */
export function qldTrafficApiKey(env = process.env) {
  const value = String(env.QLDTRAFFIC_API_KEY || '').trim();
  return /^[A-Za-z0-9_-]{8,128}$/.test(value)
    ? value
    : QLDTRAFFIC_PUBLIC_API_KEY;
}

/** Fixed-origin, cached QLDTraffic events route for dev and preview. */
export function qldRoadEventsProxy({
  fetchImpl = (...args) => globalThis.fetch(...args),
  now = () => Date.now(),
  env = process.env,
  policy = QLD_ROAD_EVENTS_POLICY,
} = {}) {
  let cache = null;
  let failedAt = -Infinity;
  const inFlight = new Map();
  const allow = makeRateLimiter({ windowMs: 60_000, max: 30, globalMax: 600 });

  async function fetchEvents() {
    const url = new URL(EVENTS_URL);
    url.searchParams.set('apikey', qldTrafficApiKey(env));
    const signal = AbortSignal.timeout(policy.timeoutMs);
    const response = await fetchImpl(url.href, {
      signal,
      redirect: 'error',
      headers: {
        Accept: 'application/geo+json,application/json',
        'User-Agent': 'Gods Eye View (QLDTraffic open data)',
      },
    });
    if (!response.ok) {
      await response.body?.cancel();
      throw new Error('qldtraffic_upstream_unavailable');
    }
    const payload = await readResponseJsonCapped(
      response,
      policy.maxBytes,
      signal,
    );
    const events = normalizeQldRoadEventSnapshot(payload);
    if (!events) throw new Error('invalid_qldtraffic_snapshot');
    return { fetchedAt: now(), events };
  }

  /** Fresh cache, else one shared upstream read; failures back off for a minute. */
  async function acquire() {
    if (cache && now() - cache.fetchedAt < policy.freshMs)
      return { value: cache, stale: false };
    if (!inFlight.size && now() - failedAt < policy.retryAfterFailureMs) {
      if (cache) return { value: cache, stale: true };
      throw new Error('qldtraffic_retry_later');
    }
    try {
      const { promise } = coalesceProxyRequest(inFlight, 'events', async () => {
        try {
          cache = await fetchEvents();
          failedAt = -Infinity;
          return cache;
        } catch (error) {
          failedAt = now();
          throw error;
        }
      });
      return { value: await promise, stale: false };
    } catch (error) {
      if (cache) return { value: cache, stale: true };
      throw error;
    }
  }

  function describe(value, stale) {
    return {
      schemaVersion: 1,
      source: 'QLDTraffic',
      attribution: 'QLDTraffic — Queensland Government (CC BY 4.0)',
      fetchedAt: value.fetchedAt,
      stale,
      events: value.events,
    };
  }

  async function handler(req, res) {
    const json = (status, value, extra = {}) => {
      if (res.destroyed) return;
      res.writeHead(status, {
        'Content-Type': 'application/json',
        'Cache-Control': 'no-store',
        ...(status === 405 ? { Allow: 'GET' } : {}),
        ...(status === 429 ? { 'Retry-After': '60' } : {}),
        ...extra,
      });
      res.end(JSON.stringify(value));
    };
    if (req.method !== 'GET') return json(405, { error: 'method_not_allowed' });
    const path = (req.url || '/').split('?')[0];
    if (path !== '/' && path !== '')
      return json(404, { error: 'unknown_route' });
    if (!allow(clientKey(req))) return json(429, { error: 'rate_limited' });
    try {
      const { value, stale } = await acquire();
      if (stale && now() - value.fetchedAt > policy.staleLimitMs)
        return json(502, { error: 'qld_road_events_unavailable' });
      json(
        200,
        describe(value, stale),
        stale ? { 'X-Data-Stale': 'true' } : {},
      );
    } catch {
      json(502, { error: 'qld_road_events_unavailable' });
    }
  }

  return {
    name: 'qld-road-events',
    configureServer({ middlewares }) {
      middlewares.use('/api/qld-road-events', handler);
    },
    configurePreviewServer({ middlewares }) {
      middlewares.use('/api/qld-road-events', handler);
    },
  };
}
