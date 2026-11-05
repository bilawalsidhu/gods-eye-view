import {
  readResponseJsonCapped,
  coalesceProxyRequest,
} from '../common/http.js';
import { makeRateLimiter, clientKey } from '../common/rate-limit.js';
import { admitSameSiteKeyless } from '../common/same-site.js';
import {
  PEGELONLINE_STATIONS_URL,
  normalizePegelonline,
  normalizePegelonlineSeries,
  pegelonlineMeasurementsUrl,
} from './pegelonline.js';
import {
  ECCC_MAX_PAGES,
  ECCC_PAGE_SIZE,
  ECCC_REALTIME_WINDOW_MS,
  ECCC_STATIONS_URL,
  buildEcccStations,
  ecccFeatures,
  ecccRealtimeUrl,
  ecccSeriesUrl,
  ecccStatsUrl,
  normalizeEcccReadings,
  normalizeEcccRegister,
  normalizeEcccSeries,
  normalizeEcccStats,
} from './eccc.js';
import {
  WRA_REALTIME_URL,
  WRA_STATIONS_URL,
  normalizeWraReadings,
  normalizeWraRegister,
} from './wra.js';

const MIB = 1024 * 1024;
/** The networks publish every 5-15 minutes. */
const SNAPSHOT_TTL_MS = 10 * 60_000;
/** Gauge registers change rarely. */
const REGISTER_TTL_MS = 24 * 60 * 60_000;
/** ECCC's archived yearly statistics change a few times a year. */
const STATS_TTL_MS = 7 * 24 * 60 * 60_000;
/** Longest a network that stopped answering keeps its last readings. */
const STALE_MAX_MS = 6 * 60 * 60_000;
/** A network that failed is not asked again for this long. */
const FAILURE_BACKOFF_MS = 5 * 60_000;
/** Readings remembered per gauge, for the trend and the card's plot. */
const HISTORY_SPAN_MS = 72 * 60 * 60_000;
const HISTORY_MAX_POINTS = 600;
const HISTORY_MAX_GAUGES = 5_000;
/** The trend compares the newest reading with one 40 min to 3 h older. */
const TREND_MIN_MS = 40 * 60_000;
const TREND_MAX_MS = 3 * 60 * 60_000;
const SERIES_TTL_MS = 10 * 60_000;
const SERIES_CACHE_MAX = 256;

const PROVIDER_IDS = Object.freeze(['pegelonline', 'wra', 'eccc']);
const STATION_PATH =
  /^\/station\/(pegelonline\/[0-9a-f-]{36}|wra\/[0-9A-Z]{4,12}|eccc\/[0-9]{2}[A-Z]{2}[0-9]{3})\/?$/;

/**
 * Keyless river gauge routes for dev and preview:
 * - `GET /api/river-levels`: every current gauge reading from all networks,
 *   in the shared shape (`src/layers/riverLevels/model.js`) with its band and,
 *   once two readings are known, its trend in cm/h;
 * - `GET /api/river-levels/station/<provider>/<code>`: the gauge's recent
 *   series for its card (72 h from PEGELONLINE and ECCC; for Taiwan, which publishes
 *   only the newest reading, what this server has seen since it started).
 */
export function riverLevelsProxy({
  fetchImpl = (...args) => globalThis.fetch(...args),
  now = () => Date.now(),
} = {}) {
  const allow = makeRateLimiter({ windowMs: 60_000, max: 60, globalMax: 1200 });
  const inFlight = new Map();
  const state = Object.fromEntries(
    PROVIDER_IDS.map((id) => [id, { stations: null, savedAt: 0, failedAt: 0 }]),
  );
  let register = null;
  let registerAt = 0;
  const eccc = { register: null, registerAt: 0, stats: null, statsAt: 0 };
  /** @type {Map<string, Array<[number, number]>>} */
  const history = new Map();
  /** @type {Map<string, {savedAt: number, points: Array<[number, number]>}>} */
  const seriesCache = new Map();

  async function upstream(url, cap, timeout) {
    const signal = AbortSignal.timeout(timeout);
    const response = await fetchImpl(url, {
      signal,
      redirect: 'error',
      headers: { Accept: 'application/json' },
    });
    if (!response.ok) {
      await response.body?.cancel();
      throw new Error('upstream_unavailable');
    }
    return readResponseJsonCapped(response, cap, signal);
  }

  async function loadWra() {
    if (!register || now() - registerAt > REGISTER_TTL_MS) {
      try {
        const next = normalizeWraRegister(
          await upstream(WRA_STATIONS_URL, 16 * MIB, 45_000),
        );
        if (next.size) {
          register = next;
          registerAt = now();
        }
      } catch (error) {
        // An unreachable register keeps yesterday's positions and levels.
        if (!register) throw error;
      }
    }
    if (!register) throw new Error('invalid_register');
    return normalizeWraReadings(
      register,
      await upstream(WRA_REALTIME_URL, 8 * MIB, 30_000),
    );
  }

  /** Every page of a GeoMet query, until a short page. */
  async function pages(urlFor, cap, timeout) {
    const features = [];
    for (let page = 0; page < ECCC_MAX_PAGES; page++) {
      const batch = ecccFeatures(
        await upstream(urlFor(page * ECCC_PAGE_SIZE), cap, timeout),
      );
      features.push(...batch);
      if (batch.length < ECCC_PAGE_SIZE) return features;
    }
    throw new Error('too_many_pages');
  }

  async function loadEccc() {
    if (!eccc.register || now() - eccc.registerAt > REGISTER_TTL_MS) {
      try {
        const next = normalizeEcccRegister(
          ecccFeatures(await upstream(ECCC_STATIONS_URL, 8 * MIB, 45_000)),
        );
        if (next.size) {
          eccc.register = next;
          eccc.registerAt = now();
        }
      } catch (error) {
        if (!eccc.register) throw error;
      }
    }
    if (!eccc.register) throw new Error('invalid_register');
    if (!eccc.stats || now() - eccc.statsAt > STATS_TTL_MS) {
      try {
        const next = normalizeEcccStats(
          await pages(ecccStatsUrl, 8 * MIB, 60_000),
        );
        if (next.size) {
          eccc.stats = next;
          eccc.statsAt = now();
        }
      } catch {
        // Without statistics the gauges still read, grey; retried after the
        // failure backoff rather than on every refresh.
        eccc.statsAt = now() - STATS_TTL_MS + FAILURE_BACKOFF_MS;
      }
    }
    const since = now() - ECCC_REALTIME_WINDOW_MS;
    const readings = normalizeEcccReadings(
      await pages((offset) => ecccRealtimeUrl(since, offset), 8 * MIB, 45_000),
    );
    // Each 5-minute reading of the window feeds the trend at once.
    for (const [code, points] of readings)
      if (eccc.register.has(code)) remember(`eccc:${code}`, points);
    return buildEcccStations(eccc.register, eccc.stats, readings);
  }

  const loaders = {
    pegelonline: async () =>
      normalizePegelonline(
        await upstream(PEGELONLINE_STATIONS_URL, 16 * MIB, 45_000),
      ),
    wra: loadWra,
    eccc: loadEccc,
  };

  /** Merge readings into the per-gauge history, newest last. */
  function remember(id, points) {
    let series = history.get(id);
    if (!series) {
      if (history.size >= HISTORY_MAX_GAUGES)
        history.delete(history.keys().next().value);
      series = [];
      history.set(id, series);
    }
    for (const point of points) {
      const at = series.findIndex((p) => p[0] >= point[0]);
      if (at === -1) series.push(point);
      else if (series[at][0] !== point[0]) series.splice(at, 0, point);
    }
    const newest = series.at(-1)?.[0] ?? 0;
    while (series.length && newest - series[0][0] > HISTORY_SPAN_MS)
      series.shift();
    if (series.length > HISTORY_MAX_POINTS)
      series.splice(0, series.length - HISTORY_MAX_POINTS);
  }

  /** cm/h between the newest reading and one 40 min to 3 h older, or null. */
  function trendOf(id) {
    const series = history.get(id);
    if (!series || series.length < 2) return null;
    const [latestAt, latest] = series.at(-1);
    for (let i = series.length - 2; i >= 0; i--) {
      const age = latestAt - series[i][0];
      if (age < TREND_MIN_MS) continue;
      if (age > TREND_MAX_MS) return null;
      return (
        Math.round((((latest - series[i][1]) * 100 * 3_600_000) / age) * 10) /
        10
      );
    }
    return null;
  }

  async function refresh(id) {
    const entry = state[id];
    const at = now();
    if (entry.stations && at - entry.savedAt < SNAPSHOT_TTL_MS) return;
    if (entry.failedAt && at - entry.failedAt < FAILURE_BACKOFF_MS) return;
    try {
      const { promise } = coalesceProxyRequest(inFlight, id, loaders[id]);
      const stations = await promise;
      if (!stations.length) throw new Error('empty_snapshot');
      entry.stations = stations;
      entry.savedAt = now();
      entry.failedAt = 0;
      for (const station of stations)
        remember(station.id, [[station.observedMs, station.level]]);
    } catch {
      entry.failedAt = now();
    }
  }

  async function snapshot() {
    await Promise.all(PROVIDER_IDS.map(refresh));
    const providers = {};
    const stations = [];
    for (const id of PROVIDER_IDS) {
      const entry = state[id];
      const usable =
        entry.stations && now() - entry.savedAt <= STALE_MAX_MS
          ? entry.stations
          : null;
      providers[id] = {
        count: usable?.length ?? 0,
        stale: Boolean(usable && entry.failedAt > entry.savedAt),
        available: Boolean(usable),
      };
      for (const station of usable || [])
        stations.push({ ...station, trend: trendOf(station.id) });
    }
    return { fetchedAt: now(), providers, stations };
  }

  async function series(provider, code) {
    const id = `${provider}:${code}`;
    if (provider === 'wra') {
      if (!register?.has(code)) return null;
      return {
        id,
        points: history.get(id) ?? [],
        partial: true,
        trend: trendOf(id),
      };
    }
    const cached = seriesCache.get(id);
    if (cached && now() - cached.savedAt < SERIES_TTL_MS)
      return {
        id,
        points: cached.points,
        partial: false,
        trend: trendOf(id),
      };
    if (provider === 'eccc' && !eccc.register?.has(code)) return null;
    const { promise } = coalesceProxyRequest(
      inFlight,
      `series:${id}`,
      async () =>
        provider === 'eccc'
          ? normalizeEcccSeries(
              await upstream(
                ecccSeriesUrl(code, now() - HISTORY_SPAN_MS),
                4 * MIB,
                20_000,
              ),
            )
          : normalizePegelonlineSeries(
              await upstream(pegelonlineMeasurementsUrl(code), 2 * MIB, 20_000),
            ),
    );
    const points = await promise;
    seriesCache.delete(id);
    seriesCache.set(id, { savedAt: now(), points });
    while (seriesCache.size > SERIES_CACHE_MAX)
      seriesCache.delete(seriesCache.keys().next().value);
    // The 72 h series gives the gauge its trend before two polls have passed.
    remember(id, points);
    return { id, points, partial: false, trend: trendOf(id) };
  }

  async function handler(req, res) {
    const json = (status, value) => {
      if (res.destroyed) return;
      res.writeHead(status, {
        'Content-Type': 'application/json',
        'Cache-Control': 'no-store',
        ...(status === 405 ? { Allow: 'GET' } : {}),
        ...(status === 429 ? { 'Retry-After': '60' } : {}),
      });
      res.end(JSON.stringify(value));
    };
    if (admitSameSiteKeyless(req, res)) return;
    if (req.method !== 'GET') return json(405, { error: 'method_not_allowed' });
    const path = (req.url || '/').split('?')[0];
    if (!allow(clientKey(req))) return json(429, { error: 'rate_limited' });
    try {
      if (path === '/' || path === '') {
        const value = await snapshot();
        if (!value.stations.length)
          return json(502, { error: 'river_levels_unavailable' });
        return json(200, value);
      }
      const match = STATION_PATH.exec(path);
      if (!match) return json(404, { error: 'unknown_route' });
      const [provider, code] = match[1].split('/');
      const value = await series(provider, code);
      if (!value) return json(404, { error: 'unknown_station' });
      return json(200, value);
    } catch {
      return json(502, { error: 'river_levels_unavailable' });
    }
  }

  return {
    name: 'river-levels',
    configureServer({ middlewares }) {
      middlewares.use('/api/river-levels', handler);
    },
    configurePreviewServer({ middlewares }) {
      middlewares.use('/api/river-levels', handler);
    },
  };
}
