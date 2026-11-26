import { zonedParts } from '../data/railTimeZones.js';
import { formatDate, formatNumber, t } from '../i18n/index.js';

/** Localized age of an elapsed observation. */
export function contextAgeText(ms) {
  const seconds = Math.max(0, Math.round(ms / 1000));
  if (seconds < 60) return t('{n} s ago', { n: formatNumber(seconds) });
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return t('{n} min ago', { n: formatNumber(minutes) });
  const hours = Math.round(minutes / 60);
  if (hours < 48) return t('{n} h ago', { n: formatNumber(hours) });
  return t('{n} d ago', { n: formatNumber(Math.round(hours / 24)) });
}

const pad = (n) => String(n).padStart(2, '0');

/** "HH:MM" in UTC. */
export function utcClock(now = Date.now()) {
  const at = new Date(now);
  return `${pad(at.getUTCHours())}:${pad(at.getUTCMinutes())}`;
}

/**
 * The time of day at a spot, from what its weather reading says about its
 * time zone: the zone's name when it has one, else its offset from UTC.
 * Without either it is not known (`null`), and the panel shows UTC instead.
 * @param {{timeZone?: ?string, utcOffsetSeconds?: ?number}|null} zone
 * @param {number} [now]
 * @returns {?string} "HH:MM", 24-hour.
 */
export function localClock(zone, now = Date.now()) {
  if (zone?.timeZone) {
    try {
      return formatDate(now, {
        hour: '2-digit',
        minute: '2-digit',
        hourCycle: 'h23',
        timeZone: zone.timeZone,
      });
    } catch {
      // An unknown zone name: fall back to the offset.
    }
  }
  if (Number.isFinite(zone?.utcOffsetSeconds))
    return utcClock(now + zone.utcOffsetSeconds * 1000);
  return null;
}

/** Local and UTC time when the zone is known, otherwise UTC with a loading status while reading. */
export function clockLine(zone, now = Date.now(), loading = false) {
  const utc = utcClock(now);
  const local = localClock(zone, now);
  if (local) return t('{local} local, {utc} UTC', { local, utc });
  return loading
    ? t('{utc} UTC · local time loading…', { utc })
    : t('{utc} UTC', { utc });
}

const RAD = Math.PI / 180;
const DAY_MS = 86_400_000;
const SUNRISE_ALTITUDE_SINE = Math.sin(-0.833 * RAD);
const daysSince2000 = (now) => (now - Date.UTC(2000, 0, 1, 12)) / DAY_MS;

/** The sun's declination, from the low-precision solar formula. */
function sunDeclination(now) {
  const d = daysSince2000(now);
  const g = (357.529 + 0.98560028 * d) * RAD;
  const q = 280.459 + 0.98564736 * d;
  const ecliptic = (q + 1.915 * Math.sin(g) + 0.02 * Math.sin(2 * g)) * RAD;
  const tilt = (23.439 - 0.00000036 * d) * RAD;
  return Math.asin(Math.sin(tilt) * Math.sin(ecliptic));
}

/**
 * Approximate daylight on the spot's date, using one declination sample
 * for that date and the usual 0.833° sunrise/sunset threshold.
 */
export function dayLengthMinutes(
  lat,
  now = Date.now(),
  { lon = 0, zone = null } = {},
) {
  const offsetMs = Number.isFinite(zone?.utcOffsetSeconds)
    ? zone.utcOffsetSeconds * 1000
    : (lon / 360) * DAY_MS;
  let day = Math.floor((now + offsetMs) / DAY_MS);
  if (zone?.timeZone) {
    try {
      const { year, month, day: date } = zonedParts(now, zone.timeZone);
      day = Date.UTC(year, month - 1, date) / DAY_MS;
    } catch {
      // The runtime does not know the zone. Use its offset or solar time.
    }
  }
  const dec = sunDeclination((day + 0.5) * DAY_MS);
  const cosH =
    (SUNRISE_ALTITUDE_SINE - Math.sin(lat * RAD) * Math.sin(dec)) /
    (Math.cos(lat * RAD) * Math.cos(dec));
  if (cosH >= 1) return 0;
  if (cosH <= -1) return 1440;
  return Math.round(((2 * Math.acos(cosH)) / RAD / 15) * 60);
}
