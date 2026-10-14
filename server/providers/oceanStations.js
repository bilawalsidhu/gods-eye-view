import { parseNdbcLatestObs } from '../../src/layers/oceanStations/records.js';
import { readResponseTextCapped, coalesceProxyRequest } from './common/http.js';
import { makeRateLimiter, clientKey } from './common/rate-limit.js';

const UPSTREAM_URL = 'https://www.ndbc.noaa.gov/data/latest_obs/latest_obs.txt';
const CACHE_TTL_MS = 10 * 60_000; // 10 minutes
const MAX_STALE_MS = 12 * 3600_000; // 12 hours
const MAX_BODY_BYTES = 512 * 1024; // 512 KB
const FETCH_TIMEOUT_MS = 15_000;

/**
 * Real-time NOAA NDBC Ocean Observation Stations proxy for dev and preview servers.
 */
export function oceanStationsProxy({
  fetchImpl = (...args) => globalThis.fetch(...args),
  now = () => Date.now(),
} = {}) {
  let cache = null;
  const inFlight = new Map();
  const allow = makeRateLimiter({ windowMs: 60_000, max: 60, globalMax: 1200 });

  async function fetchLatestStations() {
    const signal = AbortSignal.timeout(FETCH_TIMEOUT_MS);
    const response = await fetchImpl(UPSTREAM_URL, {
      signal,
      redirect: 'error',
      headers: {
        'User-Agent':
          'gods-eye-view/0.2.1 (+https://github.com/bilawalsidhu/gods-eye-view)',
        Accept: 'text/plain, */*',
      },
    });

    if (!response.ok) {
      await response.body?.cancel();
      throw new Error(`upstream_unavailable: ${response.status}`);
    }

    const rawText = await readResponseTextCapped(
      response,
      MAX_BODY_BYTES,
      signal,
    );
    const stations = parseNdbcLatestObs(rawText);
    if (!stations) {
      throw new Error('invalid_snapshot');
    }

    const snapshot = {
      fetchedAt: now(),
      count: stations.length,
      stations,
    };
    cache = snapshot;
    return snapshot;
  }

  async function handler(req, res) {
    const controller = new AbortController();
    const close = () => controller.abort();
    res.once?.('close', close);

    const json = (status, value, stale = false) => {
      if (controller.signal.aborted) return;
      res.writeHead(status, {
        'Content-Type': 'application/json',
        'Cache-Control': 'no-store',
        ...(stale ? { 'X-Cache-Status': 'stale' } : {}),
      });
      res.end(JSON.stringify(value));
    };

    try {
      if (req.method !== 'GET') {
        return json(405, { error: 'method_not_allowed' });
      }

      const urlPath = req.url?.split('?')[0] || '';
      if (urlPath !== '/' && urlPath !== '' && urlPath !== '/latest') {
        return json(404, { error: 'unknown_route' });
      }

      if (!allow(clientKey(req))) {
        return json(429, { error: 'rate_limited' });
      }

      const currentTime = now();
      if (cache && currentTime - cache.fetchedAt < CACHE_TTL_MS) {
        return json(200, cache);
      }

      try {
        const { promise } = coalesceProxyRequest(
          inFlight,
          'latest_obs',
          fetchLatestStations,
        );
        const snapshot = await promise;
        return json(200, snapshot);
      } catch (error) {
        if (cache && currentTime - cache.fetchedAt < MAX_STALE_MS) {
          return json(200, { ...cache, stale: true }, true);
        }
        return json(502, { error: 'ocean_stations_unavailable' });
      }
    } finally {
      res.removeListener?.('close', close);
    }
  }

  return {
    name: 'ocean-stations',
    configureServer({ middlewares }) {
      middlewares.use('/api/ocean-stations', handler);
    },
    configurePreviewServer({ middlewares }) {
      middlewares.use('/api/ocean-stations', handler);
    },
  };
}
