import {
  SA_ROAD_SOURCE_GROUPS,
  normalizeSaRoadEventLines,
  normalizeSaRoadEventPoints,
} from '../../src/layers/saRoadEvents/records.js';
import { readResponseJsonCapped, coalesceProxyRequest } from './common/http.js';
import { makeRateLimiter, clientKey } from './common/rate-limit.js';

// Traffic SA open data (Department for Infrastructure and Transport,
// Government of South Australia): keyless ArcGIS MapServers. The data is split
// across two services, read as three independent groups:
//
//   roadworks  maps.sa.gov.au TrafficSAOpenData layer 0 (the identical
//              TrafficSAOpenData2 mirror is used only if it fails). Only its
//              ROADWORKS kinds are kept: its INCIDENT rows are stale.
//   incidents  geohub TrafficSATime_OpenData layer 0.
//   closures   geohub TrafficSATime_OpenData layer 2 (closures and detours).
//
// The old closures layer (TrafficSAOpenData layer 1, and its mirror) stopped
// updating in May 2026 and is deliberately never read: stale closures would
// look like live ones. If the geohub host is unreachable the incidents and
// closures groups report `unavailable`; nothing falls back to the old layers.
const MAPS_ROOT =
  'https://maps.sa.gov.au/arcgis/rest/services/DPTIExtTransport';
const GEOHUB_SERVICE =
  'https://dit-cms-prod.geohub.sa.gov.au/arcgis/rest/services/TrafficSATime_OpenData/TrafficSATime_OpenData/MapServer';
const USER_AGENT =
  'gods-eye-view-sa-road-events-proxy/1.0 (+https://github.com/bilawalsidhu/gods-eye-view)';

// Paging needs a stable order field, and each layer names its own: the
// roadworks layer has ESRI_OID, the geohub incidents layer has no ESRI_OID
// (its object id is incident_id), the geohub closures layer has ESRI_OID.
// ArcGIS answers an unknown order field with HTTP 200 and an error object,
// which the page check below treats as a failed group.
const ROADWORKS_LAYER = Object.freeze({ index: 0, orderBy: 'ESRI_OID' });
const INCIDENTS_LAYER = Object.freeze({ index: 0, orderBy: 'incident_id' });
const CLOSURES_LAYER = Object.freeze({ index: 2, orderBy: 'ESRI_OID' });

/** Fixed upstream services per group; exported for tests and docs. */
export const SA_ROAD_EVENTS_UPSTREAMS = Object.freeze({
  roadworks: Object.freeze({
    layer: ROADWORKS_LAYER,
    services: Object.freeze([
      Object.freeze({
        base: `${MAPS_ROOT}/TrafficSAOpenData/MapServer`,
        mirror: false,
      }),
      Object.freeze({
        base: `${MAPS_ROOT}/TrafficSAOpenData2/MapServer`,
        mirror: true,
      }),
    ]),
  }),
  incidents: Object.freeze({
    layer: INCIDENTS_LAYER,
    services: Object.freeze([
      Object.freeze({ base: GEOHUB_SERVICE, mirror: false }),
    ]),
  }),
  closures: Object.freeze({
    layer: CLOSURES_LAYER,
    services: Object.freeze([
      Object.freeze({ base: GEOHUB_SERVICE, mirror: false }),
    ]),
  }),
});

const NORMALIZERS = Object.freeze({
  roadworks: (collection) =>
    normalizeSaRoadEventPoints(collection, { source: 'roadworks' }),
  incidents: (collection) =>
    normalizeSaRoadEventPoints(collection, { source: 'incidents' }),
  closures: normalizeSaRoadEventLines,
});

const PAGE_SIZE = 1000;
// ~1,400 roadworks today (two pages); ten pages is 7x headroom, and a feed that
// still claims more is treated as broken rather than silently truncated.
const MAX_PAGES = 10;
const MIB = 1024 * 1024;

/** Cache, backoff and bounds; exported for tests and docs. */
export const SA_ROAD_EVENTS_POLICY = Object.freeze({
  freshMs: 120_000,
  retryAfterFailureMs: 60_000,
  maxRetryAfterMs: 900_000,
  // Closures and incidents change within hours; past six hours a "last good"
  // snapshot is more likely to show reopened roads than useful context.
  staleLimitMs: 6 * 3_600_000,
  // One budget for every page of one attempt (primary or mirror).
  timeoutMs: 40_000,
  maxPageBytes: 6 * MIB,
});

const exceededTransferLimit = (payload) =>
  payload?.exceededTransferLimit === true ||
  payload?.properties?.exceededTransferLimit === true;

function pageUrl(base, { index, orderBy }, offset) {
  const url = new URL(`${base}/${index}/query`);
  url.search = new URLSearchParams({
    where: '1=1',
    outFields: '*',
    outSR: '4326',
    f: 'geojson',
    orderByFields: orderBy,
    resultOffset: String(offset),
    resultRecordCount: String(PAGE_SIZE),
  }).toString();
  return url.href;
}

/** Seconds from a Retry-After header, as bounded milliseconds (or null). */
function retryAfterMs(response, policy) {
  const seconds = Number(response.headers?.get?.('retry-after'));
  if (!Number.isFinite(seconds) || seconds < 0) return null;
  return Math.min(
    Math.max(seconds * 1000, policy.retryAfterFailureMs),
    policy.maxRetryAfterMs,
  );
}

/** Fixed-origin, cached Traffic SA road-events route for dev and preview. */
export function saRoadEventsProxy({
  fetchImpl = (...args) => globalThis.fetch(...args),
  now = () => Date.now(),
  policy = SA_ROAD_EVENTS_POLICY,
} = {}) {
  // Each group has its own last-good cache, backoff and in-flight request, so
  // one upstream failing never blanks or delays the others.
  const groups = Object.fromEntries(
    SA_ROAD_SOURCE_GROUPS.map((name) => [
      name,
      { name, cache: null, retryAt: -Infinity, inFlight: new Map() },
    ]),
  );
  const allow = makeRateLimiter({ windowMs: 60_000, max: 30, globalMax: 600 });

  /** Every page of one layer, or a throw: a partial layer is never returned. */
  async function fetchLayer(base, layer, signal) {
    const features = [];
    for (let page = 0; page < MAX_PAGES; page++) {
      const response = await fetchImpl(pageUrl(base, layer, features.length), {
        signal,
        redirect: 'error',
        headers: {
          Accept: 'application/geo+json,application/json',
          'User-Agent': USER_AGENT,
        },
      });
      if (!response.ok) {
        await response.body?.cancel();
        throw Object.assign(new Error('sa_upstream_unavailable'), {
          status: response.status,
          ...(response.status === 429
            ? { retryAfterMs: retryAfterMs(response, policy) }
            : {}),
        });
      }
      if (!/json/i.test(response.headers.get('content-type') || '')) {
        await response.body?.cancel();
        throw new Error('sa_upstream_not_json');
      }
      const payload = await readResponseJsonCapped(
        response,
        policy.maxPageBytes,
        signal,
      );
      if (
        payload?.type !== 'FeatureCollection' ||
        !Array.isArray(payload.features)
      )
        throw new Error('sa_invalid_page');
      features.push(...payload.features);
      if (!exceededTransferLimit(payload))
        return { type: 'FeatureCollection', features };
      if (!payload.features.length) throw new Error('sa_empty_truncated_page');
    }
    throw new Error('sa_too_many_pages');
  }

  /** One group from one service: all its pages, normalized, or a throw. */
  async function fetchFrom(name, { base, mirror }) {
    const signal = AbortSignal.timeout(policy.timeoutMs);
    const collection = await fetchLayer(
      base,
      SA_ROAD_EVENTS_UPSTREAMS[name].layer,
      signal,
    );
    const normalized = NORMALIZERS[name](collection);
    if (!normalized) throw new Error('sa_invalid_snapshot');
    return { fetchedAt: now(), records: normalized.records, mirror };
  }

  /** The group's services in order; the next only after a non-429 failure. */
  async function fetchGroup(name) {
    const { services } = SA_ROAD_EVENTS_UPSTREAMS[name];
    let failure;
    for (const service of services) {
      try {
        return await fetchFrom(name, service);
      } catch (error) {
        // A rate limit applies to this client, not the host: do not shop around.
        if (error.status === 429) throw error;
        failure = error;
      }
    }
    throw failure;
  }

  /** Fresh cache, else one shared upstream read; failures back off. */
  async function acquire(group) {
    if (group.cache && now() - group.cache.fetchedAt < policy.freshMs)
      return { value: group.cache, stale: false };
    if (!group.inFlight.size && now() < group.retryAt) {
      if (group.cache) return { value: group.cache, stale: true };
      throw new Error('sa_retry_later');
    }
    try {
      const { promise } = coalesceProxyRequest(
        group.inFlight,
        'snapshot',
        async () => {
          try {
            group.cache = await fetchGroup(group.name);
            group.retryAt = -Infinity;
            return group.cache;
          } catch (error) {
            group.retryAt =
              now() + (error.retryAfterMs ?? policy.retryAfterFailureMs);
            throw error;
          }
        },
      );
      return { value: await promise, stale: false };
    } catch (error) {
      if (group.cache) return { value: group.cache, stale: true };
      throw error;
    }
  }

  /**
   * One group's contribution to the response: live, stale (last good, still
   * inside the stale limit), or null when there is nothing trustworthy.
   */
  async function readGroup(group) {
    try {
      const { value, stale } = await acquire(group);
      if (stale && now() - value.fetchedAt > policy.staleLimitMs) return null;
      return { value, status: stale ? 'stale' : 'live' };
    } catch {
      return null;
    }
  }

  async function snapshot() {
    const read = await Promise.all(
      SA_ROAD_SOURCE_GROUPS.map((name) => readGroup(groups[name])),
    );
    const results = Object.fromEntries(
      SA_ROAD_SOURCE_GROUPS.map((name, i) => [name, read[i]]),
    );
    const available = read.filter(Boolean);
    if (!available.length) return null;
    const sources = Object.fromEntries(
      SA_ROAD_SOURCE_GROUPS.map((name) => {
        const result = results[name];
        return [
          name,
          result
            ? {
                status: result.status,
                fetchedAt: result.value.fetchedAt,
                mirror: result.value.mirror,
              }
            : { status: 'unavailable', fetchedAt: null, mirror: false },
        ];
      }),
    );
    return {
      points: [
        ...(results.roadworks?.value.records ?? []),
        ...(results.incidents?.value.records ?? []),
      ],
      lines: results.closures?.value.records ?? [],
      fetchedAt: Math.max(...available.map(({ value }) => value.fetchedAt)),
      stale: available.some(({ status }) => status === 'stale'),
      mirror: sources.roadworks.mirror,
      sources,
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
      const body = await snapshot();
      if (!body) return json(502, { error: 'sa_road_events_unavailable' });
      json(200, body, body.stale ? { 'X-Data-Stale': 'true' } : {});
    } catch {
      json(502, { error: 'sa_road_events_unavailable' });
    }
  }

  return {
    name: 'sa-road-events',
    configureServer({ middlewares }) {
      middlewares.use('/api/sa-road-events', handler);
    },
    configurePreviewServer({ middlewares }) {
      middlewares.use('/api/sa-road-events', handler);
    },
  };
}
