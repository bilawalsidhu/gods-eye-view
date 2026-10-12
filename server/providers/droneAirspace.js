import { normalizeDroneAirspaceSnapshot } from '../../src/layers/droneAirspace/records.js';
import { readResponseJsonCapped, coalesceProxyRequest } from './common/http.js';
import { makeRateLimiter, clientKey } from './common/rate-limit.js';

// FAA Special Use Airspace (public, keyless). TYPE_CODE P (prohibited) and
// R (restricted) only — the small, always-in-force slice of the national
// SUA table. maxAllowableOffset trades ~100 m of boundary fidelity for a
// payload small enough to refresh (~330 KB for the current P+R set).
const API_URL =
  'https://services6.arcgis.com/ssFJjBXIUyZDrSYZ/arcgis/rest/services/' +
  'Special_Use_Airspace/FeatureServer/0/query?' +
  new URLSearchParams({
    where: "TYPE_CODE IN ('P','R')",
    outFields: [
      'NAME',
      'TYPE_CODE',
      'UPPER_DESC',
      'LOWER_DESC',
      'TIMESOFUSE',
      'CONT_AGENT',
      'CITY',
      'STATE',
      'OBJECTID',
    ].join(','),
    maxAllowableOffset: '0.001',
    outSR: '4326',
    f: 'geojson',
  }).toString();

const MAX_PAGES = 5;
const MIB = 1024 * 1024;
const SNAPSHOT_TTL_MS = 3_600_000;

const exceededTransferLimit = (payload) =>
  payload?.exceededTransferLimit === true ||
  payload?.properties?.exceededTransferLimit === true;

/** Fixed-origin, bounded FAA SUA routes for dev and preview. */
export function droneAirspaceProxy({
  fetchImpl = (...args) => globalThis.fetch(...args),
  now = () => Date.now(),
} = {}) {
  const cache = new Map();
  const inFlight = new Map();
  const allow = makeRateLimiter({ windowMs: 60_000, max: 60, globalMax: 1200 });

  async function upstream(url, cap, timeout) {
    const signal = AbortSignal.timeout(timeout);
    const response = await fetchImpl(url, {
      signal,
      redirect: 'error',
    });
    if (!response.ok) {
      await response.body?.cancel();
      throw new Error('upstream_unavailable');
    }
    return readResponseJsonCapped(response, cap, signal);
  }

  async function fetchZones() {
    const features = [];
    for (let page = 0; page < MAX_PAGES; page++) {
      const url =
        page === 0 ? API_URL : `${API_URL}&resultOffset=${features.length}`;
      const payload = await upstream(url, 8 * MIB, 30_000);
      if (!Array.isArray(payload?.features))
        throw new Error('invalid_snapshot');
      features.push(...payload.features);
      if (!exceededTransferLimit(payload) || !payload.features.length) break;
    }
    const rows = normalizeDroneAirspaceSnapshot({ features });
    if (!rows) throw new Error('invalid_snapshot');
    return { fetchedAt: now(), rows };
  }

  async function acquire(key, ttl, load) {
    const previous = cache.get(key);
    if (previous && now() - previous.savedAt < ttl)
      return { value: previous.value, stale: false };
    if (!inFlight.has(key) && inFlight.size >= 256)
      throw Object.assign(new Error('busy'), { status: 429 });
    try {
      const { promise } = coalesceProxyRequest(inFlight, key, async () => {
        const value = await load();
        cache.set(key, { value, savedAt: now() });
        return value;
      });
      return { value: await promise, stale: false };
    } catch (error) {
      if (previous) return { value: previous.value, stale: true };
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
    if (!allow(clientKey(req))) return json(429, { error: 'rate_limited' });
    try {
      const { value, stale } = await acquire(
        'zones',
        SNAPSHOT_TTL_MS,
        fetchZones,
      );
      json(200, stale ? { ...value, stale: true } : value, stale);
    } catch (error) {
      json(error.status === 429 ? 429 : 502, {
        error: 'drone_airspace_unavailable',
      });
    }
  }

  return {
    name: 'drone-airspace',
    configureServer({ middlewares }) {
      middlewares.use('/api/drone-airspace', handler);
    },
    configurePreviewServer({ middlewares }) {
      middlewares.use('/api/drone-airspace', handler);
    },
  };
}
