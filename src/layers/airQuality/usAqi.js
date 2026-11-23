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
 * for them. Where the document rules on a 1-hour value it is followed: ozone
 * above 0.200 ppm is hazardous and numbered on the 1-hour row from
 * 0.405 ppm, and a 1-hour SO2 value of 305 ppb or more gives exactly 200.
 *
 * Values are in µg/m³, CO in mg/m³: the layer's units. Gases convert to ppb
 * (CO to ppm) at 25 °C and 1 atm, the EPA's reference conditions.
 */
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

/** µg/m³ per ppb (CO: mg/m³ per ppm) at 25 °C: molar mass / 24.45. */
export const EPA_GAS_FACTORS = Object.freeze({
  o3: 1.963,
  no2: 1.882,
  so2: 2.62,
  co: 1.1456,
});

/** Above these (µg/m³; CO mg/m³) a value is taken to be an instrument fault. */
export const AQI_CEILINGS = Object.freeze({
  pm25: 3000,
  pm10: 6000,
  o3: 1000,
  no2: 1500,
  so2: 3000,
  co: 100,
});

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
  // 8-hour rows; above 0.200 ppm see `ozone`.
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
  // 1-hour rows; from 305 ppb see `sulphurDioxide`.
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
/** The 1-hour ozone row for 301 to 500, in ppm. */
const OZONE_HAZARDOUS = Object.freeze([0.405, 0.604, 301, 500]);

/** Truncate to `digits` decimals; a tolerance absorbs unit-conversion error. */
const truncate = (value, digits) => {
  const scale = 10 ** digits;
  return Math.floor(value * scale + 1e-6) / scale;
};

/** Equation 1 in one row; above the row it continues on the same line. */
const interpolate = (c, [low, high, indexLow, indexHigh]) =>
  ((indexHigh - indexLow) / (high - low)) * (c - low) + indexLow;

/** A concentration in the table's units, truncated, from the layer's units. */
function tableConcentration(key, value) {
  const factor = EPA_GAS_FACTORS[key];
  const native = !factor ? value : (value / factor) * (key === 'o3' ? 1e-3 : 1);
  return truncate(native, TABLE[key].digits);
}

/** One pollutant's sub-index before rounding. */
function subIndex(key, value) {
  const c = tableConcentration(key, value);
  if (key === 'o3' && c > 0.2)
    // 8-hour values above 0.200 ppm are hazardous; the 1-hour row numbers it.
    return c < OZONE_HAZARDOUS[0] ? 301 : interpolate(c, OZONE_HAZARDOUS);
  if (key === 'so2' && c >= 305) return 200;
  const { rows } = TABLE[key];
  return interpolate(c, rows.find((row) => c <= row[1]) ?? rows.at(-1));
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
 * The values worth an index: each at or below its ceiling, and PM2.5 only
 * when it does not exceed the station's PM10 (PM2.5 is part of PM10).
 */
export function plausible(values) {
  const kept = {};
  for (const [key, ceiling] of Object.entries(AQI_CEILINGS))
    if (usable(values?.[key]) && values[key] <= ceiling)
      kept[key] = values[key];
  if (
    kept.pm25 !== undefined &&
    kept.pm10 !== undefined &&
    kept.pm25 > kept.pm10
  )
    delete kept.pm25;
  return kept;
}

/** The category of an index, or null. */
export function usAqiBand(index) {
  if (!Number.isFinite(index)) return null;
  return US_AQI_BANDS[US_AQI_LIMITS.filter((limit) => index > limit).length];
}

/** The EPA's number range of each category, for the legend. */
export function usAqiRange(position) {
  if (position === US_AQI_LIMITS.length) return `${US_AQI_LIMITS.at(-1) + 1}+`;
  return `${position ? US_AQI_LIMITS[position - 1] + 1 : 0}–${US_AQI_LIMITS[position]}`;
}

const normalizedUnits = (units) =>
  String(units ?? '')
    .trim()
    .replaceAll('μ', 'µ')
    .replaceAll('³', '3')
    .toLowerCase();

/**
 * A layer pollutant's value in the layer's units (µg/m³; CO mg/m³), from
 * µg/m³, mg/m³, ppb or ppm, or null when it cannot be converted.
 */
export function concentrationIn(parameter, value, units) {
  const key = AQI_POLLUTANTS[parameter];
  if (!key || !usable(value)) return null;
  const factor = EPA_GAS_FACTORS[key];
  // The layer's unit for CO is mg/m³ and its factor is per ppm; for the
  // others, µg/m³ and per ppb.
  const milli = key === 'co';
  switch (normalizedUnits(units)) {
    case 'µg/m3':
    case 'ug/m3':
      return milli ? value / 1000 : value;
    case 'mg/m3':
      return milli ? value : value * 1000;
    case 'ppb':
      if (!factor) return null;
      return milli ? (value / 1000) * factor : value * factor;
    case 'ppm':
      if (!factor) return null;
      return milli ? value * factor : value * 1000 * factor;
    default:
      return null;
  }
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
  'risk',
  'averagingMinutes',
  'observedMs',
  'periodStart',
  'periodEnd',
  'coveragePercent',
  'qualityFlagged',
];

/**
 * One reading per station for the AQI view, its `values` holding every
 * pollutant the station reports in the layer's units. Per-pollutant readings
 * of a station (one `provider` and `stationId`) are folded together; a
 * reading that already carries `values` passes through. A value is kept only
 * from a reading its provider rates (`rated !== false`), that its source did
 * not flag and whose units convert. A station whose provider rates none of
 * its readings stays `rated: false`. Stations reporting none of the index's
 * pollutants are left out. `aqi` is left for the layer to compute.
 */
export function aqiStations(readings) {
  const stations = new Map();
  const out = [];
  for (const reading of Array.isArray(readings) ? readings : []) {
    if (reading?.values && typeof reading.values === 'object') {
      out.push(reading);
      continue;
    }
    if (!AQI_POLLUTANTS[reading?.parameter]) continue;
    const key = `${reading.provider}\u0000${reading.stationId ?? reading.id}`;
    let station = stations.get(key);
    if (!station) {
      const identity = { ...reading };
      for (const field of POLLUTANT_FIELDS) delete identity[field];
      station = {
        ...identity,
        id: `${reading.provider}:${reading.stationId ?? reading.id}:aqi`,
        parameter: 'aqi',
        scale: 'US AQI',
        kind: 'observation',
        values: {},
        observedMs: -Infinity,
        averaging: new Set(),
        anyRated: false,
        aqi: null,
        color: '#8cb4ce',
        label: '',
        note: 'US AQI computed from the latest value of each pollutant; not an official reading.',
      };
      stations.set(key, station);
      out.push(station);
    }
    if (Number.isFinite(reading.observedMs))
      station.observedMs = Math.max(station.observedMs, reading.observedMs);
    if (reading.rated === false) continue;
    station.anyRated = true;
    const value = reading.qualityFlagged
      ? null
      : concentrationIn(reading.parameter, reading.value, reading.units);
    if (value === null) continue;
    station.values[AQI_POLLUTANTS[reading.parameter]] = value;
    station.averaging.add(reading.averagingMinutes ?? null);
  }
  for (const station of stations.values()) {
    const { averaging, anyRated } = station;
    delete station.averaging;
    delete station.anyRated;
    station.averagingMinutes = averaging.size === 1 ? [...averaging][0] : null;
    if (!anyRated) station.rated = false;
    if (!Number.isFinite(station.observedMs)) station.observedMs = null;
  }
  return out;
}
