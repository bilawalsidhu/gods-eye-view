/**
 * The US AQI of a station, computed from its concentrations. Pure and
 * portable: no network, scene or UI imports.
 *
 * Method and breakpoints: US EPA, Technical Assistance Document for the
 * Reporting of Daily Air Quality - the Air Quality Index (AQI), Table 6 and
 * Equation 1 (PM2.5 breakpoints as revised in 2024):
 * https://document.airnow.gov/technical-assistance-document-for-the-reporting-of-daily-air-quailty.pdf
 *
 * Each pollutant's concentration is truncated as the document says, placed in
 * its row of the table and interpolated linearly within that row; the index
 * is the highest sub-index, rounded. Above the table's top row an index runs
 * on past 500 in the hazardous row, as the document asks.
 *
 * Each row of the table is for one averaging period, and a value is rated
 * only on its own (`aqiStations`), as the document's real-time reporting does
 * it: PM2.5 and PM10 on their NowCast (or a 24-hour average), ozone on its
 * NowCast (or an 8-hour average) on the 8-hour rows, CO on an 8-hour
 * average, NO2 and SO2 on 1-hour values (`nowcast.js`). Where the document
 * gives 1-hour rules they are followed: ozone's 1-hour rows apply to the
 * current hour's mean from 0.125 ppm and the higher index is kept (Table 6,
 * note 1); above 0.200 ppm, where the 8-hour rows end, only the 1-hour rows
 * rate (note 2), and without a 1-hour value the index holds at 300. A
 * 1-hour SO2 value of 305 ppb or more gives exactly 200 unless a 24-hour
 * average of 305 ppb or more rates on the 24-hour rows (note 3 and
 * "Calculating AQI values for SO2").
 *
 * Values are in µg/m³, CO in mg/m³: the layer's units (`units.js`). Gases
 * convert back to ppb (CO to ppm) at 25 °C, the EPA's reference conditions.
 */
import { AIR_QUALITY_UNRATED_COLOR } from './model.js';
import { EPA_GAS_FACTORS, concentrationIn } from './units.js';
import {
  HOUR_MS,
  OZONE_SERIES_HOURS,
  PM_NOWCAST_HOURS,
  eightHourMean,
  hourlySeries,
  ozoneNowCast,
  pmNowCast,
} from './nowcast.js';

/** The five upper limits between the six categories. */
export const US_AQI_LIMITS = Object.freeze([50, 100, 150, 200, 300]);

/**
 * The six categories, in the EPA's names and standard colours (Tables 1 and
 * 2). A portable export, so no i18n here: the labels stay English data and
 * the layer translates them when it shows them.
 */
export const US_AQI_BANDS = Object.freeze([
  // i18n-ignore: EPA category; translated in layer presentation
  { id: 'good', label: 'Good', color: '#00e400' },
  // i18n-ignore: EPA category; translated in layer presentation
  { id: 'moderate', label: 'Moderate', color: '#ffff00' },
  {
    id: 'sensitive',
    // i18n-ignore: EPA category; translated in layer presentation
    label: 'Unhealthy for Sensitive Groups',
    // The pollutant tile card shows this short form; the legend the label.
    // i18n-ignore: EPA category; translated in layer presentation
    short: 'Sensitive groups',
    color: '#ff7e00',
  },
  // i18n-ignore: EPA category; translated in layer presentation
  { id: 'unhealthy', label: 'Unhealthy', color: '#ff0000' },
  // i18n-ignore: EPA category; translated in layer presentation
  { id: 'very-unhealthy', label: 'Very Unhealthy', color: '#8f3f97' },
  // i18n-ignore: EPA category; translated in layer presentation
  { id: 'hazardous', label: 'Hazardous', color: '#7e0023' },
]);

/** The layer's pollutant ids, as the keys of a station's `values`. */
export const AQI_POLLUTANTS = Object.freeze({
  'PM2.5': 'pm25',
  PM10: 'pm10',
  O3: 'o3',
  NO2: 'no2',
  SO2: 'so2',
  CO: 'co',
});
/** A `values` key as the layer's pollutant id. */
export const AQI_PARAMETERS = Object.freeze(
  Object.fromEntries(
    Object.entries(AQI_POLLUTANTS).map(([parameter, key]) => [key, parameter]),
  ),
);

/**
 * Above these (µg/m³; CO mg/m³) a value is taken to be an instrument fault.
 * Each sits at least twice above the concentration its table puts at 500
 * (Table 6, note 4: O3 1-hour 0.604 ppm = 1,186 µg/m³, PM2.5 325.4 and PM10
 * 604 µg/m³, CO 50.4 ppm = 57.7 mg/m³, SO2 1,004 ppb = 2,630 µg/m³, NO2
 * 2,049 ppb = 3,856 µg/m³), so a hazardous reading past the table's top
 * keeps its index above 500; only values no outdoor air reaches are left out.
 */
export const AQI_CEILINGS = Object.freeze({
  pm25: 3000,
  pm10: 20_000,
  o3: 2400,
  no2: 8000,
  so2: 6000,
  co: 200,
});

/** A value this much older than the station's newest one is not used. */
export const AQI_MAX_SPREAD_MS = 3 * 3600_000;

/**
 * Table 6 by pollutant: decimals kept by truncation, and rows of
 * [concentration low, high, index low, high]. PM in µg/m³, O3 and CO in ppm,
 * SO2 and NO2 in ppb.
 */
const TABLE = Object.freeze({
  pm25: {
    digits: 1,
    rows: [
      [0, 9.0, 0, 50],
      [9.1, 35.4, 51, 100],
      [35.5, 55.4, 101, 150],
      [55.5, 125.4, 151, 200],
      [125.5, 225.4, 201, 300],
      [225.5, 325.4, 301, 500],
    ],
  },
  pm10: {
    digits: 0,
    rows: [
      [0, 54, 0, 50],
      [55, 154, 51, 100],
      [155, 254, 101, 150],
      [255, 354, 151, 200],
      [355, 424, 201, 300],
      [425, 604, 301, 500],
    ],
  },
  // 8-hour rows, defined up to 0.200 ppm; the 1-hour rows are `OZONE_HOURLY`.
  o3: {
    digits: 3,
    rows: [
      [0, 0.054, 0, 50],
      [0.055, 0.07, 51, 100],
      [0.071, 0.085, 101, 150],
      [0.086, 0.105, 151, 200],
      [0.106, 0.2, 201, 300],
    ],
  },
  no2: {
    digits: 0,
    rows: [
      [0, 53, 0, 50],
      [54, 100, 51, 100],
      [101, 360, 101, 150],
      [361, 649, 151, 200],
      [650, 1249, 201, 300],
      [1250, 2049, 301, 500],
    ],
  },
  // 1-hour rows; from 305 ppb the table is on 24-hour values (`SO2_DAILY`).
  so2: {
    digits: 0,
    rows: [
      [0, 35, 0, 50],
      [36, 75, 51, 100],
      [76, 185, 101, 150],
      [186, 304, 151, 200],
    ],
  },
  co: {
    digits: 1,
    rows: [
      [0, 4.4, 0, 50],
      [4.5, 9.4, 51, 100],
      [9.5, 12.4, 101, 150],
      [12.5, 15.4, 151, 200],
      [15.5, 30.4, 201, 300],
      [30.5, 50.4, 301, 500],
    ],
  },
});
/** Table 6's 1-hour ozone rows, in ppm (none below 0.125 ppm). */
const OZONE_HOURLY = Object.freeze([
  [0.125, 0.164, 101, 150],
  [0.165, 0.204, 151, 200],
  [0.205, 0.404, 201, 300],
  [0.405, 0.604, 301, 500],
]);

/** Table 6's 24-hour SO2 rows, in ppb (only from 305 ppb). */
const SO2_DAILY = Object.freeze([
  [305, 604, 201, 300],
  [605, 1004, 301, 500],
]);

/** Truncate to `digits` decimals; a tolerance absorbs unit-conversion error. */
const truncate = (value, digits) => {
  const scale = 10 ** digits;
  return Math.floor(value * scale + 1e-6) / scale;
};

/** Equation 1 in one row; above the row it continues on the same line. */
const interpolate = (c, [low, high, indexLow, indexHigh]) =>
  ((indexHigh - indexLow) / (high - low)) * (c - low) + indexLow;

/** Equation 1 in the row holding `c`, or past the last row. */
const onRows = (c, rows) =>
  interpolate(c, rows.find((row) => c <= row[1]) ?? rows.at(-1));

/** A concentration in the table's units, truncated, from the layer's units. */
function tableConcentration(key, value) {
  const factor = EPA_GAS_FACTORS[AQI_PARAMETERS[key]];
  const native = !factor ? value : (value / factor) * (key === 'o3' ? 1e-3 : 1);
  return truncate(native, TABLE[key].digits);
}

/**
 * One pollutant's sub-index before rounding. `hour` is ozone's 1-hour mean
 * and `day` SO2's 24-hour average, where known.
 */
function subIndex(key, value, { hour, day } = {}) {
  const c = tableConcentration(key, value);
  if (key === 'o3') {
    // The 8-hour rows end at 0.200 ppm: above, only the 1-hour rows rate,
    // and without a 1-hour value the index holds at 300.
    const eightHour = c <= 0.2 ? onRows(c, TABLE.o3.rows) : 300;
    const h = usable(hour) ? tableConcentration('o3', hour) : null;
    return h !== null && h >= OZONE_HOURLY[0][0]
      ? Math.max(eightHour, onRows(h, OZONE_HOURLY))
      : eightHour;
  }
  if (key === 'so2') {
    const d = usable(day) ? tableConcentration('so2', day) : null;
    const daily = d !== null && d >= SO2_DAILY[0][0] ? onRows(d, SO2_DAILY) : 0;
    // 1-hour SO2 values do not define 200 and above: fixed at 200, unless
    // a 24-hour average rates higher.
    return Math.max(c >= 305 ? 200 : onRows(c, TABLE.so2.rows), daily);
  }
  return onRows(c, TABLE[key].rows);
}

const usable = (value) => Number.isFinite(value) && value >= 0;

/**
 * The US AQI of one station's values, or null when none can be rated.
 * @param {{pm25?: number, pm10?: number, o3?: number, no2?: number, so2?: number, co?: number}} values
 *   µg/m³, CO in mg/m³, each on its table's averaging period: PM NowCast or
 *   24-hour, O3 NowCast or 8-hour, CO 8-hour, NO2 and SO2 1-hour.
 * @param {{hourValues?: {o3?: number}, dayValues?: {so2?: number}}} [extra]
 *   Ozone's 1-hour mean and SO2's 24-hour average, for their rows.
 * @returns {{index: number, leading: string} | null} The rounded index and
 *   the key of the pollutant that sets it.
 */
export function usAqi(values, { hourValues = {}, dayValues = {} } = {}) {
  let best = null;
  for (const key of Object.keys(TABLE)) {
    if (!usable(values?.[key])) continue;
    const index = Math.round(
      subIndex(key, values[key], {
        hour: hourValues?.[key],
        day: dayValues?.[key],
      }),
    );
    if (!best || index > best.index) best = { index, leading: key };
  }
  return best;
}

/**
 * PM2.5 is part of PM10, but the two are measured by separate instruments:
 * in smoke, where nearly all of PM10 is fine particles, PM2.5 can read a
 * little above PM10. Only above this much more is PM2.5 taken to be a fault.
 */
const pm25Ceiling = (pm10) => 1.5 * pm10 + 10;

function withinCeilings(values) {
  const kept = {};
  const excluded = {};
  for (const [key, ceiling] of Object.entries(AQI_CEILINGS)) {
    if (!usable(values?.[key])) continue;
    if (values[key] <= ceiling) kept[key] = values[key];
    else excluded[key] = 'implausible';
  }
  return { kept, excluded };
}

/** Leaves out a PM2.5 above its PM10's ceiling; true when it did. */
function dropPm25AbovePm10(kept, excluded) {
  if (
    kept.pm25 !== undefined &&
    kept.pm10 !== undefined &&
    kept.pm25 > pm25Ceiling(kept.pm10)
  ) {
    delete kept.pm25;
    excluded.pm25 = 'above-pm10';
    return true;
  }
  return false;
}

/**
 * The values of `kept` within AQI_MAX_SPREAD_MS of the newest of them, and
 * the keys of those older.
 */
function withinSpread(kept, valueTimes) {
  const times = Object.keys(kept)
    .map((key) => valueTimes[key])
    .filter(Number.isFinite);
  const newest = times.length ? Math.max(...times) : null;
  const fresh = { ...kept };
  const old = [];
  if (newest !== null)
    for (const key of Object.keys(kept))
      if (
        Number.isFinite(valueTimes[key]) &&
        valueTimes[key] < newest - AQI_MAX_SPREAD_MS
      ) {
        delete fresh[key];
        old.push(key);
      }
  return { fresh, old, newest };
}

/** Values within the fault ceilings and consistent with the station’s PM10. */
export function plausibility(values) {
  const result = withinCeilings(values);
  dropPm25AbovePm10(result.kept, result.excluded);
  return result;
}

/** The values of `extra` within their ceilings, for the keys in `used`. */
function extraWithin(extra, used) {
  const kept = {};
  for (const [key, value] of Object.entries(extra ?? {}))
    if (key in used && usable(value) && value <= AQI_CEILINGS[key])
      kept[key] = value;
  return kept;
}

/**
 * A station's index from the values it reports (`aqiStations`). The values
 * kept are within their ceilings and within AQI_MAX_SPREAD_MS of the newest.
 * PM2.5 is checked against the PM10 still kept; one left out does not count
 * as the newest. Ozone's 1-hour mean (`hourValues`) and SO2's 24-hour
 * average (`dayValues`) count with the value they go with. A station marked
 * `monitor: false` (a low-cost sensor) gets no index: the categories are
 * defined for reference and equivalent monitors.
 * @returns {{aqi: {index: number, leading: string} | null,
 *   used: object, excluded: Object<string, string>, observedMs: number|null}}
 *   `excluded` gives each value left out its reason: `'units'` or
 *   `'flagged'` (from the station), `'incomplete'` (an hour under 75 %
 *   covered), `'nowcast'` or `'hours'` (too few hours for its NowCast or
 *   8-hour average), `'averaging'` (not on its
 *   table's averaging period), `'sensor'` (a low-cost sensor),
 *   `'implausible'`, `'above-pm10'` or
 *   `'too-old'`.
 */
export function stationIndex({
  values,
  valueTimes = {},
  excluded = {},
  hourValues,
  dayValues,
  monitor,
} = {}) {
  // The EPA's categories are for reference and equivalent monitors: a
  // station its source marks as a low-cost sensor gets no index.
  if (monitor === false) {
    const reasons = { ...excluded };
    for (const key of Object.keys(values ?? {}))
      if (AQI_PARAMETERS[key]) reasons[key] = 'sensor';
    const times = Object.values(valueTimes ?? {}).filter(Number.isFinite);
    return {
      aqi: null,
      used: {},
      excluded: reasons,
      observedMs: times.length ? Math.max(...times) : null,
    };
  }
  const { kept, excluded: implausible } = withinCeilings(values);
  const reasons = { ...excluded, ...implausible };
  let spread = withinSpread(kept, valueTimes);
  if (dropPm25AbovePm10(spread.fresh, reasons)) {
    delete kept.pm25;
    spread = withinSpread(kept, valueTimes);
  }
  const { fresh, old, newest } = spread;
  for (const key of old) reasons[key] = 'too-old';
  const aqi = usAqi(fresh, {
    hourValues: extraWithin(hourValues, fresh),
    dayValues: extraWithin(dayValues, fresh),
  });
  const leadingTime = aqi ? valueTimes[aqi.leading] : undefined;
  return {
    aqi,
    used: fresh,
    excluded: reasons,
    observedMs: Number.isFinite(leadingTime) ? leadingTime : newest,
  };
}

/** The category of an index, or null. */
export function usAqiBand(index) {
  if (!Number.isFinite(index)) return null;
  return US_AQI_BANDS[US_AQI_LIMITS.filter((limit) => index > limit).length];
}

/** Per-pollutant fields a station reading in the AQI view does not carry. */
const POLLUTANT_FIELDS = [
  'id',
  'sensorId',
  'parameter',
  'scale',
  'units',
  'value',
  'label',
  'color',
  'note',
  'assessment',
  'rating',
  'rated',
  'aqi',
  'band',
  'averagingMinutes',
  'observedMs',
  'periodStart',
  'periodEnd',
  'coveragePercent',
  'qualityFlagged',
];

/**
 * Whether `a` replaces `b` as a pollutant's reading: the newer one; at the
 * same time a usable value before an unusable one, then the higher value
 * (or a flag before a unit problem), so the input order never decides.
 */
function newer(a, b) {
  if (!b || a.at !== b.at) return !b || a.at > b.at;
  if ((a.value === null) !== (b.value === null)) return a.value !== null;
  if (a.value !== null) return a.value > b.value;
  return a.reason === 'flagged' && b.reason !== 'flagged';
}

/** An hourly mean below this data coverage (45 minutes) counts as missing. */
const HOUR_MIN_COVERAGE = 75;

/**
 * The averaging periods, in minutes, each pollutant's table is rated on
 * from a single reading; `null` is a value whose period its source does not
 * state, taken as a 1-hour value for NO2 and SO2 only. Hourly means (60)
 * of particles, ozone and CO go through `nowcast.js` instead.
 */
const SINGLE_PERIODS = Object.freeze({
  pm25: [1440],
  pm10: [1440],
  o3: [480],
  co: [480],
  no2: [60, null],
  so2: [60, null],
});

/**
 * One pollutant's value for the index from its readings: `hours` (its
 * hourly means as `{endMs, value, reason, coverage}`) and `rows` (its other
 * readings, the newest kept per averaging period). The newest reading
 * decides, whether or not it can be rated: of the NowCast or 8-hour mean as
 * of the newest hourly mean and the readings on the table's own period, the
 * one with the latest time is taken (at the same time a usable value first,
 * then the higher). A newest reading that cannot be rated (flagged, in
 * units that do not convert, or a NowCast or 8-hour mean short of hours)
 * leaves the pollutant unrated with its reason; an older value does not
 * stand in. The one exception is SO2's 24-hour average, which a flagged
 * 1-hour value of its time does not discard.
 * @returns {{at, value, reason, averaging, method, coverage, hour, day}}
 */
function pollutantInput(key, hours, rows) {
  const candidates = [];
  let anchor = null;
  if (hours.length) {
    anchor = hours.reduce((a, b) => (newer(b, a) ? b : a));
    const valid = hours.filter((h) => h.value !== null);
    const at = anchor.at;
    if (key === 'pm25' || key === 'pm10') {
      const value = pmNowCast(hourlySeries(valid, at, PM_NOWCAST_HOURS));
      candidates.push({
        at,
        value,
        reason: 'nowcast',
        averaging: null,
        method: 'nowcast',
      });
    } else if (key === 'o3') {
      // The method runs in ppb: the layer's µg/m³ convert at 25 °C.
      const factor = EPA_GAS_FACTORS.O3;
      const ppb = ozoneNowCast(
        hourlySeries(
          valid.map((h) => ({ endMs: h.endMs, value: h.value / factor })),
          at,
          OZONE_SERIES_HOURS,
        ),
      );
      candidates.push({
        at,
        value: ppb === null ? null : ppb * factor,
        reason: 'nowcast',
        averaging: null,
        method: 'nowcast',
      });
    } else if (key === 'co') {
      candidates.push({
        at,
        value: eightHourMean(hourlySeries(valid, at, 8)),
        reason: 'hours',
        averaging: 480,
      });
    } else
      candidates.push({
        ...anchor,
        averaging: 60,
      });
  }
  for (const row of rows)
    if (SINGLE_PERIODS[key].includes(row.averaging)) candidates.push(row);
  // A NowCast or mean that fails on a newest hour unusable in itself says
  // why that hour is.
  for (const candidate of candidates)
    if (
      candidate.value === null &&
      anchor?.value === null &&
      candidate.at === anchor.at
    )
      candidate.reason = anchor.reason;
  let best = candidates.reduce((a, b) => (newer(b, a) ? b : a), null);
  const day =
    key === 'so2'
      ? rows
          .filter((row) => row.averaging === 1440 && row.value !== null)
          .reduce((a, b) => (newer(b, a) ? b : a), null)
      : null;
  // A 24-hour SO2 average rates on its own only from 305 ppb, where the
  // EPA's daily SO2 rows use it; below that the daily index comes from the
  // day's highest 1-hour value, which a mean cannot stand in for. It does so
  // where no usable 1-hour value lies within AQI_MAX_SPREAD_MS of it, unless
  // a 1-hour value further ahead of it is the newest reading: a flagged hour
  // of its time does not discard it.
  if (
    day &&
    tableConcentration('so2', day.value) >= 305 &&
    (!best ||
      (best.value === null
        ? best.at <= day.at + AQI_MAX_SPREAD_MS
        : best.at < day.at - AQI_MAX_SPREAD_MS))
  )
    best = day;
  if (!best) {
    // Readings, none on the table's averaging period.
    const at = Math.max(...rows.map((row) => row.at));
    best = { at, value: null, reason: 'averaging' };
  }
  // A companion value counts only beside a value of its own time: within
  // AQI_MAX_SPREAD_MS of the one it goes with, as values are of each other.
  const near = (other) =>
    Number.isFinite(best.at) &&
    Math.abs(other.at - best.at) <= AQI_MAX_SPREAD_MS;
  // The newest hourly mean, when valid: ozone's for the 1-hour rows, and
  // every pollutant's for its hourly reading beside the index.
  if (anchor && anchor.value !== null && near(anchor))
    best = { ...best, hour: anchor.value };
  if (day && near(day)) best = { ...best, day: day.value };
  return best;
}

/**
 * One reading per station for the AQI view. Per-pollutant readings of a
 * station (one `provider` and `stationId`) are folded together; a reading
 * that already carries `values` passes through, its values taken as on
 * their tables' averaging periods.
 *
 * Each pollutant is rated on its table's averaging period, from its readings
 * by `averagingMinutes`: hourly means (60) of PM2.5 and PM10 give their
 * NowCast as of the newest hour (two of the last three hours valid), of
 * ozone its NowCast (up to the last 338 hours) and that hour's mean for the
 * 1-hour rows, of CO its 8-hour mean (6 of the last 8 hours); NO2 and SO2
 * take their newest 1-hour value (or one whose period is not stated). A
 * reading on the table's own period also counts: 24-hour PM and SO2,
 * 8-hour O3 and CO; a 24-hour SO2 average rates alone where no usable
 * 1-hour SO2 value of its time is known (from 305 ppb on its rows, below on
 * the 1-hour rows). Hours flagged by their source, in units that do not
 * convert, under 75 % covered or above their fault ceiling (`AQI_CEILINGS`)
 * count as missing. The newest basis decides.
 *
 * `values` holds each pollutant's value for the index, in the layer's units,
 * with `valueTimes`, `valueAveraging` (minutes, null for a NowCast or an
 * unstated period), `valueMethods` (`'nowcast'`) and (where given)
 * `valueCoverage` per value; `hourValues` holds each pollutant's newest
 * valid hourly mean (ozone's rates on the 1-hour rows) and `dayValues.so2`
 * a 24-hour SO2 average, where known and within AQI_MAX_SPREAD_MS of the
 * value they go with; `excluded` names the pollutants left out: `'units'`, `'flagged'`,
 * `'incomplete'`, `'implausible'` (a newest hour above its fault ceiling),
 * `'nowcast'` or `'hours'` (too few hours), `'averaging'` (no reading on a
 * period the table rates). A network's own index, if a reading carries one,
 * is not kept. Stations reporting none of the index's pollutants are left
 * out. The station's time is its newest value's (its newest reading's when
 * it has none); `aqi` is left for the layer (`stationIndex`).
 */
export function aqiStations(readings) {
  const stations = new Map();
  const out = [];
  for (const reading of Array.isArray(readings) ? readings : []) {
    if (reading?.values && typeof reading.values === 'object') {
      out.push(reading);
      continue;
    }
    const key = AQI_POLLUTANTS[reading?.parameter];
    if (!key) continue;
    const stationKey = `${reading.provider}\u0000${reading.stationId ?? reading.id}`;
    let station = stations.get(stationKey);
    if (!station) {
      const identity = { ...reading };
      for (const field of POLLUTANT_FIELDS) delete identity[field];
      station = {
        ...identity,
        stationId: reading.stationId ?? reading.id,
        id: `${reading.provider}:${reading.stationId ?? reading.id}:aqi`,
        parameter: 'aqi',
        scale: 'US AQI',
        kind: 'observation',
        values: {},
        valueTimes: {},
        valueAveraging: {},
        valueMethods: {},
        valueCoverage: {},
        hourValues: {},
        dayValues: {},
        excluded: {},
        observedMs: null,
        reportedMs: -Infinity,
        hours: {},
        rows: {},
        aqi: null,
        color: AIR_QUALITY_UNRATED_COLOR,
        label: '',
        note: 'US AQI computed per pollutant on its EPA averaging period (NowCast for particles and ozone); not an official reading.',
      };
      stations.set(stationKey, station);
      out.push(station);
    }
    const at = Number.isFinite(reading.observedMs) ? reading.observedMs : null;
    if (at !== null) station.reportedMs = Math.max(station.reportedMs, at);
    const averaging = Number.isFinite(reading.averagingMinutes)
      ? reading.averagingMinutes
      : null;
    const value = reading.qualityFlagged
      ? null
      : concentrationIn(reading.parameter, reading.value, reading.units);
    const candidate = {
      at: at ?? -Infinity,
      value,
      reason: reading.qualityFlagged ? 'flagged' : 'units',
      averaging,
      coverage: reading.coveragePercent,
    };
    if (averaging === 60 && at !== null) {
      // Hourly means, one per hour: the newest decides an hour read twice.
      // An hour under-covered or above its fault ceiling counts as missing,
      // so it never enters a NowCast or 8-hour mean.
      const covered =
        !Number.isFinite(reading.coveragePercent) ||
        reading.coveragePercent >= HOUR_MIN_COVERAGE;
      const fault = value !== null && value > AQI_CEILINGS[key];
      const hour = {
        ...candidate,
        endMs: at,
        value: covered && !fault ? value : null,
        reason: !covered
          ? 'incomplete'
          : fault
            ? 'implausible'
            : candidate.reason,
      };
      const hours = (station.hours[key] ??= new Map());
      const slot = Math.round(at / HOUR_MS);
      if (newer(hour, hours.get(slot))) hours.set(slot, hour);
      continue;
    }
    const rows = (station.rows[key] ??= new Map());
    if (newer(candidate, rows.get(averaging))) rows.set(averaging, candidate);
  }
  for (const station of stations.values()) {
    const keys = new Set([
      ...Object.keys(station.hours),
      ...Object.keys(station.rows),
    ]);
    for (const key of keys) {
      const input = pollutantInput(
        key,
        [...(station.hours[key]?.values() ?? [])],
        [...(station.rows[key]?.values() ?? [])],
      );
      if (input.value === null) {
        station.excluded[key] = input.reason;
        continue;
      }
      station.values[key] = input.value;
      station.valueTimes[key] = Number.isFinite(input.at) ? input.at : null;
      station.valueAveraging[key] = input.averaging ?? null;
      if (input.method) station.valueMethods[key] = input.method;
      // Coverage describes one averaging period, not a NowCast.
      if (input.coverage !== undefined && input.averaging !== null)
        station.valueCoverage[key] = input.coverage;
      if (input.hour !== undefined) station.hourValues[key] = input.hour;
      if (input.day !== undefined) station.dayValues[key] = input.day;
    }
    delete station.hours;
    delete station.rows;
    const { reportedMs } = station;
    delete station.reportedMs;
    const times = Object.values(station.valueTimes).filter(Number.isFinite);
    station.observedMs = times.length
      ? Math.max(...times)
      : Number.isFinite(reportedMs)
        ? reportedMs
        : null;
    const averaging = new Set(Object.values(station.valueAveraging));
    station.averagingMinutes = averaging.size === 1 ? [...averaging][0] : null;
  }
  return out;
}
