import { formatDate, formatNumber, t } from '../../i18n/index.js';
import { kelvinToCelsius } from './colormap.js';

/**
 * @module temperature/labels
 * @description The surface-temperature layer's display text, in the active
 * locale. Kept apart from `dates.js` and `colormap.js` because those serve the
 * portable source export, which may not reach the browser i18n runtime.
 */

const ONE_DECIMAL = Object.freeze({
  minimumFractionDigits: 1,
  maximumFractionDigits: 1,
});

const utcDay = (date) => Date.parse(`${date}T00:00:00Z`);

/** @param {string} date ISO date. @returns {string} Month and year, e.g. `Aug 2026`. */
export function monthName(date) {
  return formatDate(utcDay(date), {
    month: 'short',
    year: 'numeric',
    timeZone: 'UTC',
  });
}

/** @param {number} index Month of the year, 0-based. @returns {string} Its initial, e.g. `J`. */
export function monthInitial(index) {
  return formatDate(Date.UTC(2026, index, 15), {
    month: 'narrow',
    timeZone: 'UTC',
  });
}

/**
 * What one frame shows, in words: the product and the month it averages.
 * @param {string} date Frame time key (first of the month).
 * @returns {string} Frame label.
 */
export function frameLabel(date) {
  return t('monthly mean, {month}', { month: date.slice(0, 7) });
}

/**
 * A colour-map stop as the temperature the operator reads.
 *
 * A range, not a single number: the product quantises into 0.6 K buckets, so
 * one figure would be false precision. The catch-all ends read as bounds.
 * @param {?object} stop Matching stop, or null.
 * @returns {string} Display text.
 */
export function readingText(stop) {
  if (!stop) return t('No clear-sky value');
  const celsius = (kelvin) =>
    formatNumber(kelvinToCelsius(kelvin), ONE_DECIMAL);
  // Symbols and numbers only: nothing here to translate.
  if (stop.clampLow) return `≤ ${celsius(stop.highK)} °C`;
  if (stop.clampHigh) return `≥ ${celsius(stop.lowK)} °C`;
  return t('{low} to {high} °C', {
    low: celsius(stop.lowK),
    high: celsius(stop.highK),
  });
}
