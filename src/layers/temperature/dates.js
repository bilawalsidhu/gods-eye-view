import { FIRST_MONTH } from './policy.js';

/** @param {number} epochMs Instant. @returns {string} UTC calendar date, `YYYY-MM-DD`. */
export function utcDate(epochMs) {
  return new Date(epochMs).toISOString().slice(0, 10);
}

/** @param {string} date ISO date. @returns {number} Month of the year, 0-based. */
export function monthIndex(date) {
  return Number(date.slice(5, 7)) - 1;
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
  return Array.from({ length: 12 }, (_, month) =>
    utcDate(Date.UTC(year, month, 1)),
  ).filter((date) => date >= FIRST_MONTH && date <= latest);
}
