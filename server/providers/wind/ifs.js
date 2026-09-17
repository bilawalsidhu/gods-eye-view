import { fetchText, fetchRange, loadOptionalScalar } from './gfs.js';
import { decodeWindGribMessage } from './decode.js';
import { resampleWeatherSnapshot, weatherScalarMetadata } from './grid.js';

/** Keyless ECMWF Open Data root for real-time IFS forecasts. */
export const IFS_BASE = 'https://data.ecmwf.int/forecasts';

/**
 * Select the latest IFS cycle that should be available.
 * @param {number} nowMs - Reference epoch milliseconds.
 * @param {{availabilityLagMs?: number}} [options]
 * @returns {{date: string, hour: number}}
 */
export function selectLatestIfsCycle(
  nowMs,
  { availabilityLagMs = 6 * 3600_000 } = {},
) {
  const shifted = new Date(nowMs - availabilityLagMs);
  return {
    date: shifted.toISOString().slice(0, 10).replaceAll('-', ''),
    hour: Math.floor(shifted.getUTCHours() / 6) * 6,
  };
}

/**
 * Build the IFS GRIB2 and `.index` URLs for one cycle and step.
 * @param {{date: string, hour: number, step?: number}} cycle
 * @returns {{grib: string, index: string}}
 */
export function ifsObjectUrls({ date, hour, step = 0 }) {
  const hh = String(hour).padStart(2, '0');
  const stem = `${IFS_BASE}/${date}/${hh}z/ifs/0p25/oper/${date}${hh}0000-${step}h-oper-fc`;
  // The inventory sits beside the GRIB2 as `<stem>.index`, NOT `<grib2>.index`.
  return { grib: `${stem}.grib2`, index: `${stem}.index` };
}

/**
 * Parse the IFS JSON Lines inventory into `{param, offset, length}` records.
 * Malformed lines are skipped; a payload with no valid lines is rejected.
 * @param {string} text - Raw `.index` body.
 * @returns {Array<{param: string, offset: number, length: number}>}
 */
export function parseIfsIndex(text) {
  const entries = [];
  for (const line of String(text).split(/\r?\n/)) {
    if (!line) continue;
    let value;
    try {
      value = JSON.parse(line);
    } catch {
      continue; // non-JSON line in the index
    }
    if (
      value?.param &&
      Number.isFinite(value._offset) &&
      Number.isFinite(value._length)
    )
      entries.push({
        param: value.param,
        offset: value._offset,
        length: value._length,
      });
  }
  if (!entries.length) throw new Error('malformed IFS index');
  return entries;
}

/**
 * Byte ranges for the IFS 10 m wind components.
 * @param {Array<{param: string, offset: number, length: number}>} entries
 * @returns {{u: {start: number, end: number}, v: {start: number, end: number}}}
 */
export function ifsWindRanges(entries, { overlay = 'none' } = {}) {
  weatherScalarMetadata(overlay);
  const range = (param) => {
    const item = entries.find((entry) => entry.param === param);
    if (!item) throw new Error(`missing ${param}`);
    return { start: item.offset, end: item.offset + item.length - 1 };
  };
  return {
    u: range('10u'),
    v: range('10v'),
    ...(overlay === 'temperature' ? { scalar: range('2t') } : {}),
    ...(overlay === 'pressure' ? { scalar: range('msl') } : {}),
  };
}

/**
 * Round a time offset to the nearest published IFS forecast step. IFS 0.25°
 * oper is 3-hourly through f144, then 6-hourly to f360 for 00/12z.
 * @param {number} hours - Hours elapsed since the cycle run time.
 * @param {number} cycleHour - The cycle hour (0, 6, 12 or 18).
 * @returns {number} A valid forecast step.
 */
export function nearestIfsStep(hours, cycleHour) {
  const max = cycleHour === 6 || cycleHour === 18 ? 144 : 360;
  const value = Math.max(0, Number.isFinite(hours) ? hours : 0);
  const step =
    value <= 144 ? Math.round(value / 3) * 3 : Math.round(value / 6) * 6;
  return Math.max(0, Math.min(max, step));
}

/**
 * Fetch and decode the IFS 10 m wind field valid closest to now.
 * @param {{fetchImpl?: Function, now?: Function, targetDx?: number,
 *   decodeImpl?: Function}} [options]
 * @returns {Promise<{cycle: object, level: string, units: string, grid: object}>}
 */
export async function fetchIfsWind({
  fetchImpl = fetch,
  now = () => Date.now(),
  targetDx = 1,
  decodeImpl = decodeWindGribMessage,
  signal,
  overlay = 'none',
} = {}) {
  weatherScalarMetadata(overlay);
  const nowMs = now();
  const cycle = selectLatestIfsCycle(nowMs);
  const runMs = Date.UTC(
    Number(cycle.date.slice(0, 4)),
    Number(cycle.date.slice(4, 6)) - 1,
    Number(cycle.date.slice(6, 8)),
    cycle.hour,
  );
  // Show the field valid closest to now rather than always the analysis.
  const forecastHour = nearestIfsStep((nowMs - runMs) / 3600_000, cycle.hour);
  const urls = ifsObjectUrls({ ...cycle, step: forecastHour });
  const index = await fetchText({ url: urls.index, fetchImpl, signal });
  const inventory = parseIfsIndex(index.toString());
  const ranges = ifsWindRanges(inventory);
  let scalarRange;
  if (overlay !== 'none') {
    try {
      scalarRange = ifsWindRanges(inventory, { overlay }).scalar;
    } catch {
      /* A missing optional field does not discard valid wind. */
    }
  }
  // All selected messages come from this one issue/valid-time object.
  const load = async (range) =>
    decodeImpl(
      await fetchRange({ url: urls.grib, ...range, fetchImpl, signal }),
    );
  const [u, v, scalar] = await Promise.all([
    load(ranges.u),
    load(ranges.v),
    loadOptionalScalar({
      range: scalarRange,
      url: urls.grib,
      fetchImpl,
      decodeImpl,
      signal,
    }),
  ]);
  signal?.throwIfAborted();
  const fields = resampleWeatherSnapshot({ u, v, scalar, overlay, targetDx });
  const runIso = new Date(runMs).toISOString();
  const validIso = new Date(runMs + forecastHour * 3600_000).toISOString();
  return {
    cycle: { ...cycle, forecastHour, runIso, validIso },
    level: '10 m above ground',
    units: 'm/s',
    ...fields,
  };
}
