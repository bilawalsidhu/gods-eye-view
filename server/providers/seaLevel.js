/**
 * IOC Sea Level Station Monitoring Facility (UNESCO-IOC and the Flanders
 * Marine Institute, VLIZ): measured water level at tide gauges worldwide.
 *
 * The facility's station list (about 2.4 MB) has one row per sensor, several
 * sensors per station, and already carries each sensor's last value and time.
 * The server reads it at most every 10 minutes (single flight) and trims it to
 * one entry per station: its primary water-level sensor, chosen by
 * `chooseSeaLevelSensor`. When a read fails the previous snapshot is served,
 * marked stale, for up to 6 hours; after that, or with none yet, the route
 * answers 503. A failed read is not repeated for one minute.
 *
 * Routes (GET or HEAD only; the browser never names an upstream URL):
 *   /api/sea-level/stations        the trimmed snapshot
 *   /api/sea-level/station/<code>  the last 72 hours of one station's primary
 *                                  sensor, cached 10 minutes
 *
 * Levels are raw and not quality controlled, and each gauge measures against
 * its own local datum: a level means nothing next to another station's.
 * Dataset licence CC BY-NC 4.0, DOI 10.14284/482.
 */
import { readResponseJsonCapped, coalesceProxyRequest } from './common/http.js';
import { makeRateLimiter, clientKey } from './common/rate-limit.js';

export const IOC_SERVICE = 'https://www.ioc-sealevelmonitoring.org/service.php';
export const SEA_LEVEL_REFRESH_MS = 10 * 60_000;
/** How long the last good snapshot may stand in for a failed read. */
export const SEA_LEVEL_STALE_MAX_MS = 6 * 60 * 60_000;
export const SEA_LEVEL_RETRY_AFTER_FAILURE_MS = 60_000;
export const SEA_LEVEL_SERIES_TTL_MS = 10 * 60_000;
export const SEA_LEVEL_SERIES_HOURS = 72;
/** Series points kept for the card: one per 10-minute bin over 72 hours. */
export const SEA_LEVEL_SERIES_BIN_MS = 10 * 60_000;
const LIST_TIMEOUT_MS = 30_000;
const SERIES_TIMEOUT_MS = 20_000;
/** The list is ~2.4 MB; anything far past that is not a station list. */
const LIST_MAX_BYTES = 16 * 1024 * 1024;
/** 72 hours at the fastest 15 s sampling is ~1 MB. */
const SERIES_MAX_BYTES = 4 * 1024 * 1024;
const SERIES_CACHE_MAX = 256;
const SERIES_IN_FLIGHT_MAX = 16;
/** A reading dated further ahead than this has a broken clock. */
const FUTURE_SLACK_MS = 60 * 60_000;
const USER_AGENT = 'gods-eye-view-sea-level-proxy/1.0';

/**
 * IOC station codes: letters and digits, at most 5 in the list today
 * (`hoek`, `NA23`, `CanMa`). The facility matches them without regard to
 * case, so the proxy keeps them lower-case.
 */
export const SEA_LEVEL_CODE = /^[a-z0-9]{1,10}$/;
const SENSOR_ID = /^[a-z0-9]{2,6}$/;

/** Sensors in the list that do not measure water level. */
const NON_LEVEL_SENSORS = new Set(['bat', 'atm']);
/**
 * Units of water-level rows. `M` is metres; the few `F` rows (Japan,
 * Barbados) carry values on the same metre scale as their series.
 */
const LEVEL_UNITS = new Set(['M', 'F']);
/**
 * Tie-break between sensors whose last readings share a time: radar and
 * the facility's primary water-level channels first, pressure and backup
 * channels after. A sensor not listed ranks after these, by id.
 */
export const SEA_LEVEL_SENSOR_PREFERENCE = Object.freeze([
  'rad',
  'pwl',
  'flt',
  'enc',
  'aqu',
  'bub',
  'wls',
  'ra2',
  'ras',
  'prs',
  'prt',
  'pr1',
  'pr2',
  'ecs',
  'bwl',
  'stp',
]);
const PREFERENCE = new Map(SEA_LEVEL_SENSOR_PREFERENCE.map((s, i) => [s, i]));

/** Whether `sensor` is a water-level sensor id. */
export function isSeaLevelSensor(sensor) {
  return (
    typeof sensor === 'string' &&
    SENSOR_ID.test(sensor) &&
    !NON_LEVEL_SENSORS.has(sensor)
  );
}

/**
 * A station code as the proxy uses it (lower case), or null.
 * @param {unknown} value
 */
export function seaLevelCode(value) {
  const code = typeof value === 'string' ? value.trim().toLowerCase() : '';
  return SEA_LEVEL_CODE.test(code) ? code : null;
}

const IOC_TIME =
  /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})(?::(\d{2})(?:\.\d{1,7})?)?$/;

/**
 * Epoch ms for an IOC time ("2026-10-24 20:20:00.000"), which is UTC with no
 * zone mark; null for anything else, including impossible dates.
 */
export function parseIocTime(value) {
  const m = typeof value === 'string' ? IOC_TIME.exec(value.trim()) : null;
  if (!m) return null;
  const [y, mo, d, h, mi, s] = m.slice(1).map((part) => Number(part ?? 0));
  const ms = Date.UTC(y, mo - 1, d, h, mi, s);
  const back = new Date(ms);
  return back.getUTCFullYear() === y &&
    back.getUTCMonth() === mo - 1 &&
    back.getUTCDate() === d &&
    h < 24 &&
    mi < 60 &&
    s < 60
    ? ms
    : null;
}

/** A level in metres, or null for missing values and the -999 sentinel. */
export function iocLevel(value) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= -999)
    return null;
  return Math.round(value * 1000) / 1000;
}

/**
 * Order two candidate sensors of one station: the more recent last reading
 * first (a sensor with none, or only -999, last), then SEA_LEVEL_SENSOR_PREFERENCE, then
 * the sensor id. Negative when `a` is the better choice.
 */
export function compareSeaLevelSensors(a, b) {
  const at = a.lastMs ?? -Infinity;
  const bt = b.lastMs ?? -Infinity;
  if (at !== bt) return bt - at;
  const ap = PREFERENCE.get(a.sensor) ?? PREFERENCE.size;
  const bp = PREFERENCE.get(b.sensor) ?? PREFERENCE.size;
  if (ap !== bp) return ap - bp;
  return a.sensor < b.sensor ? -1 : a.sensor > b.sensor ? 1 : 0;
}

/** The primary sensor among one station's candidates (see the comparator). */
export function chooseSeaLevelSensor(candidates) {
  return [...candidates].sort(compareSeaLevelSensors)[0] || null;
}

const text = (value, max) => {
  const s = typeof value === 'string' ? value.trim() : '';
  return s ? s.slice(0, max) : null;
};

/**
 * One list row as a sensor candidate, or null when it is not a water-level
 * sensor of a station with a valid code and position.
 * @param {object} raw List row.
 * @param {number} nowMs Server time, to refuse readings dated in the future.
 */
export function normalizeSeaLevelRow(raw, nowMs) {
  const code = seaLevelCode(raw?.Code);
  if (!code) return null;
  const lat = Number(raw?.Lat ?? raw?.lat);
  const lon = Number(raw?.Lon ?? raw?.lon);
  if (
    raw?.Lat === null ||
    raw?.Lon === null ||
    !Number.isFinite(lat) ||
    !Number.isFinite(lon) ||
    Math.abs(lat) > 90 ||
    Math.abs(lon) > 180
  )
    return null;
  const sensor = typeof raw?.sensor === 'string' ? raw.sensor.trim() : '';
  const units = typeof raw?.units === 'string' ? raw.units.trim() : '';
  if (!isSeaLevelSensor(sensor) || !LEVEL_UNITS.has(units.toUpperCase()))
    return null;
  // A reading is a time and a value: a sensor sending -999 is not reporting
  // a level, and one dated far ahead has a broken clock.
  const lastValue = iocLevel(raw?.lastvalue);
  let lastMs = lastValue === null ? null : parseIocTime(raw?.lasttime);
  if (lastMs !== null && lastMs > nowMs + FUTURE_SLACK_MS) lastMs = null;
  return {
    code,
    name: text(raw?.Location, 120) || code,
    country: text(raw?.countryname, 60),
    lat: Math.round(lat * 1e4) / 1e4,
    lon: Math.round(lon * 1e4) / 1e4,
    sensor,
    lastMs,
    lastValue: lastMs === null ? null : lastValue,
  };
}

/**
 * Trim the IOC station list to one entry per station code, sorted by code.
 * Rows that are not water-level sensors, or lack a valid code or position,
 * are dropped; a station left with no water-level sensor is dropped too.
 * `ageMs` is how long before `nowMs` the last reading was taken (null when
 * the sensor has none).
 * @param {unknown} rows Parsed station list.
 * @param {number} nowMs Server time.
 * @returns {Array<object>|null} Stations, or null when `rows` is not a list.
 */
export function normalizeSeaLevelStationList(rows, nowMs) {
  if (!Array.isArray(rows)) return null;
  const byCode = new Map();
  for (const raw of rows) {
    const row = normalizeSeaLevelRow(raw, nowMs);
    if (!row) continue;
    const list = byCode.get(row.code);
    if (list) list.push(row);
    else byCode.set(row.code, [row]);
  }
  return [...byCode.keys()].sort().map((code) => {
    const row = chooseSeaLevelSensor(byCode.get(code));
    return {
      code,
      name: row.name,
      country: row.country,
      lat: row.lat,
      lon: row.lon,
      sensor: row.sensor,
      lastIso: row.lastMs === null ? null : new Date(row.lastMs).toISOString(),
      lastValue: row.lastValue,
      ageMs: row.lastMs === null ? null : Math.max(0, nowMs - row.lastMs),
    };
  });
}

/** "YYYY-MM-DDTHH:MM" in UTC, the form the IOC data query takes. */
function iocQueryTime(ms) {
  return new Date(ms).toISOString().slice(0, 16);
}

/** The IOC station-list URL. */
export function seaLevelListUrl() {
  return `${IOC_SERVICE}?query=stationlist&showall=all`;
}

/**
 * The IOC data URL for the last 72 hours of one validated station code.
 * @param {string} code Lower-case code (SEA_LEVEL_CODE).
 * @param {number} nowMs End of the window.
 */
export function seaLevelSeriesUrl(code, nowMs) {
  if (!SEA_LEVEL_CODE.test(code)) throw new TypeError('invalid_code');
  const q = new URLSearchParams({
    query: 'data',
    code,
    timestart: iocQueryTime(nowMs - SEA_LEVEL_SERIES_HOURS * 3_600_000),
    timestop: iocQueryTime(nowMs),
    format: 'json',
  });
  return `${IOC_SERVICE}?${q}`;
}

/**
 * Trim one station's IOC series to its primary sensor (the one with the most
 * recent reading, ties as in compareSeaLevelSensors) over the window ending
 * at `nowMs`. `min`, `max` and `latest` come from every raw reading; `points`
 * are 10-minute bin means, `[epochMs, metres]`, for the card's plot.
 * @param {unknown} rows Parsed IOC data answer.
 * @param {string} code Station code.
 * @param {number} nowMs End of the window.
 * @returns {object|null} Null when `rows` is not a list.
 */
export function normalizeSeaLevelSeries(rows, code, nowMs) {
  if (!Array.isArray(rows)) return null;
  const from = nowMs - SEA_LEVEL_SERIES_HOURS * 3_600_000;
  const bySensor = new Map();
  for (const raw of rows) {
    const sensor = typeof raw?.sensor === 'string' ? raw.sensor.trim() : '';
    if (!isSeaLevelSensor(sensor)) continue;
    const ms = parseIocTime(raw?.stime);
    const value = iocLevel(raw?.slevel);
    if (ms === null || value === null) continue;
    if (ms < from || ms > nowMs + FUTURE_SLACK_MS) continue;
    const list = bySensor.get(sensor);
    if (list) list.push([ms, value]);
    else bySensor.set(sensor, [[ms, value]]);
  }
  const empty = {
    code,
    sensor: null,
    from: new Date(from).toISOString(),
    to: new Date(nowMs).toISOString(),
    count: 0,
    min: null,
    max: null,
    latest: null,
    points: [],
  };
  if (!bySensor.size) return empty;
  const chosen = chooseSeaLevelSensor(
    [...bySensor].map(([sensor, readings]) => ({
      sensor,
      lastMs: readings.reduce(
        (latest, [ms]) => Math.max(latest, ms),
        -Infinity,
      ),
    })),
  );
  const readings = bySensor.get(chosen.sensor).sort((a, b) => a[0] - b[0]);
  let min = Infinity;
  let max = -Infinity;
  const bins = new Map();
  for (const [ms, value] of readings) {
    if (value < min) min = value;
    if (value > max) max = value;
    const bin = Math.floor(ms / SEA_LEVEL_SERIES_BIN_MS);
    const sum = bins.get(bin);
    if (sum) {
      sum[0] += value;
      sum[1]++;
    } else bins.set(bin, [value, 1]);
  }
  const [lastMs, lastValue] = readings[readings.length - 1];
  return {
    ...empty,
    sensor: chosen.sensor,
    count: readings.length,
    min,
    max,
    latest: { iso: new Date(lastMs).toISOString(), value: lastValue },
    points: [...bins].map(([bin, [sum, n]]) => [
      (bin + 0.5) * SEA_LEVEL_SERIES_BIN_MS,
      Math.round((sum / n) * 1000) / 1000,
    ]),
  };
}

/**
 * The sea level store: the station snapshot and the series cache. All I/O is
 * injectable.
 */
export function createSeaLevelStore({
  fetchImpl = (...args) => globalThis.fetch(...args),
  now = () => Date.now(),
  log = console,
} = {}) {
  let built = null;
  let inflight = null;
  let lastFailureAt = -Infinity;
  const series = new Map();
  const seriesFlights = new Map();

  async function getJson(url, maxBytes, timeoutMs) {
    const signal = AbortSignal.timeout(timeoutMs);
    const response = await fetchImpl(url, {
      headers: { Accept: 'application/json', 'User-Agent': USER_AGENT },
      redirect: 'error',
      signal,
    });
    if (!response.ok) {
      await response.body?.cancel?.().catch?.(() => {});
      throw Object.assign(new Error(`IOC HTTP ${response.status}`), {
        status: response.status,
      });
    }
    return readResponseJsonCapped(response, maxBytes, signal);
  }

  async function refresh() {
    const rows = await getJson(
      seaLevelListUrl(),
      LIST_MAX_BYTES,
      LIST_TIMEOUT_MS,
    );
    const t = now();
    const stations = normalizeSeaLevelStationList(rows, t);
    // An answer with no station at all is a broken list, not an empty ocean.
    if (!stations?.length) throw new Error('Malformed IOC response');
    built = {
      snapshot: {
        source: 'IOC Sea Level Station Monitoring Facility (VLIZ)',
        generatedAt: new Date(t).toISOString(),
        stations,
      },
      at: t,
    };
    return built;
  }

  /**
   * The current snapshot, read again when 10 minutes old (one read at a
   * time). A failed read serves the previous snapshot as stale while it is
   * at most 6 hours old.
   * @returns {Promise<{snapshot: object, at: number, stale: boolean}|null>}
   */
  async function current() {
    const t = now();
    const fresh = built && t - built.at < SEA_LEVEL_REFRESH_MS;
    if (fresh) return { ...built, stale: false };
    if (!inflight && t - lastFailureAt >= SEA_LEVEL_RETRY_AFTER_FAILURE_MS) {
      inflight = refresh()
        .then(() => true)
        .catch((error) => {
          lastFailureAt = now();
          log.warn?.(
            '[SeaLevel] station list failed:',
            error?.message || error,
          );
          return false;
        })
        .finally(() => {
          inflight = null;
        });
    }
    const ok = inflight ? await inflight : false;
    if (ok && built) return { ...built, stale: false };
    if (built && now() - built.at <= SEA_LEVEL_STALE_MAX_MS)
      return { ...built, stale: true };
    return null;
  }

  /**
   * The last 72 hours of one validated station, cached for 10 minutes. A
   * failed read, or a full set of reads in flight, serves the cached answer
   * marked stale while it is at most 6 hours old.
   * @param {string} code Lower-case station code.
   */
  async function station(code) {
    if (!SEA_LEVEL_CODE.test(code)) throw new TypeError('invalid_code');
    const known = series.get(code);
    // Past the stale limit a cached series is not served at all.
    const cached =
      known && now() - known.at <= SEA_LEVEL_STALE_MAX_MS ? known : null;
    if (cached && now() - cached.at < SEA_LEVEL_SERIES_TTL_MS)
      return { value: cached.value, stale: false };
    if (
      !seriesFlights.has(code) &&
      seriesFlights.size >= SERIES_IN_FLIGHT_MAX
    ) {
      if (cached) return { value: cached.value, stale: true };
      throw Object.assign(new Error('busy'), { status: 429 });
    }
    try {
      const { promise } = coalesceProxyRequest(
        seriesFlights,
        code,
        async () => {
          const t = now();
          const rows = await getJson(
            seaLevelSeriesUrl(code, t),
            SERIES_MAX_BYTES,
            SERIES_TIMEOUT_MS,
          );
          const value = normalizeSeaLevelSeries(rows, code, t);
          if (!value) throw new Error('Malformed IOC response');
          series.delete(code);
          series.set(code, { value, at: now() });
          if (series.size > SERIES_CACHE_MAX)
            series.delete(series.keys().next().value);
          return value;
        },
      );
      return { value: await promise, stale: false };
    } catch (error) {
      if (cached) return { value: cached.value, stale: true };
      throw error;
    }
  }

  return { current, refresh, station };
}

/**
 * Vite plugin for dev and preview: GET /api/sea-level/stations and
 * /api/sea-level/station/<code>.
 */
export function seaLevelProxy(options = {}) {
  const store = options.store || createSeaLevelStore(options);
  const now = options.now || (() => Date.now());
  const allow = makeRateLimiter({
    windowMs: 60_000,
    max: 120,
    globalMax: 2400,
  });

  async function handler(req, res) {
    const json = (status, value, extra = {}) => {
      if (res.destroyed) return;
      res.writeHead(status, {
        'Content-Type': 'application/json',
        'Cache-Control': 'no-store',
        ...extra,
      });
      res.end(req.method === 'HEAD' ? undefined : JSON.stringify(value));
    };
    if (req.method !== 'GET' && req.method !== 'HEAD')
      return json(405, { error: 'method_not_allowed' }, { Allow: 'GET, HEAD' });
    const path = String(req.url || '/').split('?')[0];
    const stationRoute = /^\/station\/([^/]*)$/.exec(path);
    if (path !== '/stations' && !stationRoute)
      return json(404, { error: 'not_found' });
    let code = null;
    if (stationRoute) {
      // Validated before any upstream call: the code is the only client input.
      code = seaLevelCode(stationRoute[1]);
      if (!code || code !== stationRoute[1].toLowerCase())
        return json(400, { error: 'invalid_code' });
    }
    if (!allow(clientKey(req)))
      return json(429, { error: 'rate_limited' }, { 'Retry-After': '60' });

    if (code) {
      try {
        const { value, stale } = await store.station(code);
        return json(
          200,
          { ...value, stale },
          stale ? { 'X-Data-Stale': 'true' } : {},
        );
      } catch (error) {
        return error?.status === 429
          ? json(429, { error: 'busy' }, { 'Retry-After': '10' })
          : json(502, { error: 'sea_level_unavailable' });
      }
    }

    let built = null;
    try {
      built = await store.current();
    } catch {
      built = null;
    }
    if (!built)
      return json(
        503,
        { error: 'sea_level_unavailable' },
        { 'Retry-After': '60' },
      );
    // How old the snapshot is on this server's clock, so the browser can age
    // each reading without comparing its clock to ours.
    json(
      200,
      {
        ...built.snapshot,
        stale: built.stale,
        snapshotAgeMs: Math.max(0, now() - built.at),
      },
      {
        'X-Snapshot-Generated-At': built.snapshot.generatedAt,
        ...(built.stale ? { 'X-Data-Stale': 'true' } : {}),
      },
    );
  }

  return {
    name: 'sea-level',
    configureServer({ middlewares }) {
      middlewares.use('/api/sea-level', handler);
    },
    configurePreviewServer({ middlewares }) {
      middlewares.use('/api/sea-level', handler);
    },
    store,
  };
}
