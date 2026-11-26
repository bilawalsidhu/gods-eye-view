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
 * The table is defined on 24-hour (PM, SO2 above 200), 8-hour (O3, CO) and
 * 1-hour (NO2, SO2 up to 200) averages; a station's latest values stand in
 * for them. Where the document gives 1-hour rules they are followed: ozone
 * takes the higher of its 8-hour rows (held at 300 above 0.200 ppm, where
 * they end) and its 1-hour rows (from 0.125 ppm), so its index never falls as
 * the concentration rises; a 1-hour SO2 value of 305 ppb or more gives
 * exactly 200.
 *
 * Values are in µg/m³, CO in mg/m³: the layer's units (`units.js`). Gases
 * convert back to ppb (CO to ppm) at 25 °C, the EPA's reference conditions.
 */
import { AIR_QUALITY_UNRATED_COLOR } from './model.js';
import { EPA_GAS_FACTORS, concentrationIn } from './units.js';

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
  // 1-hour rows; from 305 ppb the table is on 24-hour values (`subIndex`).
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

/** One pollutant's sub-index before rounding. */
function subIndex(key, value) {
  const c = tableConcentration(key, value);
  if (key === 'o3') {
    // The higher of the 8-hour rows, held at 300 above 0.200 ppm where they
    // end, and the 1-hour rows from 0.125 ppm: the index never falls as the
    // concentration rises.
    const eightHour = c <= 0.2 ? onRows(c, TABLE.o3.rows) : 300;
    return c >= OZONE_HOURLY[0][0]
      ? Math.max(eightHour, onRows(c, OZONE_HOURLY))
      : eightHour;
  }
  // 1-hour SO2 values do not define 200 and above: fixed at 200.
  if (key === 'so2' && c >= 305) return 200;
  return onRows(c, TABLE[key].rows);
}

const usable = (value) => Number.isFinite(value) && value >= 0;

/**
 * The US AQI of one station's values, or null when none can be rated.
 * @param {{pm25?: number, pm10?: number, o3?: number, no2?: number, so2?: number, co?: number}} values
 *   µg/m³, CO in mg/m³.
 * @returns {{index: number, leading: string} | null} The rounded index and
 *   the key of the pollutant that sets it.
 */
export function usAqi(values) {
  let best = null;
  for (const key of Object.keys(TABLE)) {
    if (!usable(values?.[key])) continue;
    const index = Math.round(subIndex(key, values[key]));
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

/**
 * A station's index from the values it reports (`aqiStations`). The values
 * kept are within their ceilings and within AQI_MAX_SPREAD_MS of the newest.
 * PM2.5 is checked against the PM10 still kept; one left out does not count
 * as the newest.
 * @returns {{aqi: {index: number, leading: string} | null,
 *   used: object, excluded: Object<string, string>, observedMs: number|null}}
 *   `excluded` gives each value left out its reason: `'units'` or
 *   `'flagged'` (from the station), `'implausible'`, `'above-pm10'` or
 *   `'too-old'`.
 */
export function stationIndex({ values, valueTimes = {}, excluded = {} } = {}) {
  const { kept, excluded: implausible } = withinCeilings(values);
  const reasons = { ...excluded, ...implausible };
  let spread = withinSpread(kept, valueTimes);
  if (dropPm25AbovePm10(spread.fresh, reasons)) {
    delete kept.pm25;
    spread = withinSpread(kept, valueTimes);
  }
  const { fresh, old, newest } = spread;
  for (const key of old) reasons[key] = 'too-old';
  const aqi = usAqi(fresh);
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

/**
 * One reading per station for the AQI view. Per-pollutant readings of a
 * station (one `provider` and `stationId`) are folded together; a reading
 * that already carries `values` passes through.
 *
 * `values` holds every pollutant the station reports, in the layer's units,
 * with `valueTimes`, `valueAveraging` and (where given) `valueCoverage` per
 * value; `excluded` names the
 * readings left out (`'units'` when their units do not convert, `'flagged'`
 * when their source flagged them). A network's own index, if a reading
 * carries one, is not kept. Stations reporting none of the index's
 * pollutants are left out. The station's time is its newest value's (its newest reading's when
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
        valueCoverage: {},
        excluded: {},
        observedMs: null,
        reportedMs: -Infinity,
        newest: {},
        aqi: null,
        color: AIR_QUALITY_UNRATED_COLOR,
        label: '',
        note: 'US AQI computed from the latest value of each pollutant; not an official reading.',
      };
      stations.set(stationKey, station);
      out.push(station);
    }
    const at = Number.isFinite(reading.observedMs) ? reading.observedMs : null;
    if (at !== null) station.reportedMs = Math.max(station.reportedMs, at);
    const value = reading.qualityFlagged
      ? null
      : concentrationIn(reading.parameter, reading.value, reading.units);
    const candidate = {
      at: at ?? -Infinity,
      value,
      reason: reading.qualityFlagged ? 'flagged' : 'units',
      reading,
    };
    if (newer(candidate, station.newest[key])) station.newest[key] = candidate;
  }
  // One reading per pollutant: the newest, whatever order they came in. A
  // newest one flagged or in units that do not convert leaves the pollutant
  // out, and no older value stands in for it.
  for (const station of stations.values()) {
    for (const [key, { at, value, reason, reading }] of Object.entries(
      station.newest,
    )) {
      if (value === null) {
        station.excluded[key] = reason;
        continue;
      }
      station.values[key] = value;
      station.valueTimes[key] = Number.isFinite(at) ? at : null;
      station.valueAveraging[key] = reading.averagingMinutes ?? null;
      if (reading.coveragePercent !== undefined)
        station.valueCoverage[key] = reading.coveragePercent;
    }
    delete station.newest;
  }
  for (const station of stations.values()) {
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
