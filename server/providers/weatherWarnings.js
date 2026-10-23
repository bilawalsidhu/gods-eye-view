import { normalizeWeatherWarningSnapshot } from '../../src/layers/weatherWarnings/records.js';
import {
  avalancheRegionPolygons,
  groupNveWarnings,
  normalizeAvalancheWarnings,
} from '../../src/layers/weatherWarnings/nveRecords.js';
import { simplifyRing } from '../../src/sources/featureGeometry.js';
import { readResponseJsonCapped, coalesceProxyRequest } from './common/http.js';
import { makeRateLimiter, clientKey } from './common/rate-limit.js';

// Norway's official warnings, all public and keyless:
// - MET Norway MetAlerts 2.0 (CC BY 4.0): weather warnings for land and sea.
//   MET's terms require an identifying User-Agent.
// - NVE / Varsom (NLOD): flood and landslide warnings per municipality, and
//   avalanche danger per forecast region.
// - Kartverket (CC BY 4.0): municipality outlines for the NVE warnings.
const MET_URL =
  'https://api.met.no/weatherapi/metalerts/2.0/current.json?lang=en';
const NVE_API = 'https://api01.nve.no/hydrology/forecast';
const AVALANCHE_API = `${NVE_API}/avalanche/v6.3.0/api`;
const MUNICIPALITY_URL = (number) =>
  `https://ws.geonorge.no/kommuneinfo/v1/kommuner/${number}/omrade`;
const USER_AGENT =
  'gods-eye-view/0.1 (+https://github.com/bilawalsidhu/gods-eye-view)';
const MIB = 1024 * 1024;
const DAY_MS = 86_400_000;
const TTL_MS = Object.freeze({
  met: 300_000,
  flood: 600_000,
  landslide: 600_000,
  avalanche: 600_000,
  regions: DAY_MS,
  municipality: 7 * DAY_MS,
});
/** Municipality outlines are simplified to about this many metres. */
const MUNICIPALITY_TOLERANCE_M = 250;
const MUNICIPALITY_CACHE_LIMIT = 400;
const MUNICIPALITY_CONCURRENCY = 6;
export const WARNING_SOURCES = Object.freeze([
  'met',
  'flood',
  'landslide',
  'avalanche',
]);

/** `YYYY-MM-DD` of an instant, shifted by whole days. */
const isoDay = (ms, days = 0) =>
  new Date(ms + days * DAY_MS).toISOString().slice(0, 10);

/** Fixed-origin, bounded warnings route for dev and preview. */
export function weatherWarningsProxy({
  fetchImpl = (...args) => globalThis.fetch(...args),
  now = () => Date.now(),
} = {}) {
  const cache = new Map();
  const inFlight = new Map();
  const allow = makeRateLimiter({ windowMs: 60_000, max: 60, globalMax: 1200 });

  async function upstreamJson(url, cap, timeout = 20_000) {
    const signal = AbortSignal.timeout(timeout);
    const response = await fetchImpl(url, {
      signal,
      redirect: 'error',
      headers: { 'User-Agent': USER_AGENT, Accept: 'application/json' },
    });
    if (!response.ok) {
      await response.body?.cancel();
      throw new Error('upstream_unavailable');
    }
    return readResponseJsonCapped(response, cap, signal);
  }

  /** Cached, coalesced acquisition with the last good value as fallback. */
  async function cached(key, ttl, load) {
    const previous = cache.get(key);
    if (previous && now() - previous.savedAt < ttl)
      return { value: previous.value, stale: false };
    try {
      const { promise } = coalesceProxyRequest(inFlight, key, async () => {
        const value = await load();
        cache.delete(key);
        cache.set(key, { value, savedAt: now() });
        return value;
      });
      return { value: await promise, stale: false };
    } catch (error) {
      if (previous) return { value: previous.value, stale: true };
      throw error;
    }
  }

  async function municipalityPolygons(number) {
    const { value } = await cached(
      `municipality:${number}`,
      TTL_MS.municipality,
      async () => {
        const payload = await upstreamJson(MUNICIPALITY_URL(number), 8 * MIB);
        const geometry = payload?.omrade;
        const polygons =
          geometry?.type === 'Polygon'
            ? [geometry.coordinates]
            : geometry?.type === 'MultiPolygon'
              ? geometry.coordinates
              : null;
        if (!Array.isArray(polygons)) throw new Error('invalid_municipality');
        return polygons
          .filter((rings) => Array.isArray(rings) && rings.length)
          .map((rings) =>
            rings.map((ring) => simplifyRing(ring, MUNICIPALITY_TOLERANCE_M)),
          );
      },
    );
    // Keep the outline cache bounded; warnings name a few dozen at most.
    const keys = [...cache.keys()].filter((key) =>
      key.startsWith('municipality:'),
    );
    for (const key of keys.slice(
      0,
      Math.max(0, keys.length - MUNICIPALITY_CACHE_LIMIT),
    ))
      cache.delete(key);
    return value;
  }

  /** Resolve each row's municipalities to outlines; unresolvable ones are skipped. */
  async function attachMunicipalities(rows) {
    const numbers = [...new Set(rows.flatMap((row) => row.municipalities))];
    const outlines = new Map();
    for (let i = 0; i < numbers.length; i += MUNICIPALITY_CONCURRENCY) {
      const batch = numbers.slice(i, i + MUNICIPALITY_CONCURRENCY);
      const settled = await Promise.allSettled(batch.map(municipalityPolygons));
      settled.forEach((result, index) => {
        if (result.status === 'fulfilled')
          outlines.set(batch[index], result.value);
      });
    }
    return rows
      .map(({ municipalities, ...row }) => ({
        ...row,
        polygons: municipalities.flatMap(
          (number) => outlines.get(number) ?? [],
        ),
      }))
      .filter((row) => row.polygons.length);
  }

  const loaders = {
    async met() {
      const rows = normalizeWeatherWarningSnapshot(
        await upstreamJson(MET_URL, 16 * MIB),
      );
      if (rows === null) throw new Error('invalid_snapshot');
      return rows;
    },
    async flood() {
      return nveRows('flood');
    },
    async landslide() {
      return nveRows('landslide');
    },
    async avalanche() {
      const { value: polygons } = await cached(
        'regions',
        TTL_MS.regions,
        async () =>
          avalancheRegionPolygons(
            await upstreamJson(`${AVALANCHE_API}/Region/`, 8 * MIB),
          ),
      );
      const at = now();
      const rows = normalizeAvalancheWarnings(
        await upstreamJson(
          `${AVALANCHE_API}/RegionSummary/Simple/2/${isoDay(at, -1)}/${isoDay(at, 1)}`,
          4 * MIB,
        ),
        polygons,
        at,
      );
      if (rows === null) throw new Error('invalid_snapshot');
      return rows;
    },
  };

  async function nveRows(kind) {
    const at = now();
    const url = `${NVE_API}/${kind}/v1.0.10/api/Warning/All/2/${isoDay(at, -1)}/${isoDay(at, 1)}`;
    const rows = groupNveWarnings(await upstreamJson(url, 16 * MIB), kind, at);
    if (rows === null) throw new Error('invalid_snapshot');
    return attachMunicipalities(rows);
  }

  async function snapshot() {
    const settled = await Promise.allSettled(
      WARNING_SOURCES.map((source) =>
        cached(source, TTL_MS[source], loaders[source]),
      ),
    );
    const rows = [];
    const errors = [];
    let stale = false;
    settled.forEach((result, index) => {
      if (result.status === 'fulfilled') {
        rows.push(...result.value.value);
        stale ||= result.value.stale;
      } else errors.push(WARNING_SOURCES[index]);
    });
    if (errors.length === WARNING_SOURCES.length)
      throw new Error('upstream_unavailable');
    return { fetchedAt: now(), rows, errors, stale };
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
    if (req.method !== 'GET') return json(405, { error: 'method_not_allowed' });
    const path = (req.url || '/').split('?')[0];
    if (path !== '/' && path !== '')
      return json(404, { error: 'unknown_route' });
    if (!allow(clientKey(req))) return json(429, { error: 'rate_limited' });
    try {
      json(200, await snapshot());
    } catch {
      json(502, { error: 'weather_warnings_unavailable' });
    }
  }

  return {
    name: 'weather-warnings',
    configureServer({ middlewares }) {
      middlewares.use('/api/weather-warnings', handler);
    },
    configurePreviewServer({ middlewares }) {
      middlewares.use('/api/weather-warnings', handler);
    },
  };
}
