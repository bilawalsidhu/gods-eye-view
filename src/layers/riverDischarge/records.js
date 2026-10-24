// River discharge outlook records: the bundled point pack's shape, the
// forecast series the proxy returns, and the outlook classification. Pure;
// shared by the server proxy (server/providers/riverDischarge.js) and the
// layer, so both read one definition of a point and of a level.
import { msg } from '../../i18n/marker.js';

/** Days the outlook looks ahead, today (UTC) included. */
export const RIVER_OUTLOOK_DAYS = 7;

/** Daily variables the proxy asks Open-Meteo for, in series-key order. */
export const RIVER_FORECAST_VARIABLES = Object.freeze({
  discharge: 'river_discharge',
  median: 'river_discharge_median',
  min: 'river_discharge_min',
  max: 'river_discharge_max',
  p25: 'river_discharge_p25',
  p75: 'river_discharge_p75',
});

/** Outlook levels, lowest first. `unknown` has no usable forecast. */
export const RIVER_OUTLOOK_LEVELS = Object.freeze([
  'normal',
  'high',
  'very-high',
]);

export const RIVER_OUTLOOK_COLORS = Object.freeze({
  normal: '#5fb4ff',
  high: '#ffb020',
  'very-high': '#ff3b5c',
  unknown: '#8a94a6',
});

export const RIVER_OUTLOOK_LABELS = Object.freeze({
  normal: msg('Below the 90th percentile'),
  high: msg('Above the 90th percentile'),
  'very-high': msg('Above the 99th percentile'),
  unknown: msg('No forecast'),
});

const ISO_DAY = /^\d{4}-\d{2}-\d{2}$/;
const MAX_SERIES_DAYS = 16;

const finiteOrNull = (value) =>
  Number.isFinite(value) && value >= 0 ? value : null;

/**
 * One bundled point, or null when it does not match the pack schema
 * (scripts/build-river-discharge-points.mjs).
 */
export function normalizeRiverPoint(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const { id, name, lat, lon, p50, p90, p99, mean, max } = raw;
  if (typeof id !== 'string' || !/^-?\d{1,2}\.\d{3}_-?\d{1,3}\.\d{3}$/.test(id))
    return null;
  if (typeof name !== 'string' || !name.trim() || name.length > 80) return null;
  if (!(Math.abs(lat) <= 90) || !(Math.abs(lon) <= 180)) return null;
  if (![p50, p90, p99].every((v) => Number.isFinite(v) && v >= 0)) return null;
  if (!(p50 <= p90 && p90 <= p99)) return null;
  return {
    id,
    name: name.trim(),
    lat,
    lon,
    p50,
    p90,
    p99,
    mean: finiteOrNull(mean),
    max: finiteOrNull(max),
  };
}

/** Points inside a view box; `west > east` crosses the antimeridian. */
export function riverPointsInBox(points, { south, west, north, east }) {
  const crosses = west > east;
  return points.filter(
    (p) =>
      p.lat >= south &&
      p.lat <= north &&
      (crosses
        ? p.lon >= west || p.lon <= east
        : p.lon >= west && p.lon <= east),
  );
}

/**
 * One Open-Meteo Flood API location row as the proxy's series:
 * `{ time[], discharge[], median[], min[], max[], p25[], p75[] }`, values
 * m³/s or null. Null when the row is not a daily discharge series.
 */
export function normalizeFloodSeries(row) {
  const daily = row?.daily;
  const time = daily?.time;
  if (
    !Array.isArray(time) ||
    !time.length ||
    time.length > MAX_SERIES_DAYS ||
    !time.every((day) => typeof day === 'string' && ISO_DAY.test(day))
  )
    return null;
  const series = { time: [...time] };
  for (const [key, variable] of Object.entries(RIVER_FORECAST_VARIABLES)) {
    const values = daily[variable];
    if (values === undefined && key !== 'discharge') {
      series[key] = time.map(() => null);
      continue;
    }
    if (!Array.isArray(values) || values.length !== time.length) return null;
    series[key] = values.map(finiteOrNull);
  }
  return series.discharge.some((value) => value !== null) ? series : null;
}

/**
 * The outlook for one point: the highest daily discharge forecast from
 * `today` (UTC, `YYYY-MM-DD`) over the next RIVER_OUTLOOK_DAYS days, set
 * against the point's own reanalysis percentiles. Levels compare the
 * forecast's headline series (`river_discharge`); the ensemble statistics on
 * the peak day are reported beside it, not used to raise the level.
 */
export function classifyRiverOutlook(point, series, today) {
  const empty = {
    level: 'unknown',
    peak: null,
    peakDay: null,
    today: null,
    ensemble: null,
    ensembleMaxPeak: null,
    ratioToMedian: null,
  };
  if (!series || !Array.isArray(series.time) || !ISO_DAY.test(today || ''))
    return empty;
  const start = series.time.findIndex((day) => day >= today);
  if (start < 0) return empty;
  const end = Math.min(series.time.length, start + RIVER_OUTLOOK_DAYS);
  let peakIndex = -1;
  let ensembleMaxPeak = null;
  for (let i = start; i < end; i++) {
    const value = series.discharge[i];
    if (
      value !== null &&
      (peakIndex < 0 || value > series.discharge[peakIndex])
    )
      peakIndex = i;
    const upper = series.max?.[i];
    if (upper !== null && upper !== undefined)
      ensembleMaxPeak =
        ensembleMaxPeak === null ? upper : Math.max(ensembleMaxPeak, upper);
  }
  if (peakIndex < 0) return empty;
  const peak = series.discharge[peakIndex];
  const level =
    peak >= point.p99 ? 'very-high' : peak >= point.p90 ? 'high' : 'normal';
  const at = (key) => series[key]?.[peakIndex] ?? null;
  const ensemble =
    at('median') === null && at('p25') === null && at('p75') === null
      ? null
      : {
          median: at('median'),
          min: at('min'),
          max: at('max'),
          p25: at('p25'),
          p75: at('p75'),
        };
  return {
    level,
    peak,
    peakDay: series.time[peakIndex],
    today: series.time[start] === today ? series.discharge[start] : null,
    ensemble,
    ensembleMaxPeak,
    ratioToMedian: point.p50 > 0 ? peak / point.p50 : null,
  };
}
