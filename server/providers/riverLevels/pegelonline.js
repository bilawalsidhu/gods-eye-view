import {
  classifyRiverLevel,
  cleanReferences,
} from '../../../src/layers/riverLevels/model.js';

/**
 * PEGELONLINE (Wasserstraßen- und Schifffahrtsverwaltung des Bundes): every
 * federal waterway gauge with its current water level ("W", centimetres on
 * the gauge zero) and the gauge's characteristic values, in one keyless
 * request. Data licence: Datenlizenz Deutschland – Zero – 2.0.
 */
export const PEGELONLINE_STATIONS_URL =
  'https://www.pegelonline.wsv.de/webservices/rest-api/v2/stations.json?' +
  new URLSearchParams({
    includeTimeseries: 'true',
    includeCurrentMeasurement: 'true',
    includeCharacteristicValues: 'true',
    timeseries: 'W',
  }).toString();

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** The 72-hour level series of one gauge (15-minute raw values). */
export function pegelonlineMeasurementsUrl(uuid) {
  if (!UUID.test(String(uuid))) throw new Error('invalid_station');
  return `https://www.pegelonline.wsv.de/webservices/rest-api/v2/stations/${uuid}/W/measurements.json?start=P3D`;
}

/** Characteristic value short names → shared reference keys. */
const REFERENCE_NAMES = Object.freeze({
  NNW: 'recordLow', // lowest level ever observed
  MNW: 'low', // mean of the yearly lows
  MW: 'mean', // mean of all daily levels
  MHW: 'high', // mean of the yearly highs
  M_I: 'watch', // flood alert stage I (Meldestufe)
  M_II: 'warning', // flood alert stage II
  M_III: 'flood', // flood alert stage III
  HHW: 'recordHigh', // highest level ever observed
});

/** A number from a JSON value; null, '' and absent are not 0. */
const num = (value) =>
  value === null || value === undefined || value === '' ? NaN : Number(value);

const title = (text) =>
  String(text || '')
    .toLowerCase()
    .replace(/(^|[\s\-(/])(\p{L})/gu, (_, sep, ch) => sep + ch.toUpperCase());

/**
 * One gauge row → shared station shape, or null when it has no usable level.
 * @param {object} row One entry of the stations list.
 * @returns {object|null}
 */
export function normalizePegelonlineStation(row) {
  const uuid = String(row?.uuid || '');
  if (!UUID.test(uuid)) return null;
  const lat = Number(row.latitude);
  const lon = Number(row.longitude);
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;
  const series = (row.timeseries || []).find((ts) => ts?.shortname === 'W');
  const current = series?.currentMeasurement;
  const value = num(current?.value);
  const observedMs = Date.parse(current?.timestamp);
  if (!Number.isFinite(value) || !Number.isFinite(observedMs)) return null;
  // Every value and reference of the W series is in centimetres.
  if (String(series.unit || '').toLowerCase() !== 'cm') return null;
  const raw = {};
  for (const cv of series.characteristicValues || []) {
    const key = REFERENCE_NAMES[cv?.shortname];
    if (key && String(cv.unit || '').toLowerCase() === 'cm')
      raw[key] = num(cv.value) / 100;
  }
  const refs = cleanReferences(raw);
  const level = value / 100;
  return {
    id: `pegelonline:${uuid}`,
    provider: 'pegelonline',
    code: /^[0-9]{5,10}$/.test(String(row.number)) ? String(row.number) : null,
    name: title(row.longname || row.shortname),
    river: title(row.water?.longname || row.water?.shortname),
    lat,
    lon,
    level,
    observedMs,
    refs,
    band: classifyRiverLevel(level, refs),
  };
}

/** The whole list → stations with a current level. */
export function normalizePegelonline(payload) {
  if (!Array.isArray(payload)) throw new Error('invalid_snapshot');
  return payload.map(normalizePegelonlineStation).filter(Boolean);
}

/** A measurements answer → [[epochMs, metres], …] in time order. */
export function normalizePegelonlineSeries(payload) {
  if (!Array.isArray(payload)) throw new Error('invalid_series');
  return payload
    .map((row) => [Date.parse(row?.timestamp), num(row?.value) / 100])
    .filter(([at, value]) => Number.isFinite(at) && Number.isFinite(value))
    .sort((a, b) => a[0] - b[0]);
}
