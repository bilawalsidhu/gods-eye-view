/**
 * On-globe card copy for the USGS water layers.
 *
 * The server (server/providers/usgsWater.js, schema 2) serves ONE feature per
 * gauge with `readings: [{parameter_code, parameter_name, value, unit,
 * observed_time}]`, ordered most-useful first. Single-reading features (a
 * top-level value/unit) are accepted too.
 *
 * This module is part of the standalone infrastructure package, so it does not
 * import the translator (src/i18n/index.js) or the catalogs. It holds the
 * English text, marked with msg() from the dependency-free
 * src/i18n/marker.js, and takes the application's wording functions as the
 * `i18n` option: `{ t, formatNumber, formatDate, isolate }`, the exports of
 * src/i18n/index.js under those names. The application passes them in
 * through the layer services (src/app/localGeojsonServices.js), so the words,
 * numbers and time on a card follow the active language there. Without
 * `i18n` the card is in English with en-US numbers and times. The server
 * sends the parameter names in English from a fixed list; they are labels,
 * kept here as msg() text and translated when the card is built. Site names
 * are data and stay as sent. Unit symbols are not translated: they are shown
 * as sent, except `ft^3/s`, which UNIT_TEXT writes as `ft³/s`.
 *
 * usgsWater/index.js imports it.
 */
import { msg } from '../../i18n/marker.js';

/** Readings shown on a card; the time line is added after them. */
export const USGS_CARD_MAX_READINGS = 2;

const UNIT_TEXT = Object.freeze({ 'ft^3/s': 'ft³/s' });

/** Fill `{name}` placeholders; a name with no value stays as written. */
function fillText(text, values) {
  if (!values) return text;
  return text.replace(/\{(\w+)\}/g, (literal, name) =>
    Object.hasOwn(values, name) ? String(values[name]) : literal,
  );
}

/** The wording used when the caller injects none: English, en-US formats. */
const ENGLISH = Object.freeze({
  t: fillText,
  formatNumber: (value, options) =>
    Number(value).toLocaleString('en-US', options),
  formatDate: (value, options) =>
    new Date(value).toLocaleString('en-US', options),
  isolate: (text) => String(text),
});

/**
 * The wording functions for one call: each injected function, else its
 * English default.
 * @param {{t?: Function, formatNumber?: Function, formatDate?: Function, isolate?: Function}} [i18n]
 */
function wording(i18n) {
  const pick = (name) =>
    typeof i18n?.[name] === 'function' ? i18n[name] : ENGLISH[name];
  return {
    t: pick('t'),
    formatNumber: pick('formatNumber'),
    formatDate: pick('formatDate'),
    isolate: pick('isolate'),
  };
}

/**
 * The English parameter names server/providers/usgsWater.js sends
 * (USGS_PARAM_NAMES), as msg() text for t() when a card is built.
 */
const PARAMETER_LABELS = Object.freeze({
  'Gage height': msg('Gage height'),
  Discharge: msg('Discharge'),
  'Lake/reservoir stage': msg('Lake/reservoir stage'),
  'Lake elevation above NGVD29': msg('Lake elevation above NGVD29'),
  'Lake elevation above NAVD88': msg('Lake elevation above NAVD88'),
});

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

/**
 * `19.6`, `1,132.02`, `63,800` (en) — at most 2 decimals, in the language of
 * the injected `formatNumber` (en-US without one).
 * @param {*} value
 * @param {{i18n?: object}} [options]
 */
export function formatReadingValue(value, { i18n } = {}) {
  if (value === null || value === undefined || value === '') return '';
  const n = Number(value);
  if (!Number.isFinite(n)) return '';
  const { formatNumber } = wording(i18n);
  return formatNumber(n, { maximumFractionDigits: 2 });
}

/** A parameter name in the injected language; a name we do not list shows as sent. */
function parameterLabel(reading, i18n) {
  const { t } = wording(i18n);
  const name = String(reading?.parameter_name || '').trim();
  if (Object.hasOwn(PARAMETER_LABELS, name)) return t(PARAMETER_LABELS[name]);
  return name || String(reading?.parameter_code || '').trim() || t('Reading');
}

/**
 * `Gage height 3.97 ft`, or '' when the reading has no numeric value.
 * @param {object} reading
 * @param {{i18n?: object}} [options]
 */
export function usgsReadingLine(reading, { i18n } = {}) {
  const value = formatReadingValue(reading?.value, { i18n });
  if (!value) return '';
  const { isolate } = wording(i18n);
  const label = parameterLabel(reading, i18n);
  const rawUnit = String(reading.unit || '').trim();
  const unit = UNIT_TEXT[rawUnit] ?? rawUnit;
  // The value and its unit stay one unit in right-to-left text.
  return `${label} ${isolate(unit ? `${value} ${unit}` : value)}`;
}

/**
 * `as of Oct 4, 5:00 AM CDT` in the viewer's time zone, or ''.
 * @param {string} isoTime
 * @param {{timeZone?: string, i18n?: object}} [options]
 */
export function usgsObservedLine(isoTime, { timeZone, i18n } = {}) {
  const ms = Date.parse(isoTime);
  if (!Number.isFinite(ms)) return '';
  const { t, formatDate } = wording(i18n);
  const time = formatDate(ms, {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    timeZoneName: 'short',
    ...(timeZone ? { timeZone } : {}),
  });
  return t('as of {time}', { time });
}

/**
 * Card detail lines for one gauge: up to USGS_CARD_MAX_READINGS readings,
 * then the newest observation time. A gauge without a usable reading says so
 * instead of showing a bare name.
 * @param {object} props Unwrapped feature properties.
 * @param {{maxReadings?: number, timeZone?: string, i18n?: {t?: Function, formatNumber?: Function, formatDate?: Function, isolate?: Function}}} [options]
 *   `i18n` is the application's wording; English without it.
 * @returns {string[]}
 */
export function usgsWaterCardDetails(
  props,
  { maxReadings = USGS_CARD_MAX_READINGS, timeZone, i18n } = {},
) {
  const { t } = wording(i18n);
  const readings = usgsReadings(props);
  const lines = readings
    .map((reading) => usgsReadingLine(reading, { i18n }))
    .filter(Boolean);
  if (lines.length === 0) return [t('No current reading')];
  const newest = readings
    .map((r) => r.observed_time)
    .filter((time) => Number.isFinite(Date.parse(time)))
    .sort((a, b) => Date.parse(b) - Date.parse(a))[0];
  const observed = usgsObservedLine(newest ?? props?.observed_time, {
    timeZone,
    i18n,
  });
  return observed
    ? [...lines.slice(0, maxReadings), observed]
    : lines.slice(0, maxReadings);
}
