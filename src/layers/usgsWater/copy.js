/**
 * On-globe card copy for the USGS water layers.
 *
 * The server (server/providers/usgsWater.js, schema 2) serves ONE feature per
 * gauge with `readings: [{parameter_code, parameter_name, value, unit,
 * observed_time}]`, ordered most-useful first. Single-reading features (a
 * top-level value/unit) are accepted too.
 *
 * Pure and dependency-free: localGeojsonCore.js imports it.
 */

/** Readings shown on a card; the time line is added after them. */
export const USGS_CARD_MAX_READINGS = 2;

const UNIT_TEXT = Object.freeze({ 'ft^3/s': 'ft³/s' });

/** True for the USGS water layer ids (local-usgs-*). */
export function isUsgsWaterLayer(layerId) {
  return typeof layerId === 'string' && layerId.startsWith('local-usgs-');
}

/** Readings from schema-2 `readings[]`, or the schema-1 top-level reading. */
export function usgsReadings(props) {
  if (Array.isArray(props?.readings)) {
    return props.readings.filter((r) => r && typeof r === 'object');
  }
  if (props && props.value !== undefined && props.value !== null) {
    return [
      {
        parameter_code: props.parameter_code,
        parameter_name: props.parameter_name,
        value: props.value,
        unit: props.unit,
        observed_time: props.observed_time,
      },
    ];
  }
  return [];
}

/** `19.6`, `1,132.02`, `63,800` — at most 2 decimals, trailing zeros dropped. */
export function formatReadingValue(value) {
  if (value === null || value === undefined || value === '') return '';
  const n = Number(value);
  if (!Number.isFinite(n)) return '';
  return n.toLocaleString('en-US', { maximumFractionDigits: 2 });
}

/** `Gage height 3.97 ft`, or '' when the reading has no numeric value. */
export function usgsReadingLine(reading) {
  const value = formatReadingValue(reading?.value);
  if (!value) return '';
  const label = String(
    reading.parameter_name || reading.parameter_code || 'Reading',
  ).trim();
  const rawUnit = String(reading.unit || '').trim();
  const unit = UNIT_TEXT[rawUnit] ?? rawUnit;
  return unit ? `${label} ${value} ${unit}` : `${label} ${value}`;
}

/** `as of Oct 4, 5:00 AM CDT` in the viewer's time zone, or ''. */
export function usgsObservedLine(isoTime, { timeZone } = {}) {
  const ms = Date.parse(isoTime);
  if (!Number.isFinite(ms)) return '';
  const text = new Date(ms).toLocaleString('en-US', {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    timeZoneName: 'short',
    ...(timeZone ? { timeZone } : {}),
  });
  return `as of ${text}`;
}

/**
 * Card detail lines for one gauge: up to USGS_CARD_MAX_READINGS readings,
 * then the newest observation time. A gauge without a usable reading says so
 * instead of showing a bare name.
 * @param {object} props Unwrapped feature properties.
 * @param {{maxReadings?: number, timeZone?: string}} [options]
 * @returns {string[]}
 */
export function usgsWaterCardDetails(
  props,
  { maxReadings = USGS_CARD_MAX_READINGS, timeZone } = {},
) {
  const readings = usgsReadings(props);
  const lines = readings.map(usgsReadingLine).filter(Boolean);
  if (lines.length === 0) return ['No current reading'];
  const newest = readings
    .map((r) => r.observed_time)
    .filter((t) => Number.isFinite(Date.parse(t)))
    .sort((a, b) => Date.parse(b) - Date.parse(a))[0];
  const observed = usgsObservedLine(newest ?? props?.observed_time, {
    timeZone,
  });
  return observed
    ? [...lines.slice(0, maxReadings), observed]
    : lines.slice(0, maxReadings);
}
