/**
 * Time zone helpers for Solunar: which IANA zone is a map spot in, and where
 * do its local days begin and end. Offline: the zone comes from the bundled
 * `tz-lookup` boundary table (CC0), the clock rules from the browser's Intl.
 */
import tzlookup from 'tz-lookup';

const DAY_MS = 86_400_000;
const FALLBACK_ZONE = 'UTC';

/** True when this runtime knows the zone name. */
export function isKnownZone(zone) {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: zone });
    return true;
  } catch {
    return false;
  }
}

/**
 * IANA zone of a spot ("America/Chicago"). Oceans resolve to an Etc/GMT zone;
 * an invalid point or a zone the runtime lacks falls back to UTC.
 */
export function zoneAt(latDeg, lonDeg) {
  if (!Number.isFinite(latDeg) || !Number.isFinite(lonDeg))
    return FALLBACK_ZONE;
  try {
    const zone = tzlookup(latDeg, lonDeg);
    return isKnownZone(zone) ? zone : FALLBACK_ZONE;
  } catch {
    return FALLBACK_ZONE;
  }
}

const partsFormatters = new Map();
function partsFormatter(zone) {
  let f = partsFormatters.get(zone);
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', {
      timeZone: zone,
      hourCycle: 'h23',
      year: 'numeric',
      month: 'numeric',
      day: 'numeric',
      hour: 'numeric',
      minute: 'numeric',
      second: 'numeric',
    });
    partsFormatters.set(zone, f);
  }
  return f;
}

/** Wall-clock fields of an instant in a zone. */
export function zonedParts(zone, ms) {
  const out = {};
  for (const p of partsFormatter(zone).formatToParts(new Date(ms)))
    if (p.type !== 'literal') out[p.type] = Number(p.value);
  // Some runtimes print local midnight as 24:00 on the PREVIOUS date.
  if (out.hour === 24) {
    const next = new Date(Date.UTC(out.year, out.month - 1, out.day + 1));
    out.year = next.getUTCFullYear();
    out.month = next.getUTCMonth() + 1;
    out.day = next.getUTCDate();
    out.hour = 0;
  }
  return {
    year: out.year,
    month: out.month,
    day: out.day,
    hour: out.hour,
    minute: out.minute,
    second: out.second,
  };
}

/** Zone offset from UTC at an instant, in ms (CST = -6 h). */
export function zoneOffsetMs(zone, ms) {
  const p = zonedParts(zone, ms);
  const wallAsUtc = Date.UTC(
    p.year,
    p.month - 1,
    p.day,
    p.hour,
    p.minute,
    p.second,
  );
  return wallAsUtc - Math.floor(ms / 1000) * 1000;
}

/** True when `ms` is exactly 00:00:00 on the given local calendar date. */
function isLocalMidnight(zone, ms, year, month, day) {
  const p = zonedParts(zone, ms);
  return (
    p.year === year &&
    p.month === month &&
    p.day === day &&
    p.hour === 0 &&
    p.minute === 0 &&
    p.second === 0
  );
}

/**
 * The instant a local calendar day starts in a zone: 00:00 wall clock, or the
 * first instant of that date when a clock change skips 00:00 (Havana and some
 * other zones spring forward AT midnight, so the day starts at 01:00).
 */
export function localDayStartMs(zone, year, month, day) {
  const wall = Date.UTC(year, month - 1, day);
  // 00:00 under the offset in force the day before, that day, and the day after
  const candidates = [-DAY_MS, 0, DAY_MS]
    .map((shift) => wall - zoneOffsetMs(zone, wall + shift))
    .filter((c) => isLocalMidnight(zone, c, year, month, day));
  if (candidates.length) return Math.min(...candidates);
  // 00:00 does not exist that day: first instant whose local date is the day
  const STEP = 15 * 60_000;
  const sameDay = (ms) => {
    const p = zonedParts(zone, ms);
    return p.year === year && p.month === month && p.day === day;
  };
  let t = wall - 26 * 60 * 60_000;
  while (!sameDay(t) && t < wall + 26 * 60 * 60_000) t += STEP;
  // refine to the minute
  for (let back = t - STEP; back < t; back += 60_000)
    if (sameDay(back)) return back;
  return t;
}

/** Calendar date `n` days after (year, month, day). */
export function addDays({ year, month, day }, n) {
  const d = new Date(Date.UTC(year, month - 1, day + n));
  return {
    year: d.getUTCFullYear(),
    month: d.getUTCMonth() + 1,
    day: d.getUTCDate(),
  };
}

/** The local calendar date of an instant in a zone. */
export function localDateOf(zone, ms) {
  const { year, month, day } = zonedParts(zone, ms);
  return { year, month, day };
}

/** "2026-11-03" */
export function dateKey({ year, month, day }) {
  const p = (n, w) => String(n).padStart(w, '0');
  return `${p(year, 4)}-${p(month, 2)}-${p(day, 2)}`;
}

export { DAY_MS };
