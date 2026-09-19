/**
 * server/sources/nasa-firms.js — Gate 3 row 2: `fires.search`, active-fire
 * detections from NASA FIRMS (LANCE NRT) through the area CSV API.
 *
 * Upstream (documented at https://firms.modaps.eosdis.nasa.gov/api/area/):
 *   https://firms.modaps.eosdis.nasa.gov/api/area/csv/{MAP_KEY}/{SOURCE}/{AREA}/{DAY_RANGE}[/{DATE}]
 *   AREA = west,south,east,north · DAY_RANGE 1–10 · DATE = YYYY-MM-DD (start)
 *   Quota: 5,000 transactions per 10-minute interval per MAP_KEY (a multi-day
 *   request counts as several transactions) — surfaced under `data.quota`.
 *
 * Deterministic and keyed: the MAP_KEY is read ONLY from `env.NASA_FIRMS_MAP_KEY`
 * (never requested from the caller, never hard-coded, never logged, never
 * echoed — `provenance.source_url` carries `<redacted>` in its place and every
 * error message is built without it). Without the key the adapter answers a
 * structured 503 `not_configured` BEFORE any network call.
 *
 * Contract: server/sources/_shared.js (whitelisted params → 400
 * {error:{code,message,param}}, 8 s timeout + one retry on 5xx/network/
 * timeout, provenance envelope whose completeness is never 'complete').
 * CSV parsing is shared with the browser layer via src/data/firmsCsv.js
 * (portable export `./sources/firms-csv`), which is also the parity baseline.
 */

import {
  validateParams,
  fetchWithRetry,
  readText,
  provenance,
  failure,
  isoUtc,
  normalizeBbox,
} from './_shared.js';
import {
  parseFirmsCsv,
  acquisitionMsUtc,
  isLikelyCsv,
} from '../../src/data/firmsCsv.js';

export const PROVIDER = 'NASA FIRMS (LANCE near-real-time active fire)';
export const SOURCE_URL = 'https://firms.modaps.eosdis.nasa.gov/api/area/';
export const FIRMS_AREA_BASE =
  'https://firms.modaps.eosdis.nasa.gov/api/area/csv';
export const KEY_ENV = 'NASA_FIRMS_MAP_KEY';
export const SOURCES = Object.freeze([
  'VIIRS_NOAA20_NRT',
  'VIIRS_NOAA21_NRT',
  'VIIRS_SNPP_NRT',
  'MODIS_NRT',
]);
export const LIMIT_CAP = 200;
export const QUOTA = Object.freeze({
  transactions_per_10min: 5000,
  note: 'per MAP_KEY; a multi-day request counts as multiple transactions (FIRMS area API docs)',
});
export const LICENSE = Object.freeze({
  name: 'NASA Earthdata open data (FIRMS/LANCE) — free MAP_KEY required, attribution requested',
  url: 'https://firms.modaps.eosdis.nasa.gov/api/area/',
  attribution: 'NASA FIRMS / LANCE',
});

export const SPEC = Object.freeze({
  bbox: { type: 'string', maxLength: 80 },
  latitude: { type: 'number', min: -90, max: 90 },
  longitude: { type: 'number', min: -180, max: 180 },
  radius_km: { type: 'number', min: 1, max: 1000 },
  source: { type: 'enum', values: SOURCES, default: 'VIIRS_NOAA20_NRT' },
  day_range: { type: 'integer', min: 1, max: 10, default: 1 },
  date: { type: 'string', pattern: /^\d{4}-\d{2}-\d{2}$/ },
  limit: { type: 'integer', min: 1, max: LIMIT_CAP, default: 100 },
});

const KM_PER_DEG_LAT = 110.574;

/** Circle → bounding box (clamped to the valid lat/lon ranges). */
export function circleToBbox(latitude, longitude, radiusKm) {
  const dLat = radiusKm / KM_PER_DEG_LAT;
  const cos = Math.max(Math.cos((latitude * Math.PI) / 180), 1e-6);
  const dLon = radiusKm / (KM_PER_DEG_LAT * cos);
  return {
    south: Math.max(-90, latitude - dLat),
    north: Math.min(90, latitude + dLat),
    west: Math.max(-180, longitude - dLon),
    east: Math.min(180, longitude + dLon),
  };
}

/** Resolve the area: bbox XOR circle (never both, never neither). */
export function resolveArea(params) {
  const hasBbox = params.bbox !== undefined;
  const circleKeys = ['latitude', 'longitude', 'radius_km'].filter(
    (k) => params[k] !== undefined,
  );
  if (hasBbox && circleKeys.length) {
    return failure(
      400,
      'invalid_param',
      'use either bbox or a circle (latitude+longitude+radius_km), not both',
      'bbox',
    );
  }
  if (!hasBbox && circleKeys.length === 0) {
    return failure(
      400,
      'missing_param',
      'bbox (west,south,east,north) or a circle (latitude+longitude+radius_km) is required',
      'bbox',
    );
  }
  if (hasBbox) {
    const parts = String(params.bbox).split(',');
    if (parts.length !== 4) {
      return failure(
        400,
        'invalid_param',
        'bbox must be "west,south,east,north"',
        'bbox',
      );
    }
    const [west, south, east, north] = parts;
    const box = normalizeBbox({ south, west, north, east });
    if (!box) {
      return failure(
        400,
        'invalid_param',
        'bbox must be "west,south,east,north" within valid ranges',
        'bbox',
      );
    }
    return { ok: true, bbox: box, area_kind: 'bbox' };
  }
  if (circleKeys.length !== 3) {
    const missing = ['latitude', 'longitude', 'radius_km'].find(
      (k) => params[k] === undefined,
    );
    return failure(
      400,
      'missing_param',
      'a circle needs latitude, longitude and radius_km together',
      missing,
    );
  }
  return {
    ok: true,
    bbox: circleToBbox(params.latitude, params.longitude, params.radius_km),
    area_kind: 'circle',
    circle: {
      latitude: params.latitude,
      longitude: params.longitude,
      radius_km: params.radius_km,
    },
  };
}

const fmt = (n) => Number(n.toFixed(4)).toString();

/** The upstream URL with the real key — only ever used for the fetch itself. */
export function buildUrl(mapKey, source, bbox, dayRange, date) {
  const area = `${fmt(bbox.west)},${fmt(bbox.south)},${fmt(bbox.east)},${fmt(bbox.north)}`;
  const tail = date ? `/${date}` : '';
  return `${FIRMS_AREA_BASE}/${encodeURIComponent(mapKey)}/${source}/${area}/${dayRange}${tail}`;
}

/** Normalise the parsed CSV records to the row-2 item shape. */
export function normalizeDetections(records, { limit = LIMIT_CAP } = {}) {
  const items = [];
  for (const r of records) {
    if (items.length >= limit) break;
    const ms = acquisitionMsUtc(r.acqDate, r.acqTime);
    const observedAt = Number.isFinite(ms) ? new Date(ms).toISOString() : null;
    items.push({
      id: `${r.satellite || 'firms'}-${r.acqDate}T${String(r.acqTime ?? '').padStart(4, '0')}-${r.lat}-${r.lon}`,
      latitude: r.lat,
      longitude: r.lon,
      observed_at: observedAt,
      brightness_k: r.brightness,
      brightness_secondary_k: r.brightnessTi5,
      frp_mw: r.frp,
      confidence: r.confidence,
      satellite: r.satellite,
      instrument: r.instrument,
      daynight: r.daynight,
    });
  }
  return { items, truncated: records.length > items.length };
}

/**
 * fires.search adapter.
 * @param {Record<string,string>} query  raw query-string map
 * @param {{fetchImpl?: typeof fetch, signal?: AbortSignal, env?: object,
 *          now?: () => Date, timeoutMs?: number}} [ctx]
 */
export async function fetchFires(
  query,
  {
    fetchImpl = globalThis.fetch,
    signal,
    env = process.env,
    now = () => new Date(),
    timeoutMs = 8000,
  } = {},
) {
  const v = validateParams(query, SPEC);
  if (!v.ok) return v;
  const params = v.params;
  const area = resolveArea(params);
  if (!area.ok) return area;
  if (params.date && Number.isNaN(Date.parse(`${params.date}T00:00:00Z`))) {
    return failure(400, 'invalid_param', 'date must be YYYY-MM-DD', 'date');
  }

  const mapKey = String(env?.[KEY_ENV] || '').trim();
  if (!mapKey) {
    return failure(
      503,
      'not_configured',
      `${KEY_ENV} is not configured on the server; NASA FIRMS requires a free MAP_KEY`,
      KEY_ENV,
    );
  }

  const url = buildUrl(
    mapKey,
    params.source,
    area.bbox,
    params.day_range,
    params.date,
  );
  const redactedUrl = buildUrl(
    '<redacted>',
    params.source,
    area.bbox,
    params.day_range,
    params.date,
  ).replace('%3Credacted%3E', '<redacted>');

  const fetched = await fetchWithRetry(url, {
    fetchImpl,
    timeoutMs,
    retries: 1,
    signal,
    provider: 'NASA FIRMS',
  });
  if (!fetched.ok) return fetched;
  const body = await readText(fetched.response, 'NASA FIRMS');
  if (!body.ok) return body;
  const text = body.text;

  if (!isLikelyCsv(text)) {
    // FIRMS reports problems as plain text / HTML with HTTP 200.
    const lower = text.toLowerCase();
    if (lower.includes('invalid map_key') || lower.includes('invalid mapkey')) {
      return failure(
        502,
        'upstream_auth',
        'NASA FIRMS rejected the configured MAP_KEY',
      );
    }
    if (lower.includes('transaction') && lower.includes('limit')) {
      return failure(
        429,
        'rate_limited',
        'NASA FIRMS transaction quota exceeded (5,000 per 10 minutes per MAP_KEY)',
      );
    }
    return failure(
      502,
      'malformed_upstream',
      'NASA FIRMS returned a body that was not FIRMS CSV',
    );
  }
  const records = parseFirmsCsv(text) || [];
  const { items, truncated } = normalizeDetections(records, {
    limit: params.limit,
  });
  const fetchedAt = isoUtc(now());
  const latest = items.reduce(
    (acc, it) =>
      it.observed_at && it.observed_at > acc ? it.observed_at : acc,
    '',
  );
  return {
    ok: true,
    status: 200,
    data: {
      source: PROVIDER,
      sensor: params.source,
      count: items.length,
      total_in_area: records.length,
      detections: items,
      area: {
        kind: area.area_kind,
        bbox: area.bbox,
        ...(area.circle ? { circle: area.circle } : {}),
      },
      window: { day_range: params.day_range, start_date: params.date ?? null },
      quota: QUOTA,
    },
    provenance: provenance({
      provider: PROVIDER,
      source_url: redactedUrl,
      license: LICENSE,
      fetched_at: fetchedAt,
      freshness: {
        kind: 'live',
        product: 'NRT',
        window_days: params.day_range,
        latest_observed_at: latest || null,
      },
      coverage: {
        kind: area.area_kind,
        bbox: area.bbox,
        sensor: params.source,
      },
      completeness: truncated
        ? {
            status: 'bounded',
            reason: `limit ${params.limit} of ${records.length} detections in the area`,
          }
        : {
            status: 'partial',
            reason:
              'NRT detections only: cloud cover, overpass timing and sensor gaps are not filled',
          },
    }),
  };
}
