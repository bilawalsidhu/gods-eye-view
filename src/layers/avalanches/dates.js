import { formatDate } from '../../i18n/index.js';
import { FORECAST_DAYS, PAST_DAYS, SEASON } from './policy.js';

const DAY_MS = 86_400_000;

/** @param {number} epochMs Instant. @returns {string} UTC calendar date. */
export function utcDate(epochMs) {
  return new Date(epochMs).toISOString().slice(0, 10);
}

/** @param {string} date ISO date. @param {number} days Offset. @returns {string} Shifted date. */
export function addDays(date, days) {
  return utcDate(Date.parse(`${date}T00:00:00Z`) + days * DAY_MS);
}

/** @param {string} date ISO date. @returns {number} Start of that UTC day, epoch ms. */
export function dayStartMs(date) {
  return Date.parse(`${date}T00:00:00Z`);
}

/**
 * The days a window covers: observed history up to the anchor, then the
 * forecast days after it.
 * @param {string} anchor The window's "today".
 * @returns {Array<{date:string, offset:number, forecast:boolean}>}
 */
export function windowDays(anchor) {
  const days = [];
  for (let offset = -PAST_DAYS; offset <= FORECAST_DAYS; offset++)
    days.push({ date: addDays(anchor, offset), offset, forecast: offset > 0 });
  return days;
}

/** @param {string} date ISO date. @returns {string} Weekday, day and month in the active locale. */
export function dayLabel(date) {
  return formatDate(dayStartMs(date), {
    weekday: 'short',
    day: 'numeric',
    month: 'short',
    timeZone: 'UTC',
  });
}

/** @param {string} date ISO date. @returns {string} Weekday initial in the active locale. */
export function dayInitial(date) {
  return formatDate(dayStartMs(date), { weekday: 'narrow', timeZone: 'UTC' });
}

/** @param {string} date ISO date. @returns {boolean} Whether Varsom forecasts on that day. */
export function inSeason(date) {
  const month = Number(date.slice(5, 7));
  return month >= SEASON.startMonth || month <= SEASON.endMonth;
}

/**
 * The season a date belongs to, by its starting year: December 2025 and May
 * 2026 are both season 2025. A date between seasons belongs to the one that
 * just ended, so off-season replay offers the most recent one.
 * @param {string} date ISO date.
 * @returns {number} Season start year.
 */
export function seasonOf(date) {
  const year = Number(date.slice(0, 4));
  const month = Number(date.slice(5, 7));
  return month >= SEASON.startMonth ? year : year - 1;
}

/** @param {number} season Start year. @returns {string} e.g. `2025–26`. */
export function seasonLabel(season) {
  return `${season}–${String(season + 1).slice(2)}`;
}
