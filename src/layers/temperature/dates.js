import { FIRST_MONTH } from './policy.js';

const MONTHS = [
  'Jan',
  'Feb',
  'Mar',
  'Apr',
  'May',
  'Jun',
  'Jul',
  'Aug',
  'Sep',
  'Oct',
  'Nov',
  'Dec',
];

/** @param {number} epochMs Instant. @returns {string} UTC calendar date, `YYYY-MM-DD`. */
export function utcDate(epochMs) {
  return new Date(epochMs).toISOString().slice(0, 10);
}

/** @param {string} date ISO date. @returns {number} Month of the year, 0-based. */
export function monthIndex(date) {
  return Number(date.slice(5, 7)) - 1;
}

/** @param {string} date ISO date. @returns {string} Month and year, e.g. `Aug 2026`. */
export function monthName(date) {
  return `${MONTHS[monthIndex(date)]} ${date.slice(0, 4)}`;
}

/**
 * What one frame shows, in words: the product and the month it averages.
 * @param {string} date Frame time key (first of the month).
 * @returns {string} Frame label.
 */
export function frameLabel(date) {
  return `monthly mean, ${date.slice(0, 7)}`;
}

/**
 * Candidate months for the newest published mean, newest first.
 * @param {number} now Current instant in epoch milliseconds.
 * @param {number} count How many months back to offer.
 * @returns {Array<string>} First-of-month time keys, newest first.
 */
export function recentMonths(now, count) {
  const today = new Date(now);
  return Array.from({ length: Math.max(1, Math.floor(count)) }, (_, back) =>
    utcDate(Date.UTC(today.getUTCFullYear(), today.getUTCMonth() - back, 1)),
  );
}

/**
 * The months of a calendar year that could be published: none before the
 * product's first month, none after the newest one.
 * @param {number} year Calendar year.
 * @param {string} latest Newest published month.
 * @returns {Array<string>} First-of-month time keys, oldest first.
 */
export function yearMonths(year, latest) {
  return MONTHS.map((_, month) => utcDate(Date.UTC(year, month, 1))).filter(
    (date) => date >= FIRST_MONTH && date <= latest,
  );
}
