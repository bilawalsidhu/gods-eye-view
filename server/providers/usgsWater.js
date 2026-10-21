/**
 * USGS water levels, nationwide, straight from the USGS Water Data OGC API.
 *
 * Every 60 minutes (on demand, single flight) the server asks
 * `latest-continuous` for the newest reading of each parameter at every
 * active stream, lake/reservoir and spring gauge (one site type per request:
 * multi-value site_type_code queries return incomplete subsets). Readings are
 * merged into one feature per gauge and served in the same small files the
 * layer loads: a manifest, one GeoJSONL file per class, and 4-degree tiles for
 * streams (about ten thousand gauges), so the browser fetches only the tiles
 * in view.
 *
 * Site names are not part of `latest-continuous`; they are looked up from
 * `monitoring-locations` in batches by id and kept for a week on disk. Until a
 * name arrives the gauge is labelled with its id.
 *
 * Budget: without an API key USGS allows 50 requests per IP per hour; a free
 * api.data.gov key (USGS_WATER_API_KEY, sent as the X-Api-Key header, never to
 * the browser) raises it to 1000. A rolling-hour counter stays under 40 (or
 * 800) and name lookups only use what the data refresh left over.
 */
import fsp from 'node:fs/promises';
import path from 'node:path';
import { readResponseTextCapped } from './common/http.js';
import { defaultSourceRoot } from './common/source-root.js';

export const USGS_WATER_API = 'https://api.waterdata.usgs.gov/ogcapi/v1';
export const USGS_WATER_REFRESH_MS = 60 * 60_000;
export const USGS_WATER_TILE_DEG = 4;
/** Readings older than this are dropped (the gauge is not reporting). */
export const USGS_WATER_LOOKBACK_MS = 7 * 24 * 60 * 60_000;
export const USGS_NAME_TTL_MS = 7 * 24 * 60 * 60_000;
export const USGS_NAME_BATCH = 150;
const PAGE_LIMIT = 50_000;
const MAX_PAGES = 6;
const PAGE_MAX_BYTES = 48 * 1024 * 1024;
const NAMES_MAX_BYTES = 8 * 1024 * 1024;
const FETCH_TIMEOUT_MS = 90_000;
const RETRY_AFTER_FAILURE_MS = 5 * 60_000;
const HOUR_MS = 60 * 60_000;
const KEYLESS_HOURLY_CAP = 40;
const KEYED_HOURLY_CAP = 800;

/** Output class -> USGS site type and the parameters asked for, card order first. */
export const USGS_WATER_CLASSES = Object.freeze({
  stream: Object.freeze({ site: 'ST', params: ['00065', '00060'] }),
  lake: Object.freeze({
    site: 'LK',
    params: ['00065', '00062', '62614', '62615'],
  }),
  spring: Object.freeze({ site: 'SP', params: ['00065', '00060'] }),
});

// Data, not UI copy: the layer translates these when it shows them.
export const USGS_PARAM_NAMES = Object.freeze({
  '00065': 'Gage height',
  '00060': 'Discharge',
  '00062': 'Lake/reservoir stage',
  62614: 'Lake elevation above NGVD29',
  62615: 'Lake elevation above NAVD88',
});
const PARAM_ORDER = ['00065', '00062', '62614', '62615', '00060'];
const SITE_TYPE_NAMES = Object.freeze({
  ST: 'Stream',
  LK: 'Lake/Reservoir',
  SP: 'Spring',
});

const SITE_ID = /^[A-Z]{2,8}-[0-9A-Za-z-]{1,24}$/;
const TILE_KEY = /^(\d{1,3})_(\d{1,3})$/;

export function usgsWaterApiKey(env = process.env) {
  return String(env.USGS_WATER_API_KEY || '').trim();
}

function finitePoint(geometry) {
  const c = geometry?.type === 'Point' ? geometry.coordinates : null;
  if (!Array.isArray(c) || c.length < 2) return null;
  const [lon, lat] = c.map(Number);
  if (!Number.isFinite(lon) || !Number.isFinite(lat)) return null;
  if (Math.abs(lon) > 180 || Math.abs(lat) > 90) return null;
  return [lon, lat];
}

function readingValue(value) {
  if (value === null || value === undefined || value === '') return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

/** 4-degree tile key for a point, as `<x>_<y>` from the south-west corner. */
export function usgsTileKey(lon, lat) {
  const x = Math.floor((lon + 180) / USGS_WATER_TILE_DEG);
  const y = Math.floor((lat + 90) / USGS_WATER_TILE_DEG);
  return `${x}_${y}`;
}

export function usgsTileBounds(key) {
  const m = TILE_KEY.exec(key);
  if (!m) return null;
  const west = Number(m[1]) * USGS_WATER_TILE_DEG - 180;
  const south = Number(m[2]) * USGS_WATER_TILE_DEG - 90;
  return [west, south, west + USGS_WATER_TILE_DEG, south + USGS_WATER_TILE_DEG];
}

/**
 * Merge `latest-continuous` features (any parameters) into one feature per
 * gauge. Pure.
 * @param {Array<object>} items OGC features
 * @param {string} siteType ST | LK | SP
 * @param {Map<string,{name:string}>} [names]
 */
export function mergeUsgsReadings(items, siteType, names = new Map()) {
  const sites = new Map();
  for (const item of items || []) {
    const p = item?.properties || {};
    const id = String(p.monitoring_location_id || '');
    if (!SITE_ID.test(id)) continue;
    const coords = finitePoint(item.geometry);
    const code = String(p.parameter_code || '');
    const value = readingValue(p.value);
    if (!coords || value === null || !USGS_PARAM_NAMES[code]) continue;
    const site = sites.get(id) || { coords, readings: new Map() };
    const reading = {
      parameter_code: code,
      parameter_name: USGS_PARAM_NAMES[code],
      value,
      unit: String(p.unit_of_measure || '').slice(0, 24),
      observed_time: String(p.time || ''),
    };
    const prev = site.readings.get(code);
    if (!prev || reading.observed_time > prev.observed_time)
      site.readings.set(code, reading);
    sites.set(id, site);
  }
  const rank = (code) => {
    const i = PARAM_ORDER.indexOf(code);
    return i < 0 ? PARAM_ORDER.length : i;
  };
  const features = [];
  for (const [id, site] of sites) {
    const readings = [...site.readings.values()].sort(
      (a, b) => rank(a.parameter_code) - rank(b.parameter_code),
    );
    const primary = readings[0];
    features.push({
      type: 'Feature',
      geometry: { type: 'Point', coordinates: site.coords },
      properties: {
        name: names.get(id)?.name || id,
        usgs_site_id: id,
        site_type_code: siteType,
        site_type: SITE_TYPE_NAMES[siteType] || siteType,
        observed_time: readings.reduce(
          (t, r) => (r.observed_time > t ? r.observed_time : t),
          '',
        ),
        parameter_code: primary.parameter_code,
        parameter_name: primary.parameter_name,
        value: primary.value,
        unit: primary.unit,
        readings,
      },
    });
  }
  features.sort((a, b) =>
    a.properties.usgs_site_id.localeCompare(b.properties.usgs_site_id),
  );
  return features;
}

const jsonl = (features) =>
  features.map((f) => JSON.stringify(f)).join('\n') +
  (features.length ? '\n' : '');

/**
 * Build the served files from merged features. Pure.
 * @returns {{manifest: object, files: Map<string,string>}}
 */
export function buildUsgsWaterFiles(
  byClass,
  { generatedAt, stale = false } = {},
) {
  const files = new Map();
  const classes = {};
  for (const [cls, features] of Object.entries(byClass)) {
    const file = `${cls}.geojsonl`;
    files.set(file, jsonl(features));
    classes[cls] = { count: features.length, file };
    if (cls !== 'stream') continue;
    const tiles = new Map();
    for (const f of features) {
      const [lon, lat] = f.geometry.coordinates;
      const key = usgsTileKey(lon, lat);
      if (!tiles.has(key)) tiles.set(key, []);
      tiles.get(key).push(f);
    }
    classes.stream.tiles = {};
    for (const [key, list] of [...tiles].sort(([a], [b]) =>
      a.localeCompare(b),
    )) {
      const tileFile = `stream/${key}.geojsonl`;
      files.set(tileFile, jsonl(list));
      classes.stream.tiles[key] = {
        count: list.length,
        bounds: usgsTileBounds(key),
        file: tileFile,
      };
    }
  }
  const manifest = {
    schema: 2,
    generated_at: generatedAt,
    stale,
    tile_deg: USGS_WATER_TILE_DEG,
    lookback_days: USGS_WATER_LOOKBACK_MS / (24 * 60 * 60_000),
    refresh_minutes: USGS_WATER_REFRESH_MS / 60_000,
    source: 'USGS Water Data OGC API (latest-continuous)',
    classes,
  };
  files.set('manifest.json', JSON.stringify(manifest));
  return { manifest, files };
}

/**
 * Live USGS store: fetches, merges, names and serves. All I/O is injectable.
 */
export function createUsgsWaterStore({
  fetchImpl = (...args) => globalThis.fetch(...args),
  now = () => Date.now(),
  env = process.env,
  cacheFile = path.join(
    defaultSourceRoot,
    '.gev-cache',
    'usgs-water-names.json',
  ),
  log = console,
} = {}) {
  const requestTimes = [];
  const names = new Map();
  let namesLoaded = false;
  let namesDirty = false;
  let built = null; // { files, manifest, at }
  let lastClassFeatures = {};
  let inflight = null;
  let lastFailureAt = -Infinity;

  const hourlyCap = () =>
    usgsWaterApiKey(env) ? KEYED_HOURLY_CAP : KEYLESS_HOURLY_CAP;
  function budgetLeft() {
    const t = now();
    while (requestTimes.length && t - requestTimes[0] > HOUR_MS)
      requestTimes.shift();
    return hourlyCap() - requestTimes.length;
  }

  async function getJson(url, maxBytes, signal) {
    if (budgetLeft() <= 0) throw new Error('usgs_hourly_budget_spent');
    requestTimes.push(now());
    const key = usgsWaterApiKey(env);
    const response = await fetchImpl(url, {
      headers: {
        Accept: 'application/geo+json, application/json',
        ...(key ? { 'X-Api-Key': key } : {}),
      },
      redirect: 'error',
      signal: AbortSignal.any(
        [signal, AbortSignal.timeout(FETCH_TIMEOUT_MS)].filter(Boolean),
      ),
    });
    if (!response.ok) {
      let detail = '';
      try {
        detail =
          JSON.parse(await readResponseTextCapped(response, 4096))
            ?.description || '';
      } catch {
        /* no readable detail */
      }
      throw new Error(
        `USGS HTTP ${response.status}${detail ? `: ${String(detail).slice(0, 160)}` : ''}`,
      );
    }
    // Throws when the body passes maxBytes (the stream is cancelled).
    return JSON.parse(await readResponseTextCapped(response, maxBytes, signal));
  }

  function nextHref(body) {
    const next = (body?.links || []).find((l) => l?.rel === 'next')?.href;
    if (!next) return null;
    const url = new URL(next);
    // Follow only the API's own paging links.
    if (url.origin !== new URL(USGS_WATER_API).origin) return null;
    url.searchParams.delete('api_key');
    return url.href;
  }

  async function fetchClassItems(spec, signal) {
    const items = [];
    for (const param of spec.params) {
      const q = new URLSearchParams({
        f: 'json',
        site_type_code: spec.site,
        parameter_code: param,
        // The API rejects a duration (P7D) here: it needs `<instant>/..`.
        datetime: `${new Date(now() - USGS_WATER_LOOKBACK_MS).toISOString().replace(/\.\d{3}Z$/, 'Z')}/..`,
        limit: String(PAGE_LIMIT),
      });
      let url = `${USGS_WATER_API}/collections/latest-continuous/items?${q}`;
      for (let page = 0; url && page < MAX_PAGES; page++) {
        const body = await getJson(url, PAGE_MAX_BYTES, signal);
        if (!Array.isArray(body?.features))
          throw new Error('USGS answer has no features');
        items.push(...body.features);
        url = nextHref(body);
      }
    }
    return items;
  }

  async function loadNames() {
    if (namesLoaded) return;
    namesLoaded = true;
    try {
      const saved = JSON.parse(await fsp.readFile(cacheFile, 'utf8'));
      const t = now();
      for (const [id, entry] of Object.entries(saved?.names || {}))
        if (
          SITE_ID.test(id) &&
          typeof entry?.name === 'string' &&
          t - entry.at < USGS_NAME_TTL_MS
        )
          names.set(id, { name: entry.name.slice(0, 160), at: entry.at });
    } catch {
      /* first run or unreadable cache: names are looked up again */
    }
  }

  async function saveNames() {
    if (!namesDirty) return;
    namesDirty = false;
    try {
      await fsp.mkdir(path.dirname(cacheFile), { recursive: true });
      const tmp = `${cacheFile}.${process.pid}.tmp`;
      await fsp.writeFile(
        tmp,
        JSON.stringify({ names: Object.fromEntries(names) }),
      );
      await fsp.rename(tmp, cacheFile);
    } catch (error) {
      log.warn?.('[USGS water] name cache not saved:', error?.message || error);
    }
  }

  /** Look up missing names with whatever this hour's budget has left. */
  async function fillNames(ids, signal) {
    const t = now();
    const missing = ids.filter((id) => {
      const entry = names.get(id);
      return !entry || t - entry.at >= USGS_NAME_TTL_MS;
    });
    for (
      let i = 0;
      i < missing.length && budgetLeft() > 4;
      i += USGS_NAME_BATCH
    ) {
      const batch = missing.slice(i, i + USGS_NAME_BATCH);
      const q = new URLSearchParams({
        f: 'json',
        id: batch.join(','),
        limit: String(batch.length),
        properties: 'monitoring_location_name',
        skipGeometry: 'true',
      });
      let body;
      try {
        body = await getJson(
          `${USGS_WATER_API}/collections/monitoring-locations/items?${q}`,
          NAMES_MAX_BYTES,
          signal,
        );
      } catch (error) {
        log.warn?.(
          '[USGS water] site name lookup failed:',
          error?.message || error,
        );
        return;
      }
      for (const f of body?.features || []) {
        const id = String(f?.id || f?.properties?.id || '');
        const name = String(
          f?.properties?.monitoring_location_name || '',
        ).trim();
        if (SITE_ID.test(id) && name) {
          names.set(id, { name: name.slice(0, 160), at: now() });
          namesDirty = true;
        }
      }
    }
  }

  async function refresh(signal) {
    await loadNames();
    const fresh = {};
    const failed = [];
    for (const [cls, spec] of Object.entries(USGS_WATER_CLASSES)) {
      try {
        fresh[cls] = { spec, items: await fetchClassItems(spec, signal) };
      } catch (error) {
        failed.push(cls);
        log.warn?.(
          `[USGS water] ${cls} refresh failed:`,
          error?.message || error,
        );
      }
    }
    if (failed.length === Object.keys(USGS_WATER_CLASSES).length && !built)
      throw new Error('usgs_unavailable');
    const ids = Object.values(fresh).flatMap(({ items }) =>
      items.map((i) => String(i?.properties?.monitoring_location_id || '')),
    );
    await fillNames(
      [...new Set(ids)].filter((id) => SITE_ID.test(id)),
      signal,
    );
    await saveNames();
    const byClass = {};
    for (const cls of Object.keys(USGS_WATER_CLASSES)) {
      byClass[cls] = fresh[cls]
        ? mergeUsgsReadings(fresh[cls].items, fresh[cls].spec.site, names)
        : lastClassFeatures[cls] || [];
    }
    lastClassFeatures = byClass;
    const result = buildUsgsWaterFiles(byClass, {
      generatedAt: new Date(now()).toISOString(),
      stale: failed.length > 0,
    });
    built = { ...result, at: now() };
    if (failed.length) lastFailureAt = now();
    return built;
  }

  /**
   * Current files. When they are an hour old a refresh starts in the
   * background and the current files are served meanwhile; only the very
   * first load waits. After a failed refresh nothing is retried for 5 minutes.
   */
  async function current() {
    const t = now();
    const due = !built || t - built.at >= USGS_WATER_REFRESH_MS;
    const cooling = t - lastFailureAt < RETRY_AFTER_FAILURE_MS;
    if (due && !inflight && !cooling) {
      inflight = refresh()
        .catch((error) => {
          lastFailureAt = now();
          log.warn?.('[USGS water] refresh failed:', error?.message || error);
          return built;
        })
        .finally(() => {
          inflight = null;
        });
    }
    if (built) return built;
    return inflight ? await inflight : null;
  }

  return { current, refresh, budgetLeft, names };
}

/**
 * Vite plugin: GET /api/usgs-water/manifest.json, /<class>.geojsonl and
 * /stream/<x>_<y>.geojsonl.
 */
export function usgsWaterProxy(options = {}) {
  const store = options.store || createUsgsWaterStore(options);
  async function handler(req, res) {
    const send = (status, type, body, extra = {}) => {
      res.writeHead(status, {
        'Content-Type': type,
        'Cache-Control': 'no-store',
        ...extra,
      });
      res.end(body);
    };
    if (req.method !== 'GET' && req.method !== 'HEAD')
      return send(
        405,
        'application/json',
        JSON.stringify({ error: 'method_not_allowed' }),
      );
    const name = decodeURIComponent(
      String(req.url || '').split('?')[0],
    ).replace(/^\/+/, '');
    if (
      !/^(manifest\.json|(stream|lake|spring)\.geojsonl|stream\/\d{1,3}_\d{1,3}\.geojsonl)$/.test(
        name,
      )
    )
      return send(
        404,
        'application/json',
        JSON.stringify({ error: 'not_found' }),
      );
    let built;
    try {
      built = await store.current();
    } catch {
      built = null;
    }
    if (!built) {
      return send(
        503,
        'application/json',
        JSON.stringify({ error: 'usgs_unavailable' }),
        { 'Retry-After': '300' },
      );
    }
    const body = built.files.get(name);
    if (body === undefined)
      return name.startsWith('stream/')
        ? send(200, 'application/x-ndjson', '')
        : send(404, 'application/json', JSON.stringify({ error: 'not_found' }));
    send(
      200,
      name.endsWith('.json') ? 'application/json' : 'application/x-ndjson',
      req.method === 'HEAD' ? '' : body,
    );
  }
  return {
    name: 'usgs-water',
    configureServer({ middlewares }) {
      middlewares.use('/api/usgs-water', handler);
    },
    configurePreviewServer({ middlewares }) {
      middlewares.use('/api/usgs-water', handler);
    },
    store,
  };
}
