import {
  classifyRiverLevel,
  cleanReferences,
} from '../../../src/layers/riverLevels/model.js';

/**
 * Environment and Climate Change Canada (Water Survey of Canada) hydrometric
 * data from the MSC GeoMet OGC API, keyless, under the ECCC Data Servers
 * End-use Licence:
 * - `hydrometric-stations`: the active real-time gauges, with position;
 * - `hydrometric-realtime`: provisional 5-minute water levels (metres), of
 *   which the last 90 minutes cover nearly every reporting gauge;
 * - `hydrometric-annual-statistics`: each year's lowest and highest daily
 *   mean level from the archived HYDAT record, quality controlled.
 *
 * ECCC publishes no flood stages here. A gauge's references are the means of
 * its yearly lowest and highest daily levels since 2006, the same kind of
 * value as PEGELONLINE's MNW and MHW; extremes are not published as records,
 * because an instantaneous reading can pass a daily-mean record without
 * being one.
 */
const GEOMET = 'https://api.weather.gc.ca/collections';
/** Server page size limit. */
export const ECCC_PAGE_SIZE = 10_000;
/** Pages read at most per collection, a guard against a runaway paging loop. */
export const ECCC_MAX_PAGES = 8;
/** Annual statistics from this year on: recent datums, recent climate. */
export const ECCC_STATS_FROM_YEAR = 2006;
/** Years a gauge needs before its means are used. */
const STATS_MIN_YEARS = 5;
/** The snapshot asks for readings this recent. */
export const ECCC_REALTIME_WINDOW_MS = 90 * 60_000;

const CODE = /^[0-9]{2}[A-Z]{2}[0-9]{3}$/;

const itemsUrl = (collection, params) =>
  `${GEOMET}/${collection}/items?` +
  new URLSearchParams({ f: 'json', limit: String(ECCC_PAGE_SIZE), ...params });

/** Active real-time gauges, with position. One page holds them all. */
export const ECCC_STATIONS_URL = itemsUrl('hydrometric-stations', {
  REAL_TIME: '1',
  STATUS_EN: 'Active',
  properties: 'STATION_NUMBER,STATION_NAME,PROV_TERR_STATE_LOC',
});

/** One page of yearly daily-mean level extremes, in a stable order. */
export function ecccStatsUrl(offset = 0) {
  return itemsUrl('hydrometric-annual-statistics', {
    DATA_TYPE_EN: 'Water Level',
    datetime: `${ECCC_STATS_FROM_YEAR}-01-01T00:00:00Z/..`,
    properties: 'STATION_NUMBER,MIN_VALUE,MAX_VALUE',
    skipGeometry: 'true',
    sortby: 'IDENTIFIER',
    offset: String(offset),
  });
}

/** One page of real-time readings since `sinceMs`, in a stable order. */
export function ecccRealtimeUrl(sinceMs, offset = 0) {
  return itemsUrl('hydrometric-realtime', {
    datetime: `${new Date(sinceMs).toISOString().replace(/\.\d{3}Z$/, 'Z')}/..`,
    properties: 'STATION_NUMBER,DATETIME,LEVEL',
    skipGeometry: 'true',
    sortby: 'IDENTIFIER',
    offset: String(offset),
  });
}

/** One gauge's readings since `sinceMs`, for its card. */
export function ecccSeriesUrl(code, sinceMs) {
  if (!CODE.test(String(code))) throw new Error('invalid_station');
  return itemsUrl('hydrometric-realtime', {
    STATION_NUMBER: code,
    datetime: `${new Date(sinceMs).toISOString().replace(/\.\d{3}Z$/, 'Z')}/..`,
    properties: 'DATETIME,LEVEL',
    skipGeometry: 'true',
    sortby: 'DATETIME',
  });
}

/** Features of one page, or an error for anything else. */
export function ecccFeatures(payload) {
  if (!payload || !Array.isArray(payload.features))
    throw new Error('invalid_page');
  return payload.features;
}

/** A number from a JSON value; null, '' and absent are not 0. */
const num = (value) =>
  value === null || value === undefined || value === '' ? NaN : Number(value);

// Joining words stay lower case, in English and in Quebec's French names.
const SMALL_WORDS = new Set([
  'at',
  'near',
  'above',
  'below',
  'of',
  'and',
  'a',
  'au',
  'aux',
  'de',
  'des',
  'du',
  'la',
  'le',
  'les',
  'en',
  'pres',
]);
const title = (text) =>
  String(text || '')
    .toLowerCase()
    .replace(/(^|[\s\-(/.'])(\p{L})/gu, (_, sep, ch) => sep + ch.toUpperCase())
    .replace(/\b(\p{L}+)\b/gu, (word, _w, at) =>
      at > 0 && SMALL_WORDS.has(word.toLowerCase()) ? word.toLowerCase() : word,
    );

// "SOUTH SASKATCHEWAN RIVER AT MEDICINE HAT" → "South Saskatchewan River".
const PLACE_WORDS =
  /\s+(AT|NEAR|ABOVE|BELOW|UPSTREAM OF|DOWNSTREAM OF|AT OUTLET OF|AT THE OUTLET OF|A|AU|EN AVAL DE|EN AMONT DE|PRES DE|EN AVAL DU|EN AMONT DU)\s+/;

/** The waterbody part of a station name, title-cased, or ''. */
export function ecccRiverName(stationName) {
  const name = String(stationName || '').trim();
  const match = PLACE_WORDS.exec(name);
  return title(match ? name.slice(0, match.index) : '');
}

/**
 * Register features → Map(code → {code, name, river, province, lat, lon}).
 * @param {Array<object>} features
 */
export function normalizeEcccRegister(features) {
  const out = new Map();
  for (const feature of features || []) {
    const p = feature?.properties || {};
    const code = String(p.STATION_NUMBER || '');
    if (!CODE.test(code)) continue;
    const [lon, lat] = feature.geometry?.coordinates || [];
    if (
      !Number.isFinite(lat) ||
      !Number.isFinite(lon) ||
      Math.abs(lat) > 90 ||
      Math.abs(lon) > 180
    )
      continue;
    out.set(code, {
      code,
      name: title(p.STATION_NAME) || code,
      river: ecccRiverName(p.STATION_NAME),
      province: String(p.PROV_TERR_STATE_LOC || '').slice(0, 3) || null,
      lat,
      lon,
    });
  }
  return out;
}

const mean = (values) => values.reduce((s, v) => s + v, 0) / values.length;

/**
 * Annual statistics features → Map(code → {low, high, min, max}): the means
 * of the yearly lowest and highest daily levels, and the span they come from
 * (used only to catch a reading on another datum).
 * @param {Array<object>} features
 */
export function normalizeEcccStats(features) {
  const byCode = new Map();
  for (const feature of features || []) {
    const p = feature?.properties || {};
    const code = String(p.STATION_NUMBER || '');
    if (!CODE.test(code)) continue;
    let years = byCode.get(code);
    if (!years) byCode.set(code, (years = { mins: [], maxs: [] }));
    const min = num(p.MIN_VALUE);
    const max = num(p.MAX_VALUE);
    if (Number.isFinite(min)) years.mins.push(min);
    if (Number.isFinite(max)) years.maxs.push(max);
  }
  const out = new Map();
  for (const [code, { mins, maxs }] of byCode) {
    if (mins.length < STATS_MIN_YEARS || maxs.length < STATS_MIN_YEARS)
      continue;
    const low = mean(mins);
    const high = mean(maxs);
    if (!(high > low)) continue;
    out.set(code, {
      low: Math.round(low * 1000) / 1000,
      high: Math.round(high * 1000) / 1000,
      min: Math.min(...mins),
      max: Math.max(...maxs),
    });
  }
  return out;
}

/**
 * The references for a reading, or none when the reading cannot be on the
 * archive's datum: further below its lowest or above its highest daily level
 * than the whole archived range (a gauge moved to a geodetic datum, say).
 */
export function ecccReferences(level, stats) {
  if (!stats || !Number.isFinite(level)) return {};
  const span = stats.max - stats.min;
  if (level < stats.min - span || level > stats.max + span) return {};
  return cleanReferences({ low: stats.low, high: stats.high });
}

/**
 * Real-time features → Map(code → [[epochMs, metres], …]) in time order.
 * @param {Array<object>} features
 */
export function normalizeEcccReadings(features) {
  const out = new Map();
  for (const feature of features || []) {
    const p = feature?.properties || {};
    const code = String(p.STATION_NUMBER || '');
    if (!CODE.test(code)) continue;
    const at = Date.parse(p.DATETIME);
    const level = num(p.LEVEL);
    if (!Number.isFinite(at) || !Number.isFinite(level)) continue;
    let points = out.get(code);
    if (!points) out.set(code, (points = []));
    points.push([at, level]);
  }
  for (const points of out.values()) points.sort((a, b) => a[0] - b[0]);
  return out;
}

/**
 * Join readings to the register and statistics → shared station shape.
 * @param {Map<string, object>} register
 * @param {Map<string, object>|null} stats
 * @param {Map<string, Array<[number, number]>>} readings
 */
export function buildEcccStations(register, stats, readings) {
  const out = [];
  for (const [code, points] of readings) {
    const gauge = register.get(code);
    const newest = points.at(-1);
    if (!gauge || !newest) continue;
    const [observedMs, level] = newest;
    const refs = ecccReferences(level, stats?.get(code));
    out.push({
      id: `eccc:${code}`,
      provider: 'eccc',
      code,
      name: gauge.name,
      river: gauge.river,
      lat: gauge.lat,
      lon: gauge.lon,
      level,
      observedMs,
      refs,
      band: classifyRiverLevel(level, refs),
    });
  }
  return out;
}

/** A gauge's series features → [[epochMs, metres], …] in time order. */
export function normalizeEcccSeries(payload) {
  return ecccFeatures(payload)
    .map((f) => [
      Date.parse(f?.properties?.DATETIME),
      num(f?.properties?.LEVEL),
    ])
    .filter(([at, level]) => Number.isFinite(at) && Number.isFinite(level))
    .sort((a, b) => a[0] - b[0]);
}
