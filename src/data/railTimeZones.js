/**
 * @module railTimeZones
 * @description Wall-clock arithmetic in IANA time zones for rail timetables,
 * built on Intl.DateTimeFormat only.
 *
 * GTFS measures stop times from "noon minus 12 hours" of the service day in
 * the agency's time zone: midnight on ordinary days, and the hour that keeps
 * every timetable time unambiguous on the two days a year the clocks change.
 * `serviceDayOriginMs` returns that instant; a stop time of `sec` seconds is
 * `origin + sec * 1000`, which also covers times past 24:00:00.
 *
 * Pure: no Cesium, no DOM, no Node built-ins.
 */

const DAY_MS = 86_400_000;
const formatters = new Map();
const clocks = new Map();

/** Whether `zone` is an IANA zone this runtime knows. */
export function isTimeZone(zone) {
  if (typeof zone !== 'string' || !zone) return false;
  try {
    partsFormatter(zone);
    return true;
  } catch {
    return false;
  }
}

function partsFormatter(zone) {
  let formatter = formatters.get(zone);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat('en-US', {
      timeZone: zone,
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    });
    formatters.set(zone, formatter);
  }
  return formatter;
}

/**
 * The wall-clock fields of an instant in a zone.
 * @param {number} epochMs
 * @param {string} zone
 * @returns {{year: number, month: number, day: number, hour: number,
 *   minute: number, second: number}}
 */
export function zonedParts(epochMs, zone) {
  const out = {};
  for (const part of partsFormatter(zone).formatToParts(epochMs))
    if (part.type !== 'literal') out[part.type] = Number(part.value);
  return {
    year: out.year,
    month: out.month,
    day: out.day,
    hour: out.hour % 24,
    minute: out.minute,
    second: out.second,
  };
}

/** UTC offset of a zone at an instant, in ms (east positive). */
export function zoneOffsetMs(epochMs, zone) {
  const p = zonedParts(epochMs, zone);
  const wall = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
  return wall - Math.floor(epochMs / 1000) * 1000;
}

/**
 * The instant a wall-clock time occurs in a zone. In a gap (spring forward)
 * the result is shifted forward by the gap; in an overlap (fall back) the
 * earlier instant is returned.
 */
export function zonedTimeToEpochMs(
  zone,
  year,
  month,
  day,
  hour = 0,
  minute = 0,
  second = 0,
) {
  const wall = Date.UTC(year, month - 1, day, hour, minute, second);
  const first = zoneOffsetMs(wall, zone);
  let guess = wall - first;
  const offset2 = zoneOffsetMs(guess, zone);
  if (offset2 !== first) {
    const alternative = wall - offset2;
    // Prefer the candidate whose wall time round-trips; else the earlier.
    if (zoneOffsetMs(alternative, zone) === offset2)
      guess = Math.min(guess, alternative);
  }
  return guess;
}

/** Parse 'YYYY-MM-DD' or 'YYYYMMDD' into numbers, or null. */
export function parseServiceDate(text) {
  const match = /^(\d{4})-?(\d{2})-?(\d{2})$/.exec(String(text ?? '').trim());
  if (!match) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const check = new Date(Date.UTC(year, month - 1, day));
  if (check.getUTCMonth() !== month - 1 || check.getUTCDate() !== day)
    return null;
  return { year, month, day };
}

/** 'YYYY-MM-DD' of a UTC-day number (days since 1970-01-01). */
export function dateFromDayNumber(dayNumber) {
  return new Date(dayNumber * DAY_MS).toISOString().slice(0, 10);
}

/** UTC-day number of a service date, or NaN. */
export function dayNumberOf(text) {
  const date = parseServiceDate(text);
  return date ? Date.UTC(date.year, date.month - 1, date.day) / DAY_MS : NaN;
}

/** The local calendar date ('YYYY-MM-DD') of an instant in a zone. */
export function localDate(epochMs, zone) {
  const p = zonedParts(epochMs, zone);
  return `${p.year}-${String(p.month).padStart(2, '0')}-${String(p.day).padStart(2, '0')}`;
}

/**
 * The instant GTFS times of a service date count from: noon minus 12 hours,
 * local to `zone`.
 * @param {string} date 'YYYY-MM-DD' or 'YYYYMMDD'.
 * @param {string} zone IANA zone.
 * @returns {number} Epoch ms, or NaN for a malformed date.
 */
export function serviceDayOriginMs(date, zone) {
  const parsed = parseServiceDate(date);
  if (!parsed) return NaN;
  return (
    zonedTimeToEpochMs(zone, parsed.year, parsed.month, parsed.day, 12) -
    12 * 3_600_000
  );
}

/**
 * A 24-hour 'HH:MM' clock string of an instant in a zone.
 * @param {number} epochMs
 * @param {string} zone
 * @returns {string}
 */
export function formatClock(epochMs, zone) {
  if (!Number.isFinite(epochMs)) return '';
  let formatter = clocks.get(zone);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat('en-GB', {
      timeZone: zone,
      hourCycle: 'h23',
      hour: '2-digit',
      minute: '2-digit',
    });
    clocks.set(zone, formatter);
  }
  let hour = '';
  let minute = '';
  for (const part of formatter.formatToParts(epochMs)) {
    if (part.type === 'hour') hour = part.value;
    else if (part.type === 'minute') minute = part.value;
  }
  return `${hour.padStart(2, '0')}:${minute.padStart(2, '0')}`;
}
