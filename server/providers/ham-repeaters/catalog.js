import {
  bandForHz,
  REPEATER_BANDS,
} from '../../../src/sources/hamRepeaters.js';
import {
  HAM_REPEATERS_CACHE_MAX_ENTRIES,
  HAM_REPEATERS_CACHE_MS,
  HAM_REPEATERS_MOUNT_PATH,
  HAM_REPEATERS_NEARBY_PATH,
  HAM_REPEATERS_STALE_FACTOR,
  SEARCH_DEFAULT_LIMIT,
  SEARCH_DEFAULT_RADIUS_KM,
  SEARCH_KINDS,
  SEARCH_MAX_LIMIT,
  SEARCH_MAX_RADIUS_KM,
  SEARCH_MIN_RADIUS_KM,
} from './constants.js';

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

function parseNumber(value, { name, min, max, integer = false, fallback }) {
  if (value === undefined || value === null || value === '') {
    if (fallback !== undefined) return fallback;
    throw new HttpError(400, `${name} is required`);
  }
  const number = Number(value);
  if (!Number.isFinite(number))
    throw new HttpError(400, `${name} must be a number`);
  if (integer && !Number.isInteger(number))
    throw new HttpError(400, `${name} must be an integer`);
  if (number < min) throw new HttpError(400, `${name} must be >= ${min}`);
  if (number > max) throw new HttpError(400, `${name} must be <= ${max}`);
  return number;
}

function parseChoice(value, choices, { name, fallback }) {
  if (value === undefined || value === null || value === '') return fallback;
  const text = String(value).trim().toLowerCase();
  if (!choices.includes(text))
    throw new HttpError(400, `${name} must be one of ${choices.join(', ')}`);
  return text;
}

function parseBand(value) {
  if (value === undefined || value === null) return null;
  const text = String(value).trim().toLowerCase();
  if (text === '' || text === 'all') return null;
  if (!REPEATER_BANDS.includes(text))
    throw new HttpError(
      400,
      `band must be one of all, ${REPEATER_BANDS.join(', ')}`,
    );
  return text;
}

function shortMessage(error) {
  const text = String(error?.message ?? error ?? '')
    .replace(/\s+/g, ' ')
    .trim();
  return (text || 'unknown error').slice(0, 200);
}

/** Parse the browser's search; throws HttpError(400) with the field's message. */
export function parseRepeaterSearch(params) {
  const lat = parseNumber(params.get('lat'), {
    name: 'lat',
    min: -90,
    max: 90,
  });
  const lon = parseNumber(params.get('lon'), {
    name: 'lon',
    min: -180,
    max: 180,
  });
  const radiusKm = parseNumber(params.get('radiusKm') ?? params.get('radius'), {
    name: 'radiusKm',
    min: SEARCH_MIN_RADIUS_KM,
    max: SEARCH_MAX_RADIUS_KM,
    fallback: SEARCH_DEFAULT_RADIUS_KM,
  });
  const limit = parseNumber(params.get('limit'), {
    name: 'limit',
    min: 1,
    max: SEARCH_MAX_LIMIT,
    integer: true,
    fallback: SEARCH_DEFAULT_LIMIT,
  });
  const band = parseBand(params.get('band'));
  const kind = parseChoice(params.get('kind'), [...SEARCH_KINDS], {
    name: 'kind',
    fallback: 'all',
  });
  return { lat, lon, radiusKm, limit, band, kind };
}

/** Searches in the same 0.1° cell with the same filters share one cache entry. */
export function repeaterSearchKey({ lat, lon, radiusKm, limit, band, kind }) {
  const cell = (value) => (Math.round(value * 10) / 10).toFixed(1);
  return `repeaters:${cell(lat)}|${cell(lon)}|${Math.round(radiusKm)}|${limit}|${band ?? 'all'}|${kind}`;
}

/**
 * Create the testable Connect middleware backing `/api/ham-repeaters`.
 * `providers` are adapters with `getRepeaters(search)`; their rows are merged
 * (first adapter wins on an id), filtered by band, sorted nearest first and
 * capped at `limit`.
 */
export function createHamRepeatersMiddleware({
  providers = [],
  enabled = true,
  now = Date.now,
  log = console,
} = {}) {
  const cache = new Map();
  const inflight = new Map();

  function sendJson(res, status, body, extraHeaders = {}) {
    res.writeHead(status, {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
      ...extraHeaders,
    });
    res.end(
      JSON.stringify({
        generatedAt: new Date(now()).toISOString(),
        sources: [],
        ...body,
      }),
    );
  }

  function remember(key, value) {
    cache.delete(key);
    cache.set(key, value);
    while (cache.size > HAM_REPEATERS_CACHE_MAX_ENTRIES)
      cache.delete(cache.keys().next().value);
  }

  async function produce(search) {
    if (!providers.length)
      throw new HttpError(502, 'No repeater directory is configured');
    const outcomes = await Promise.allSettled(
      providers.map((provider) => provider.getRepeaters(search)),
    );
    const errors = {};
    const sources = [];
    const byId = new Map();
    let answered = 0;
    outcomes.forEach((outcome, index) => {
      const provider = providers[index];
      if (outcome.status === 'rejected') {
        errors[provider.id] = shortMessage(outcome.reason);
        return;
      }
      answered += 1;
      Object.assign(errors, outcome.value.errors || {});
      sources.push(...(outcome.value.sources || []));
      for (const row of outcome.value.rows || [])
        if (!byId.has(row.id)) byId.set(row.id, row);
    });
    if (!answered)
      throw new HttpError(
        502,
        `Repeater feeds unavailable: ${Object.values(errors).join('; ')}`,
      );
    let repeaters = [...byId.values()];
    if (search.band)
      repeaters = repeaters.filter(
        (row) => row.outputHz && bandForHz(row.outputHz) === search.band,
      );
    repeaters.sort(
      (a, b) =>
        (Number.isFinite(a.distanceKm) ? a.distanceKm : Infinity) -
        (Number.isFinite(b.distanceKm) ? b.distanceKm : Infinity),
    );
    return {
      repeaters: repeaters.slice(0, search.limit),
      errors,
      sources,
      partial: Object.keys(errors).length > 0,
    };
  }

  async function cached(search) {
    const key = repeaterSearchKey(search);
    const hit = cache.get(key);
    if (hit && now() - hit.cachedAt < HAM_REPEATERS_CACHE_MS) {
      remember(key, hit);
      return { ...hit, stale: false };
    }
    if (!inflight.has(key)) {
      inflight.set(
        key,
        Promise.resolve()
          .then(() => produce(search))
          .finally(() => inflight.delete(key)),
      );
    }
    try {
      const value = await inflight.get(key);
      const entry = { value, cachedAt: now() };
      remember(key, entry);
      return { ...entry, stale: false };
    } catch (error) {
      if (
        hit &&
        now() - hit.cachedAt <
          HAM_REPEATERS_CACHE_MS * HAM_REPEATERS_STALE_FACTOR
      ) {
        log?.warn?.(
          `[ham-repeaters] ${key}: ${shortMessage(error)} — serving cached copy`,
        );
        return { ...hit, stale: true };
      }
      throw error;
    }
  }

  return async function hamRepeatersMiddleware(req, res) {
    let requestUrl;
    try {
      requestUrl = new URL(req.url || '/', 'http://localhost');
    } catch {
      sendJson(res, 400, { error: 'Malformed request URL' });
      return;
    }
    const pathname =
      requestUrl.pathname
        .replace(new RegExp(`^${HAM_REPEATERS_MOUNT_PATH}(?=/|$)`), '')
        .replace(/\/+$/, '') || '/';
    if (pathname !== HAM_REPEATERS_NEARBY_PATH) {
      sendJson(res, 404, { error: 'Unknown repeater route' });
      return;
    }
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      sendJson(
        res,
        405,
        { error: 'Method not allowed (use GET)' },
        { Allow: 'GET' },
      );
      return;
    }
    if (!enabled) {
      sendJson(res, 503, {
        error: 'HamRig integration disabled',
        enabled: false,
      });
      return;
    }
    let search;
    try {
      search = parseRepeaterSearch(requestUrl.searchParams);
    } catch (error) {
      sendJson(res, error instanceof HttpError ? error.status : 400, {
        error: shortMessage(error),
      });
      return;
    }
    try {
      const hit = await cached(search);
      sendJson(res, 200, {
        sources: hit.value.sources,
        repeaters: hit.value.repeaters,
        errors: hit.value.errors,
        partial: hit.value.partial,
        search: { ...search, band: search.band ?? 'all' },
        stale: hit.stale,
        updatedAt: new Date(hit.cachedAt).toISOString(),
      });
    } catch (error) {
      const status = error instanceof HttpError ? error.status : 502;
      log?.warn?.(`[ham-repeaters] GET /nearby: ${shortMessage(error)}`);
      sendJson(res, status, { error: shortMessage(error) });
    }
  };
}
