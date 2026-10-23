import { daySpan, isIsoDate } from '../../src/layers/avalanches/records.js';
import { coalesceProxyRequest, readResponseJsonCapped } from './common/http.js';
import { makeRateLimiter, clientKey } from './common/rate-limit.js';
import { createNorwayAvalancheProvider } from './avalanches/norway.js';
import { createSwitzerlandAvalancheProvider } from './avalanches/switzerland.js';

/** Widest date window one request may ask for. */
export const AVALANCHE_MAX_SPAN_DAYS = 14;
/** Distinct cached windows retained. */
const CACHE_MAX = 96;

const LIVE_TTL_MS = 15 * 60_000;
const PAST_TTL_MS = 24 * 3_600_000;
const REGIONS_TTL_MS = 24 * 3_600_000;

const today = (now) => new Date(now).toISOString().slice(0, 10);

/**
 * A request's date window, or why it is refused. Forecasts reach two days
 * ahead; nothing before regObs and Varsom existed is worth a request.
 * @param {URLSearchParams} query Request query.
 * @param {number} now Current instant.
 * @returns {{from:string, to:string}|{error:string}}
 */
export function avalancheWindow(query, now) {
  const from = query.get('from');
  const to = query.get('to');
  if (!isIsoDate(from) || !isIsoDate(to)) return { error: 'invalid_date' };
  const span = daySpan(from, to);
  if (span < 0) return { error: 'invalid_range' };
  if (span > AVALANCHE_MAX_SPAN_DAYS) return { error: 'range_too_wide' };
  if (from < '2012-12-01' || daySpan(today(now), to) > 3)
    return { error: 'out_of_range' };
  return { from, to };
}

/** Week starts (Mondays) covering a December–May season. */
export function seasonWeeks(startYear) {
  const weeks = [];
  const first = new Date(Date.UTC(startYear, 11, 1));
  // Back up to the Monday on or before 1 December.
  first.setUTCDate(first.getUTCDate() - ((first.getUTCDay() + 6) % 7));
  const end = Date.UTC(startYear + 1, 4, 31);
  for (let at = first.getTime(); at <= end; at += 7 * 86_400_000) {
    const from = new Date(at).toISOString().slice(0, 10);
    const to = new Date(at + 6 * 86_400_000).toISOString().slice(0, 10);
    weeks.push({ from, to });
  }
  return weeks;
}

/**
 * Run one operation across providers and merge what answered. One country
 * being down must not blank the others, so a partial answer is still an
 * answer; it names who is missing, and only a total failure is an error.
 * @param {Array<object>} providers Providers that implement `operation`.
 * @param {(provider:object) => Promise<Array>} operation Provider call.
 * @returns {Promise<{items:Array, unavailable:Array<string>}>}
 */
export async function mergeProviders(providers, operation) {
  const settled = await Promise.allSettled(providers.map(operation));
  const items = [];
  const unavailable = [];
  settled.forEach((result, index) => {
    if (result.status === 'fulfilled') items.push(...result.value);
    else unavailable.push(providers[index].id);
  });
  if (unavailable.length === providers.length)
    throw new Error('upstream_unavailable');
  return { items, unavailable };
}

/**
 * Bounded, cached avalanche routes for dev and preview: Norway (Varsom,
 * regObs, EAWS outlines) and Switzerland (SLF).
 */
export function avalancheProxy({
  fetchImpl = (...args) => globalThis.fetch(...args),
  now = () => Date.now(),
} = {}) {
  const cache = new Map();
  const inFlight = new Map();
  const allow = makeRateLimiter({ windowMs: 60_000, max: 60, globalMax: 1200 });

  async function upstream(url, cap, timeout, options = {}) {
    const signal = AbortSignal.timeout(timeout);
    const response = await fetchImpl(url, {
      ...options,
      signal,
      redirect: 'error',
      headers: { Accept: 'application/json', ...(options.headers ?? {}) },
    });
    if (!response.ok) {
      await response.body?.cancel();
      throw new Error('upstream_unavailable');
    }
    return readResponseJsonCapped(response, cap, signal);
  }

  const norway = createNorwayAvalancheProvider({ upstream });
  const switzerland = createSwitzerlandAvalancheProvider({ upstream });
  /** Danger forecasts and region outlines, by country. */
  const forecasters = [norway, switzerland];

  async function fetchForecast(window) {
    const { items, unavailable } = await mergeProviders(forecasters, (p) =>
      p.forecast(window),
    );
    return { ...window, regions: items, unavailable };
  }

  async function fetchRegions() {
    const { items, unavailable } = await mergeProviders(forecasters, (p) =>
      p.regions(),
    );
    return { regions: items, unavailable };
  }

  async function fetchObservations(window) {
    // Only regObs publishes public observations; other countries add none.
    return { ...window, observations: await norway.observations(window) };
  }

  async function fetchSeason(startYear) {
    const weeks = seasonWeeks(startYear).filter(
      (week) => week.from <= today(now()),
    );
    return { season: startYear, weeks: await norway.weekCounts(weeks) };
  }

  /** Cached value, refreshed once per TTL and served stale when upstream fails. */
  async function acquire(key, ttl, load) {
    const previous = cache.get(key);
    // A partial answer is kept briefly, so a country that was down returns soon.
    const fresh =
      previous &&
      now() - previous.savedAt <
        (previous.value.unavailable?.length ? LIVE_TTL_MS : ttl);
    if (fresh) return { ...previous, stale: false };
    if (!inFlight.has(key) && inFlight.size >= 32)
      throw Object.assign(new Error('busy'), { status: 429 });
    try {
      const { promise } = coalesceProxyRequest(inFlight, key, async () => {
        const entry = { value: await load(), savedAt: now() };
        cache.delete(key);
        cache.set(key, entry);
        if (cache.size > CACHE_MAX) cache.delete(cache.keys().next().value);
        return entry;
      });
      return { ...(await promise), stale: false };
    } catch (error) {
      if (previous) return { ...previous, stale: true };
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
    const url = new URL(req.url || '/', 'http://local');
    const path = url.pathname.replace(/\/+$/, '') || '/';
    let key, ttl, load;
    if (path === '/regions') {
      key = 'regions';
      ttl = REGIONS_TTL_MS;
      load = fetchRegions;
    } else if (path === '/forecast' || path === '/observations') {
      const window = avalancheWindow(url.searchParams, now());
      if (window.error) return json(400, { error: window.error });
      // A window that reaches today can still change; a past one cannot.
      ttl = window.to >= today(now()) ? LIVE_TTL_MS : PAST_TTL_MS;
      key = `${path.slice(1)}:${window.from}:${window.to}`;
      load = () =>
        path === '/forecast'
          ? fetchForecast(window)
          : fetchObservations(window);
    } else if (path === '/season') {
      const season = Number(url.searchParams.get('season'));
      const latest = new Date(now()).getUTCFullYear();
      if (!Number.isInteger(season) || season < 2012 || season > latest)
        return json(400, { error: 'invalid_season' });
      key = `season:${season}`;
      // The running season still gains observations; a finished one is fixed.
      ttl = Date.UTC(season + 1, 5, 1) > now() ? 3_600_000 : PAST_TTL_MS;
      load = () => fetchSeason(season);
    } else return json(404, { error: 'unknown_route' });
    if (!allow(clientKey(req))) return json(429, { error: 'rate_limited' });
    try {
      const { value, savedAt, stale } = await acquire(key, ttl, load);
      json(200, { ...value, fetchedAt: savedAt, stale }, stale);
    } catch (error) {
      json(error.status === 429 ? 429 : 502, {
        error: 'avalanche_data_unavailable',
      });
    }
  }

  return {
    name: 'avalanches',
    configureServer({ middlewares }) {
      middlewares.use('/api/avalanches', handler);
    },
    configurePreviewServer({ middlewares }) {
      middlewares.use('/api/avalanches', handler);
    },
  };
}
