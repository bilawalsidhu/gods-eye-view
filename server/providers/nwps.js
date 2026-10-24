/**
 * NOAA National Water Prediction Service (NWPS) river gauges, nationwide.
 *
 * NWPS publishes the official NWS flood category, flood stages, crests and
 * river forecasts for about 13,000 gauges. Its gauge list answers a bounding
 * box; a CONUS-wide box takes about a minute and no box at all runs into the
 * gateway's 60 s timeout (504), and the list allows 10 requests per 5 minutes
 * per client. The server therefore builds one national snapshot from seven
 * fixed regional boxes, each well under the timeout, one at a time, and keeps
 * its own count of list requests below NWPS's limit; after a 429 it asks
 * nothing until NWPS's window has passed.
 *
 * The snapshot is rebuilt on demand at most every 15 minutes (single flight).
 * While a rebuild runs the previous snapshot keeps being served; a region that
 * fails keeps its previous gauges and marks the snapshot stale. With no
 * snapshot yet and NWPS unreachable the route answers 503 with Retry-After.
 * After a failed rebuild nothing is retried for 5 minutes.
 *
 * Routes (GET or HEAD only; the browser never names an upstream URL):
 *   /api/nwps/gauges        the trimmed national snapshot, gzip when accepted
 *   /api/nwps/gauge/<lid>   trimmed detail for one gauge: flood stages, top
 *                           crests, USGS id, service state; cached 15 minutes
 *
 * NWS data are U.S. federal government works in the public domain
 * (https://www.weather.gov/disclaimer).
 */
import { gzipSync } from 'node:zlib';
import { readResponseJsonCapped, coalesceProxyRequest } from './common/http.js';
import { makeRateLimiter, clientKey } from './common/rate-limit.js';

export const NWPS_API = 'https://api.water.noaa.gov/nwps/v1';
export const NWPS_REFRESH_MS = 15 * 60_000;
export const NWPS_RETRY_AFTER_FAILURE_MS = 5 * 60_000;
export const NWPS_DETAIL_TTL_MS = 15 * 60_000;
/** Regional reads in flight at once: two parallel reads both timed out. */
export const NWPS_CONCURRENCY = 1;
/**
 * Gauge-list requests allowed per rolling window, below NWPS's published
 * 10 per 5 minutes. One snapshot spends seven.
 */
export const NWPS_LIST_BUDGET = 8;
export const NWPS_LIST_WINDOW_MS = 5 * 60_000;
/** The gateway answers 504 after 60 s; a CONUS column takes about 25 s. */
const REGION_TIMEOUT_MS = 65_000;
const DETAIL_TIMEOUT_MS = 15_000;
/** A CONUS column is ~2.7 MB; anything past this is not a gauge list. */
const REGION_MAX_BYTES = 16 * 1024 * 1024;
const DETAIL_MAX_BYTES = 1024 * 1024;
const DETAIL_CACHE_MAX = 512;
const USER_AGENT = 'gods-eye-view-nwps-proxy/1.0';

/** NWS location ids: four letters and a digit, e.g. `AAIT2`. */
export const NWPS_LID = /^[A-Z]{4}[0-9]$/;
const USGS_ID = /^[0-9]{8,15}$/;

/**
 * Split `bounds` into columns at the given interior longitudes. Neighbouring
 * columns share an edge value exactly, so together they cover the bounds with
 * no gap and no overlap.
 * @param {string} prefix Region id prefix.
 * @param {{west:number, south:number, east:number, north:number}} bounds
 * @param {number[]} edges Interior column edges, west to east.
 * @returns {Array<{id:string, west:number, south:number, east:number, north:number}>}
 */
export function splitNwpsBounds(prefix, bounds, edges) {
  const cuts = [bounds.west, ...edges, bounds.east];
  for (let i = 1; i < cuts.length; i++)
    if (!(cuts[i] > cuts[i - 1])) throw new RangeError('edges must ascend');
  return cuts.slice(1).map((east, i) => ({
    id: `${prefix}-${i + 1}`,
    west: cuts[i],
    south: bounds.south,
    east,
    north: bounds.north,
  }));
}

/**
 * The regional boxes one snapshot reads: seven requests. NWPS limits its gauge
 * list to 10 requests per 5 minutes per client (the published 429 message),
 * and a request that runs past 60 s ends in a gateway 504. One request costs
 * about 10 ms per gauge (2,700 gauges took 26 s), and two at once both ran
 * past 60 s, so reads are sequential and boxes stay near 2,500 gauges: CONUS
 * (gauges span 24.5–49.6°N, 124.5–67.0°W) is split at 107°, 94°, 86° and
 * 80°W into five columns of 2,300–2,700 gauges; Alaska is one box; one strip
 * at 17–23°N holds Hawaii, Puerto Rico and the U.S. Virgin Islands. NWPS lists
 * no gauges for Guam, the Northern Marianas or American Samoa.
 */
export const NWPS_REGIONS = Object.freeze(
  [
    ...splitNwpsBounds(
      'conus',
      { west: -126, south: 24, east: -66, north: 50 },
      [-107, -94, -86, -80],
    ),
    { id: 'alaska', west: -180, south: 50, east: -128, north: 72 },
    { id: 'hawaii-caribbean', west: -161, south: 17, east: -64, north: 23 },
  ].map((region) => Object.freeze(region)),
);

/** Flood categories NWPS reports, in the order the layer ranks them. */
export const NWPS_CATEGORIES = Object.freeze([
  'major',
  'moderate',
  'minor',
  'action',
  'low_threshold',
  'no_flooding',
  'not_defined',
  'obs_not_current',
  'fcst_not_current',
  'out_of_service',
]);
const CATEGORY_SET = new Set(NWPS_CATEGORIES);

/** A category as reported, or `not_defined` for anything unrecognised. */
export function nwpsCategory(value) {
  const text = String(value ?? '')
    .trim()
    .toLowerCase();
  return CATEGORY_SET.has(text) ? text : 'not_defined';
}

/** NWPS marks a missing number with -999 (status) or -9999 (flood stages). */
export function nwpsNumber(value) {
  if (value === null || value === undefined || value === '') return null;
  const n = Number(value);
  return Number.isFinite(n) && n > -999 ? n : null;
}

/** An ISO time, or null for NWPS's `0001-01-01T00:00:00Z` "no time". */
export function nwpsTime(value) {
  const ms = Date.parse(String(value ?? ''));
  if (!Number.isFinite(ms) || ms < Date.UTC(1900, 0, 1)) return null;
  return new Date(ms).toISOString();
}

const STAGE_UNITS = new Set(['ft', 'm']);
const FLOW_UNITS = new Set(['cfs', 'kcfs', 'cms', 'kcms']);
const unitOf = (value) =>
  String(value ?? '')
    .trim()
    .toLowerCase();

/**
 * One observed or forecast status: stage and flow by their units (most
 * gauges report stage first, about 1% report flow first), category, time.
 * @returns {{stage:number|null, stageUnit:string|null, flow:number|null,
 *   flowUnit:string|null, category:string, time:string|null}}
 */
export function normalizeNwpsStatus(raw = {}) {
  const reading = {
    stage: null,
    stageUnit: null,
    flow: null,
    flowUnit: null,
    category: nwpsCategory(raw?.floodCategory),
    time: nwpsTime(raw?.validTime),
  };
  for (const [valueKey, unitKey] of [
    ['primary', 'primaryUnit'],
    ['secondary', 'secondaryUnit'],
  ]) {
    const value = nwpsNumber(raw?.[valueKey]);
    const unit = unitOf(raw?.[unitKey]);
    if (value === null) continue;
    if (STAGE_UNITS.has(unit) && reading.stage === null) {
      reading.stage = value;
      reading.stageUnit = unit;
    } else if (FLOW_UNITS.has(unit) && reading.flow === null) {
      reading.flow = value;
      reading.flowUnit = unit;
    }
  }
  return reading;
}

const text = (value, max) => {
  const s = typeof value === 'string' ? value.trim() : '';
  return s ? s.slice(0, max) : null;
};

/**
 * Trim one gauge of the NWPS list to what the layer draws, or null when it
 * has no valid id or position. The forecast is null when NWPS has none (no
 * value and no time).
 */
export function normalizeNwpsGauge(raw) {
  const lid = String(raw?.lid ?? '')
    .trim()
    .toUpperCase();
  if (!NWPS_LID.test(lid)) return null;
  const lat = Number(raw?.latitude);
  const lon = Number(raw?.longitude);
  if (
    !Number.isFinite(lat) ||
    !Number.isFinite(lon) ||
    Math.abs(lat) > 90 ||
    Math.abs(lon) > 180
  )
    return null;
  const observed = normalizeNwpsStatus(raw?.status?.observed);
  const forecast = normalizeNwpsStatus(raw?.status?.forecast);
  const hasForecast =
    forecast.time !== null || forecast.stage !== null || forecast.flow !== null;
  return {
    lid,
    name: text(raw?.name, 160) || lid,
    lat: Math.round(lat * 1e5) / 1e5,
    lon: Math.round(lon * 1e5) / 1e5,
    state: text(raw?.state?.abbreviation, 4),
    wfo: text(raw?.wfo?.abbreviation, 4),
    observed,
    forecast: hasForecast ? forecast : null,
  };
}

/** Gauges per observed category, every category present (zeros included). */
export function countNwpsCategories(gauges) {
  const counts = Object.fromEntries(NWPS_CATEGORIES.map((c) => [c, 0]));
  for (const gauge of gauges) counts[gauge.observed.category]++;
  return counts;
}

const STAGE_CATEGORIES = ['action', 'minor', 'moderate', 'major'];

function trimCrest(raw) {
  const time = nwpsTime(raw?.occurredTime);
  const stage = nwpsNumber(raw?.stage);
  const flow = nwpsNumber(raw?.flow);
  return time && (stage !== null || flow !== null)
    ? { time, stage, flow }
    : null;
}

/**
 * Trim one NWPS gauge record to the card's detail: flood stages (null where
 * NWPS has none), the three highest historic crests, the three most recent
 * crests, the USGS site id, the service state and the forecast note.
 */
export function normalizeNwpsDetail(raw) {
  const lid = String(raw?.lid ?? '')
    .trim()
    .toUpperCase();
  if (!NWPS_LID.test(lid)) return null;
  const flood = raw?.flood || {};
  const thresholds = {};
  for (const category of STAGE_CATEGORIES)
    thresholds[category] = {
      stage: nwpsNumber(flood.categories?.[category]?.stage),
      flow: nwpsNumber(flood.categories?.[category]?.flow),
    };
  const crests = (list) =>
    (Array.isArray(list) ? list : []).map(trimCrest).filter(Boolean);
  const usgsId = String(raw?.usgsId ?? '').trim();
  const attribution = (
    Array.isArray(raw?.dataAttribution) ? raw.dataAttribution : []
  )
    .map((entry) => text(entry?.title, 120))
    .filter(Boolean);
  return {
    lid,
    name: text(raw?.name, 160) || lid,
    usgsId: USGS_ID.test(usgsId) ? usgsId : null,
    inService:
      typeof raw?.inService?.enabled === 'boolean'
        ? raw.inService.enabled
        : null,
    serviceNote: text(raw?.inService?.message, 300),
    forecastReliability: text(raw?.forecastReliability, 400),
    stageUnit: STAGE_UNITS.has(unitOf(flood.stageUnits))
      ? unitOf(flood.stageUnits)
      : null,
    flowUnit: FLOW_UNITS.has(unitOf(flood.flowUnits))
      ? unitOf(flood.flowUnits)
      : null,
    thresholds,
    crests: {
      historic: crests(flood.crests?.historic)
        .sort((a, b) => (b.stage ?? -Infinity) - (a.stage ?? -Infinity))
        .slice(0, 3),
      recent: crests(flood.crests?.recent)
        .sort((a, b) => b.time.localeCompare(a.time))
        .slice(0, 3),
    },
    attribution: [...new Set(attribution)].slice(0, 4),
  };
}

/** The NWPS list URL for one region. */
export function nwpsRegionUrl(region) {
  const q = new URLSearchParams({
    'bbox.xmin': String(region.west),
    'bbox.ymin': String(region.south),
    'bbox.xmax': String(region.east),
    'bbox.ymax': String(region.north),
    srid: 'EPSG_4326',
  });
  return `${NWPS_API}/gauges?${q}`;
}

/** Run `task` over `items` with at most `limit` in flight; never rejects. */
async function settleLimited(items, limit, task) {
  const results = new Array(items.length);
  let next = 0;
  async function worker() {
    while (next < items.length) {
      const index = next++;
      try {
        results[index] = { ok: true, value: await task(items[index]) };
      } catch (error) {
        results[index] = { ok: false, error };
      }
    }
  }
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, worker),
  );
  return results;
}

/**
 * The NWPS store: regional reads, the national snapshot and the detail
 * cache. All I/O is injectable.
 */
export function createNwpsStore({
  fetchImpl = (...args) => globalThis.fetch(...args),
  now = () => Date.now(),
  regions = NWPS_REGIONS,
  concurrency = NWPS_CONCURRENCY,
  log = console,
} = {}) {
  /** Last good gauges per region id. */
  const regionGauges = new Map();
  let built = null;
  let inflight = null;
  let lastFailureAt = -Infinity;
  /** Times of recent gauge-list requests, and NWPS's own 429 hold. */
  const listRequests = [];
  let rateLimitedUntil = -Infinity;
  const details = new Map();
  const detailFlights = new Map();

  async function getJson(url, maxBytes, timeoutMs) {
    const signal = AbortSignal.timeout(timeoutMs);
    const response = await fetchImpl(url, {
      headers: { Accept: 'application/json', 'User-Agent': USER_AGENT },
      redirect: 'error',
      signal,
    });
    if (!response.ok) {
      await response.body?.cancel?.().catch?.(() => {});
      const retryAfter = Number(response.headers?.get?.('retry-after'));
      throw Object.assign(new Error(`NWPS HTTP ${response.status}`), {
        status: response.status,
        retryAfterMs:
          Number.isFinite(retryAfter) && retryAfter > 0
            ? retryAfter * 1000
            : null,
      });
    }
    return readResponseJsonCapped(response, maxBytes, signal);
  }

  /** Spend one gauge-list request, or refuse without calling NWPS. */
  function admitListRequest() {
    const t = now();
    while (listRequests.length && t - listRequests[0] >= NWPS_LIST_WINDOW_MS)
      listRequests.shift();
    if (t < rateLimitedUntil || listRequests.length >= NWPS_LIST_BUDGET)
      throw Object.assign(new Error('NWPS rate limited'), { skipped: true });
    listRequests.push(t);
  }

  async function readRegion(region) {
    admitListRequest();
    let body;
    try {
      body = await getJson(
        nwpsRegionUrl(region),
        REGION_MAX_BYTES,
        REGION_TIMEOUT_MS,
      );
    } catch (error) {
      // NWPS's limit is per client: stop asking until its window has passed.
      if (error?.status === 429)
        rateLimitedUntil =
          now() + Math.max(error.retryAfterMs || 0, NWPS_LIST_WINDOW_MS);
      throw error;
    }
    if (!Array.isArray(body?.gauges))
      throw new Error('Malformed NWPS response');
    return body.gauges.map(normalizeNwpsGauge).filter(Boolean);
  }

  function publish({ failed, startedAt }) {
    // A gauge on a shared edge can come back from both boxes; keep one.
    const byLid = new Map();
    for (const region of regions)
      for (const gauge of regionGauges.get(region.id) || [])
        if (!byLid.has(gauge.lid)) byLid.set(gauge.lid, gauge);
    const gauges = [...byLid.values()].sort((a, b) =>
      a.lid.localeCompare(b.lid),
    );
    const snapshot = {
      source: 'NOAA NWS National Water Prediction Service',
      generatedAt: new Date(now()).toISOString(),
      stale: failed.length > 0,
      regions: { total: regions.length, failed },
      buildMs: now() - startedAt,
      counts: countNwpsCategories(gauges),
      gauges,
    };
    const json = JSON.stringify(snapshot);
    return {
      snapshot,
      json,
      gzip: gzipSync(json),
      at: now(),
    };
  }

  async function refresh() {
    const startedAt = now();
    const results = await settleLimited(regions, concurrency, readRegion);
    const failed = [];
    results.forEach((result, index) => {
      const region = regions[index];
      if (result.ok) regionGauges.set(region.id, result.value);
      else {
        failed.push(region.id);
        log.warn?.(
          `[NWPS] region ${region.id} failed:`,
          result.error?.message || result.error,
        );
      }
    });
    if (failed.length === regions.length && !built)
      throw new Error('nwps_unavailable');
    built = publish({ failed, startedAt });
    if (failed.length) lastFailureAt = now();
    return built;
  }

  /**
   * The current snapshot. When it is 15 minutes old a rebuild starts and the
   * current one is served meanwhile; only the very first build is awaited.
   * @returns {Promise<object|null>} Built snapshot, or null with none yet.
   */
  async function current() {
    const t = now();
    const due = !built || t - built.at >= NWPS_REFRESH_MS;
    const cooling = t - lastFailureAt < NWPS_RETRY_AFTER_FAILURE_MS;
    if (due && !inflight && !cooling) {
      inflight = refresh()
        .catch((error) => {
          lastFailureAt = now();
          log.warn?.('[NWPS] snapshot failed:', error?.message || error);
          return built;
        })
        .finally(() => {
          inflight = null;
        });
    }
    if (built) return built;
    return inflight ? await inflight : null;
  }

  /**
   * Trimmed detail for one validated id, cached; a failed read serves the
   * previous answer when there is one.
   * @param {string} lid Upper-case NWS location id.
   */
  async function detail(lid) {
    if (!NWPS_LID.test(lid)) throw new TypeError('invalid_lid');
    const cached = details.get(lid);
    if (cached && now() - cached.at < NWPS_DETAIL_TTL_MS)
      return { value: cached.value, stale: false };
    if (!detailFlights.has(lid) && detailFlights.size >= 32)
      throw Object.assign(new Error('busy'), { status: 429 });
    try {
      const { promise } = coalesceProxyRequest(detailFlights, lid, async () => {
        const raw = await getJson(
          `${NWPS_API}/gauges/${lid}`,
          DETAIL_MAX_BYTES,
          DETAIL_TIMEOUT_MS,
        );
        const value = normalizeNwpsDetail(raw);
        if (!value || value.lid !== lid)
          throw new Error('Malformed NWPS response');
        details.delete(lid);
        details.set(lid, { value, at: now() });
        if (details.size > DETAIL_CACHE_MAX)
          details.delete(details.keys().next().value);
        return value;
      });
      return { value: await promise, stale: false };
    } catch (error) {
      if (cached) return { value: cached.value, stale: true };
      throw error;
    }
  }

  return { current, refresh, detail };
}

/**
 * Vite plugin for dev and preview: GET /api/nwps/gauges and
 * /api/nwps/gauge/<lid>.
 */
export function nwpsProxy(options = {}) {
  const store = options.store || createNwpsStore(options);
  const allow = makeRateLimiter({
    windowMs: 60_000,
    max: 120,
    globalMax: 2400,
  });

  async function handler(req, res) {
    const send = (status, body, extra = {}) => {
      if (res.destroyed) return;
      res.writeHead(status, {
        'Content-Type': 'application/json',
        'Cache-Control': 'no-store',
        ...extra,
      });
      res.end(req.method === 'HEAD' ? undefined : body);
    };
    const json = (status, value, extra) =>
      send(status, JSON.stringify(value), extra);
    if (req.method !== 'GET' && req.method !== 'HEAD')
      return json(405, { error: 'method_not_allowed' }, { Allow: 'GET, HEAD' });
    const path = String(req.url || '/').split('?')[0];
    const gaugeRoute = /^\/gauge\/([^/]*)$/.exec(path);
    if (path !== '/gauges' && !gaugeRoute)
      return json(404, { error: 'not_found' });
    let lid = null;
    if (gaugeRoute) {
      // Validated before any upstream call: the id is the only client input.
      lid = gaugeRoute[1].toUpperCase();
      if (!NWPS_LID.test(lid)) return json(400, { error: 'invalid_lid' });
    }
    if (!allow(clientKey(req)))
      return json(429, { error: 'rate_limited' }, { 'Retry-After': '60' });

    if (lid) {
      try {
        const { value, stale } = await store.detail(lid);
        return json(
          200,
          { ...value, stale },
          stale ? { 'X-Data-Stale': 'true' } : {},
        );
      } catch (error) {
        return error?.status === 429
          ? json(429, { error: 'busy' }, { 'Retry-After': '10' })
          : json(502, { error: 'nwps_unavailable' });
      }
    }

    let built = null;
    try {
      built = await store.current();
    } catch {
      built = null;
    }
    if (!built)
      return json(503, { error: 'nwps_unavailable' }, { 'Retry-After': '120' });
    const headers = {
      Vary: 'Accept-Encoding',
      'X-Snapshot-Generated-At': built.snapshot.generatedAt,
      ...(built.snapshot.stale ? { 'X-Data-Stale': 'true' } : {}),
    };
    if (/\bgzip\b/.test(String(req.headers?.['accept-encoding'] || '')))
      return send(200, built.gzip, {
        ...headers,
        'Content-Encoding': 'gzip',
        'Content-Length': String(built.gzip.length),
      });
    send(200, built.json, headers);
  }

  return {
    name: 'nwps',
    configureServer({ middlewares }) {
      middlewares.use('/api/nwps', handler);
    },
    configurePreviewServer({ middlewares }) {
      middlewares.use('/api/nwps', handler);
    },
    store,
  };
}
