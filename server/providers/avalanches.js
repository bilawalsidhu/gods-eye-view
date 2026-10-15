import {
  daySpan,
  isIsoDate,
  normalizeEawsRegions,
  normalizeRegobsObservations,
  normalizeVarsomRegions,
} from '../../src/layers/avalanches/records.js';
import { coalesceProxyRequest, readResponseJsonCapped } from './common/http.js';
import { makeRateLimiter, clientKey } from './common/rate-limit.js';

// Varsom / NVE regional avalanche forecasts (NLOD). Language key 2 = English.
const VARSOM_URL =
  'https://api01.nve.no/hydrology/forecast/avalanche/v6.3.0/api/RegionSummary/Simple/2';
// regObs public observation search (NLOD; credit regObs and the observer).
const REGOBS_SEARCH_URL = 'https://api.regobs.no/v5/Search';
const REGOBS_COUNT_URL = 'https://api.regobs.no/v5/Search/Count';
// EAWS micro-region outlines (CC0); ids match the Varsom region ids.
const EAWS_NO_URL =
  'https://regions.avalanches.org/micro-regions/NO_micro-regions.geojson.json';

const MIB = 1024 * 1024;
/** Widest date window one request may ask for. */
export const AVALANCHE_MAX_SPAN_DAYS = 14;
/** regObs geo-hazard id for snow, and registration type for avalanche observations. */
const REGOBS_SNOW = 10;
const REGOBS_AVALANCHE_OBS = 26;
/** One regObs page; a peak week is ~200 avalanche observations. */
const REGOBS_PAGE = 300;
const REGOBS_MAX_PAGES = 3;
/** Season weeks counted in parallel against regObs. */
const COUNT_CONCURRENCY = 4;
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

const regobsQuery = (from, to, extra = {}) =>
  JSON.stringify({
    SelectedGeoHazards: [REGOBS_SNOW],
    SelectedRegistrationTypes: [{ Id: REGOBS_AVALANCHE_OBS }],
    FromDtObsTime: `${from}T00:00:00`,
    ToDtObsTime: `${to}T23:59:59`,
    LangKey: 2,
    ...extra,
  });

/** Bounded, cached Varsom + regObs + EAWS routes for dev and preview. */
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

  const post = (body) => ({
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body,
  });

  async function fetchForecast({ from, to }) {
    const payload = await upstream(
      `${VARSOM_URL}/${from}/${to}`,
      8 * MIB,
      20_000,
    );
    return { from, to, regions: normalizeVarsomRegions(payload) };
  }

  async function fetchObservations({ from, to }) {
    const rows = [];
    for (let page = 0; page < REGOBS_MAX_PAGES; page++) {
      const batch = await upstream(
        REGOBS_SEARCH_URL,
        24 * MIB,
        30_000,
        post(
          regobsQuery(from, to, {
            NumberOfRecords: REGOBS_PAGE,
            Offset: page * REGOBS_PAGE,
          }),
        ),
      );
      if (!Array.isArray(batch)) throw new Error('invalid_observations');
      rows.push(...batch);
      if (batch.length < REGOBS_PAGE) break;
    }
    return { from, to, observations: normalizeRegobsObservations(rows) };
  }

  async function fetchSeason(startYear) {
    const weeks = seasonWeeks(startYear).filter(
      (week) => week.from <= today(now()),
    );
    const counted = [];
    for (let start = 0; start < weeks.length; start += COUNT_CONCURRENCY) {
      const batch = weeks.slice(start, start + COUNT_CONCURRENCY);
      const totals = await Promise.all(
        batch.map((week) =>
          upstream(
            REGOBS_COUNT_URL,
            64 * 1024,
            20_000,
            post(regobsQuery(week.from, week.to)),
          ),
        ),
      );
      batch.forEach((week, index) => {
        const count = Number(totals[index]?.TotalMatches);
        counted.push({ ...week, count: Number.isFinite(count) ? count : 0 });
      });
    }
    return { season: startYear, weeks: counted };
  }

  async function fetchRegions() {
    return {
      regions: normalizeEawsRegions(
        await upstream(EAWS_NO_URL, 8 * MIB, 30_000),
      ),
    };
  }

  /** Cached value, refreshed once per TTL and served stale when upstream fails. */
  async function acquire(key, ttl, load) {
    const previous = cache.get(key);
    if (previous && now() - previous.savedAt < ttl)
      return { ...previous, stale: false };
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
