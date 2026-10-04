import { readResponseJsonCapped } from './common/http.js';

/**
 * /api/tides — NOAA CO-OPS high/low tide predictions for one station.
 *
 *   GET /api/tides?station=9413745&begin=<ISO>&end=<ISO>
 *
 * Keyless. Predictions are astronomical and change only when NOAA re-derives
 * a station's constituents, so responses are cached for hours. The window is
 * padded by a day on each side so the client always has turning points that
 * bracket the times it draws.
 */
const NOAA_URL = 'https://api.tidesandcurrents.noaa.gov/api/prod/datagetter';
const APPLICATION = 'gods-eye-view';
const DAY = 86_400_000;
const CACHE_TTL_MS = 6 * 3600_000;
const CACHE_LIMIT = 64;
const RESPONSE_LIMIT = 256 * 1024;
const MAX_WINDOW_MS = 8 * DAY;
const MAX_REACH_MS = 60 * DAY;
const TIME_PATTERN = /^(\d{4})-(\d\d)-(\d\d) (\d\d):(\d\d)$/;

function yyyymmdd(ms) {
  return new Date(ms).toISOString().slice(0, 10).replaceAll('-', '');
}

/** Parse and bound the query. Returns null when it is not acceptable. */
export function parseTideQuery(search, now = Date.now()) {
  const params = new URLSearchParams(search);
  const station = params.get('station') ?? '';
  const begin = Date.parse(params.get('begin') ?? '');
  const end = Date.parse(params.get('end') ?? '');
  if (
    !/^\d{7}$/.test(station) ||
    !Number.isFinite(begin) ||
    !Number.isFinite(end) ||
    end <= begin ||
    end - begin > MAX_WINDOW_MS ||
    Math.abs(begin - now) > MAX_REACH_MS ||
    Math.abs(end - now) > MAX_REACH_MS
  )
    return null;
  return {
    station,
    beginDate: yyyymmdd(begin - DAY),
    endDate: yyyymmdd(end + DAY),
  };
}

/** NOAA "2026-10-01 10:21" (GMT) rows → validated ISO turning points. */
export function normalizeNoaaPredictions(payload) {
  if (!payload || !Array.isArray(payload.predictions)) {
    const message =
      typeof payload?.error?.message === 'string'
        ? payload.error.message.slice(0, 160)
        : 'invalid_tide_data';
    throw Object.assign(new Error(message), { code: 'NOAA_ERROR' });
  }
  const rows = [];
  for (const row of payload.predictions) {
    const match = TIME_PATTERN.exec(row?.t ?? '');
    const height = Number(row?.v);
    const type = row?.type;
    if (!match || !Number.isFinite(height) || (type !== 'H' && type !== 'L'))
      throw new Error('invalid_tide_data');
    const [, y, mo, d, h, mi] = match;
    const ms = Date.UTC(+y, +mo - 1, +d, +h, +mi);
    if (!Number.isFinite(ms)) throw new Error('invalid_tide_data');
    rows.push({ time: new Date(ms).toISOString(), height, type });
  }
  if (rows.length < 2 || rows.length > 400) throw new Error('invalid_tide_data');
  return rows;
}

export function tidesProxy({
  fetchImpl = (...args) => globalThis.fetch(...args),
  now = Date.now,
} = {}) {
  const cache = new Map();
  const inflight = new Map();

  async function load(query) {
    const key = `${query.station}:${query.beginDate}:${query.endDate}`;
    const hit = cache.get(key);
    if (hit && now() - hit.fetchedAt < CACHE_TTL_MS) return hit;
    if (inflight.has(key)) return inflight.get(key);
    const url = new URL(NOAA_URL);
    url.search = new URLSearchParams({
      product: 'predictions',
      application: APPLICATION,
      station: query.station,
      begin_date: query.beginDate,
      end_date: query.endDate,
      datum: 'MLLW',
      time_zone: 'gmt',
      interval: 'hilo',
      units: 'metric',
      format: 'json',
    }).toString();
    const promise = (async () => {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 15_000);
      try {
        const response = await fetchImpl(url, {
          signal: controller.signal,
          headers: { Accept: 'application/json' },
        });
        if (!response.ok) throw new Error(`noaa_http_${response.status}`);
        const predictions = normalizeNoaaPredictions(
          await readResponseJsonCapped(
            response,
            RESPONSE_LIMIT,
            controller.signal,
          ),
        );
        const value = { fetchedAt: now(), predictions };
        cache.set(key, value);
        while (cache.size > CACHE_LIMIT) cache.delete(cache.keys().next().value);
        return value;
      } finally {
        clearTimeout(timer);
        inflight.delete(key);
      }
    })();
    inflight.set(key, promise);
    return promise;
  }

  async function handler(req, res) {
    const json = (status, value) => {
      if (res.writableEnded) return;
      res.writeHead(status, {
        'Content-Type': 'application/json',
        'Cache-Control': status === 200 ? 'private, max-age=1800' : 'no-store',
      });
      res.end(JSON.stringify(value));
    };
    if (req.method !== 'GET') return json(405, { error: 'method_not_allowed' });
    const search = String(req.url ?? '').split('?')[1] ?? '';
    const query = parseTideQuery(search, now());
    if (!query) return json(400, { error: 'invalid_tide_query' });
    try {
      const value = await load(query);
      json(200, {
        schemaVersion: 1,
        station: query.station,
        datum: 'MLLW',
        units: 'm',
        source: 'NOAA CO-OPS',
        attribution: 'NOAA Center for Operational Oceanographic Products and Services',
        fetchedAt: new Date(value.fetchedAt).toISOString(),
        predictions: value.predictions,
      });
    } catch (error) {
      const noaa = error?.code === 'NOAA_ERROR';
      json(noaa ? 404 : 502, {
        error: noaa ? 'station_unavailable' : 'tides_unavailable',
        reason: noaa ? error.message : 'NOAA tide predictions unavailable',
      });
    }
  }

  return {
    name: 'tides',
    configureServer({ middlewares }) {
      middlewares.use('/api/tides', handler);
    },
    configurePreviewServer({ middlewares }) {
      middlewares.use('/api/tides', handler);
    },
  };
}
