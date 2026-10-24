import { readFileSync } from 'node:fs';
import {
  RIVER_FORECAST_VARIABLES,
  normalizeFloodSeries,
  normalizeRiverPoint,
  riverPointsInBox,
} from '../../src/layers/riverDischarge/records.js';
import { readResponseJsonCapped } from './common/http.js';
import { makeRateLimiter, clientKey } from './common/rate-limit.js';

// Open-Meteo Flood API (GloFAS v4; keyless, CC BY 4.0; the free API is
// non-commercial and limited to 10,000 weighted calls a day). The proxy reads
// only the bundled points (src/data/local_data/river_discharge/points.json):
// the browser sends a view box, never a URL or a coordinate to forward, and
// each point is read at its own GloFAS cell centre.
const FLOOD_API = 'https://flood-api.open-meteo.com/v1/flood';
const PACK_URL = new URL(
  '../../src/data/local_data/river_discharge/points.json',
  import.meta.url,
);
/** GloFAS publishes one forecast a day; three hours keeps a day's run fresh. */
export const RIVER_FRESH_MS = 3 * 3_600_000;
/** A forecast older than this is not shown, even as stale. */
export const RIVER_STALE_MAX_MS = 36 * 3_600_000;
/** Locations per upstream request (one weighted call each). */
export const RIVER_BATCH_SIZE = 50;
/**
 * Self-imposed ceiling on weighted calls per rolling hour, far below the
 * free tier's 5,000: a full refresh of the bundled set is one call a point.
 */
export const RIVER_HOURLY_WEIGHT = 600;
const FAILURE_COOLDOWN_MS = 60_000;
const COOLDOWN_MIN_MS = 5_000;
const COOLDOWN_MAX_MS = 3_600_000;
const TIMEOUT_MS = 15_000;
const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
const BOX_KEYS = Object.freeze(['south', 'west', 'north', 'east']);

let bundled = null;
function bundledPack() {
  if (!bundled) {
    const pack = JSON.parse(readFileSync(PACK_URL, 'utf8'));
    const span = pack.meta?.params?.climatology;
    bundled = {
      points: (pack.points || []).map(normalizeRiverPoint).filter(Boolean),
      climatology: { start: span?.start, end: span?.end },
    };
  }
  return bundled;
}

/**
 * The view box from a query string, or null. Exactly the four keys, each a
 * plain decimal in range; `west > east` is a box across the antimeridian.
 */
export function parseRiverBox(url) {
  let params;
  try {
    params = new URL(url || '/', 'http://local').searchParams;
  } catch {
    return null;
  }
  const keys = [...params.keys()];
  if (
    keys.length !== 4 ||
    !BOX_KEYS.every((key) => params.getAll(key).length === 1)
  )
    return null;
  const box = {};
  for (const key of BOX_KEYS) {
    const raw = params.get(key);
    if (!/^-?\d{1,3}(?:\.\d{1,4})?$/.test(raw)) return null;
    box[key] = Number(raw);
  }
  if (Math.abs(box.south) > 90 || Math.abs(box.north) > 90) return null;
  if (Math.abs(box.west) > 180 || Math.abs(box.east) > 180) return null;
  if (!(box.south < box.north) || box.west === box.east) return null;
  return box;
}

/** Cooldown (ms) an upstream 429 earns, honouring a sane Retry-After. */
export function riverRetryCooldownMs(raw) {
  const seconds = /^\d+(?:\.\d+)?$/.test(String(raw ?? '').trim())
    ? Number(raw)
    : NaN;
  return Number.isFinite(seconds) && seconds > 0
    ? Math.min(COOLDOWN_MAX_MS, Math.max(COOLDOWN_MIN_MS, seconds * 1000))
    : FAILURE_COOLDOWN_MS;
}

/** The upstream URL for one batch of bundled points (cell centres only). */
export function riverForecastUrl(points) {
  const params = new URLSearchParams({
    latitude: points.map((p) => p.lat.toFixed(3)).join(','),
    longitude: points.map((p) => p.lon.toFixed(3)).join(','),
    daily: Object.values(RIVER_FORECAST_VARIABLES).join(','),
    past_days: '1',
    forecast_days: '8',
    models: 'seamless_v4',
    timezone: 'GMT',
  });
  return `${FLOOD_API}?${params}`;
}

const utcDay = (ms) => new Date(ms).toISOString().slice(0, 10);

/** Fixed-origin, bounded Open-Meteo Flood API route for dev and preview. */
export function riverDischargeProxy({
  fetchImpl = (...args) => globalThis.fetch(...args),
  now = () => Date.now(),
  monotonicNow = () => performance.now(),
  pack = null,
  warn = (...args) => console.warn(...args),
} = {}) {
  const readPack = () => pack || bundledPack();
  /** Point id → { series, fetchedAt, savedAt }. */
  const cache = new Map();
  /** Point id → promise of its batch read. */
  const inFlight = new Map();
  /** Weighted calls spent in the rolling hour: { at, weight }. */
  const spent = [];
  const allow = makeRateLimiter({ windowMs: 60_000, max: 30, globalMax: 600 });
  let cooldownUntil = 0;

  const age = (entry) => {
    if (!entry) return Infinity;
    const elapsed = monotonicNow() - entry.savedAt;
    // A backwards injected clock cannot rejuvenate a forecast.
    return elapsed < 0 ? Infinity : elapsed;
  };

  function hourlyWeight() {
    const since = monotonicNow() - 3_600_000;
    while (spent.length && spent[0].at <= since) spent.shift();
    return spent.reduce((sum, s) => sum + s.weight, 0);
  }

  async function readBatch(batch) {
    if (monotonicNow() < cooldownUntil)
      throw Object.assign(new Error('cooling_down'), { status: 503 });
    if (hourlyWeight() + batch.length > RIVER_HOURLY_WEIGHT)
      throw Object.assign(new Error('hourly_budget'), { status: 503 });
    spent.push({ at: monotonicNow(), weight: batch.length });
    const signal = AbortSignal.timeout(TIMEOUT_MS);
    try {
      const response = await fetchImpl(riverForecastUrl(batch), {
        signal,
        redirect: 'error',
        headers: {
          Accept: 'application/json',
          'User-Agent': 'gods-eye-view-river-discharge/1.0',
        },
      });
      if (!response.ok) {
        await response.body?.cancel();
        const delay =
          response.status === 429
            ? riverRetryCooldownMs(response.headers.get('retry-after'))
            : FAILURE_COOLDOWN_MS;
        if (delay === COOLDOWN_MAX_MS)
          warn('[river-discharge] upstream cooldown capped at one hour');
        cooldownUntil = Math.max(cooldownUntil, monotonicNow() + delay);
        throw Object.assign(new Error('upstream_unavailable'), {
          status: 503,
        });
      }
      const payload = await readResponseJsonCapped(
        response,
        MAX_RESPONSE_BYTES,
        signal,
      );
      const rows = Array.isArray(payload) ? payload : [payload];
      if (rows.length !== batch.length) throw new Error('invalid_snapshot');
      const fetchedAt = now();
      const savedAt = monotonicNow();
      batch.forEach((point, index) => {
        const series = normalizeFloodSeries(rows[index]);
        if (!series) return;
        cache.delete(point.id);
        cache.set(point.id, { series, fetchedAt, savedAt });
      });
    } catch (error) {
      if (error.status !== 503)
        cooldownUntil = Math.max(
          cooldownUntil,
          monotonicNow() + FAILURE_COOLDOWN_MS,
        );
      throw error;
    }
  }

  /** Read every expired point in `wanted`, sharing batches already in flight. */
  async function refresh(wanted) {
    const waits = [];
    const due = [];
    for (const point of wanted) {
      if (age(cache.get(point.id)) < RIVER_FRESH_MS) continue;
      const pending = inFlight.get(point.id);
      if (pending) waits.push(pending);
      else due.push(point);
    }
    for (let i = 0; i < due.length; i += RIVER_BATCH_SIZE) {
      const batch = due.slice(i, i + RIVER_BATCH_SIZE);
      const promise = readBatch(batch).finally(() => {
        for (const point of batch)
          if (inFlight.get(point.id) === promise) inFlight.delete(point.id);
      });
      for (const point of batch) inFlight.set(point.id, promise);
      waits.push(promise);
    }
    const results = await Promise.allSettled(waits);
    return results.filter((r) => r.status === 'rejected').length;
  }

  async function handler(req, res) {
    const json = (status, value, { stale = false, retryAfterS = 60 } = {}) => {
      if (res.destroyed) return;
      res.writeHead(status, {
        'Content-Type': 'application/json',
        'Cache-Control': 'no-store',
        ...(status === 405 ? { Allow: 'GET' } : {}),
        ...([429, 503].includes(status)
          ? { 'Retry-After': String(retryAfterS) }
          : {}),
        ...(stale ? { 'X-Data-Stale': 'true' } : {}),
      });
      res.end(JSON.stringify(value));
    };
    if (req.method !== 'GET') return json(405, { error: 'method_not_allowed' });
    const path = (req.url || '/').split('?')[0];
    if (path !== '/' && path !== '')
      return json(404, { error: 'unknown_route' });
    const box = parseRiverBox(req.url);
    if (!box) return json(400, { error: 'invalid_box' });
    if (!allow(clientKey(req))) return json(429, { error: 'rate_limited' });
    let wanted, climatology;
    try {
      ({ climatology } = readPack());
      wanted = riverPointsInBox(readPack().points, box);
    } catch {
      return json(503, { error: 'river_points_unavailable' });
    }
    if (wanted.length) await refresh(wanted);
    const rows = [];
    let stale = false;
    let oldest = null;
    for (const point of wanted) {
      const entry = cache.get(point.id);
      const ms = age(entry);
      if (ms > RIVER_STALE_MAX_MS) continue;
      if (ms >= RIVER_FRESH_MS) stale = true;
      oldest =
        oldest === null ? entry.fetchedAt : Math.min(oldest, entry.fetchedAt);
      rows.push({ ...point, series: entry.series, ageMs: Math.round(ms) });
    }
    if (wanted.length && !rows.length) {
      const retryAfterS = Math.max(
        1,
        Math.min(
          3600,
          Math.ceil((cooldownUntil - monotonicNow()) / 1000) || 60,
        ),
      );
      return json(
        503,
        { error: 'river_discharge_unavailable' },
        { retryAfterS },
      );
    }
    json(
      200,
      {
        // The UTC day the outlook counts from, on this server's clock.
        today: utcDay(now()),
        // The reanalysis window the percentiles were computed over.
        climatology,
        fetchedAt: oldest,
        total: wanted.length,
        partial: rows.length < wanted.length,
        ...(stale ? { stale: true } : {}),
        points: rows,
      },
      { stale },
    );
  }

  return {
    name: 'river-discharge',
    configureServer({ middlewares }) {
      middlewares.use('/api/river-discharge', handler);
    },
    configurePreviewServer({ middlewares }) {
      middlewares.use('/api/river-discharge', handler);
    },
  };
}
