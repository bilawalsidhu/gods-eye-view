/**
 * Adapter from /api/firms proxy records (src/data/firmsCsv.js shape) to the
 * internal fire-record shape rendered by firmsHeatmap.js. Pure — no Cesium,
 * so the mapping is unit-testable.
 */
import { acquisitionMsUtc } from './firmsCsv.js';

/**
 * Map proxy fire records into internal fire records. Records with missing,
 * non-numeric or out-of-range (WGS84) coordinates are skipped; `index` is the post-skip position
 * (it keys pick ids and context-store ids, so it must stay sequential).
 * `contextEntity`/`position` start null and are lazily filled by the layer.
 * @param {?Array<Object>} records - /api/firms `fires` array.
 * @returns {Array<Object>} Internal fire records.
 */
export function adaptFirmsRecords(records) {
  const fires = [];
  if (!Array.isArray(records)) return fires;
  const acqCache = new Map();
  for (const record of records) {
    const lat = Number(record?.lat);
    const lon = Number(record?.lon);
    if (
      !hasCoordinateValue(record?.lat) ||
      !hasCoordinateValue(record?.lon) ||
      !Number.isFinite(lat) ||
      !Number.isFinite(lon) ||
      Math.abs(lat) > 90 ||
      Math.abs(lon) > 180
    )
      continue;
    fires.push({
      index: fires.length,
      lat,
      lon,
      frp: finiteNumber(record.frp),
      confidence: normalizeConfidence(record.confidence),
      brightness: finiteNumber(record.brightness),
      night: record.daynight === 'N',
      acqMs: parseAcquisitionMs(record.acqDate, record.acqTime, acqCache),
      sensor: normalizeSensor(record.instrument),
      satellite: typeof record.satellite === 'string' ? record.satellite : '',
      contextEntity: null,
      position: null,
    });
  }
  return fires;
}

/**
 * Normalize FIRMS confidence to 0..1. VIIRS reports the categorical strings
 * low/nominal/high (`l`/`n`/`h`); MODIS reports 0..100 numeric.
 * @param {*} value - Raw confidence property.
 * @returns {number} Confidence in 0..1.
 */
export function normalizeConfidence(value) {
  if (typeof value === 'string') {
    const text = value.trim().toLowerCase();
    if (text === 'low' || text === 'l') return 0.3;
    if (text === 'nominal' || text === 'n') return 0.6;
    if (text === 'high' || text === 'h') return 0.9;
    const numeric = Number(text);
    return Number.isFinite(numeric) ? clamp01(numeric / 100) : 0;
  }
  const numeric = Number(value);
  return Number.isFinite(numeric) ? clamp01(numeric / 100) : 0;
}

/**
 * Parse acq_date ("YYYY-MM-DD") + acq_time (unpadded "HHMM", UTC) into epoch
 * ms. Memoized per unique date:time pair — granule timestamps repeat heavily.
 * @param {*} date - acq_date property.
 * @param {*} time - acq_time property.
 * @param {Map<string, number>} [cache] - Per-batch memo cache.
 * @returns {number} Epoch milliseconds, or 0 when unparseable.
 */
export function parseAcquisitionMs(date, time, cache = new Map()) {
  const key = `${date}:${time ?? ''}`;
  let ms = cache.get(key);
  if (ms === undefined) {
    ms = acquisitionMsUtc(date, time) || 0;
    cache.set(key, ms);
  }
  return ms;
}

/**
 * Map sensor/instrument strings to a short display sensor name.
 * @param {*} value - Raw instrument property.
 * @returns {string}
 */
export function normalizeSensor(value) {
  const text = String(value || '').toUpperCase();
  if (text.includes('VIIRS')) return 'VIIRS';
  if (text.includes('MODIS')) return 'MODIS';
  return text ? text.slice(0, 12) : '';
}

function clamp01(value) {
  return Math.max(0, Math.min(1, value));
}

function finiteNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : 0;
}

// Same rule as parseFirmsCsv: a blank or non-numeric value is not a zero.
function hasCoordinateValue(value) {
  return (
    typeof value === 'number' ||
    (typeof value === 'string' && value.trim() !== '')
  );
}
