import { formatDate, t } from '../i18n/index.js';

// Clocks and daylight for the Context panel: the local time at a spot (from
// the time zone its weather reading names), UTC, how long the sun is up at a
// latitude, and how much of the Earth is in daylight.

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

/**
 * The time line every Context state shows: "10:14 local, 16:14 UTC", or UTC
 * alone while the spot's time zone is not known.
 * @param {{timeZone?: ?string, utcOffsetSeconds?: ?number}|null} zone
 * @param {number} [now]
 */
export function clockLine(zone, now = Date.now()) {
  const utc = utcClock(now);
  const local = localClock(zone, now);
  return local
    ? t('{local} local, {utc} UTC', { local, utc })
    : t('{utc} UTC', { utc });
}

const RAD = Math.PI / 180;
const daysSince2000 = (now) => (now - Date.UTC(2000, 0, 1, 12)) / 86_400_000;

/** The sun's declination and right ascension, from the usual low-precision formula. */
function sunPosition(now) {
  const d = daysSince2000(now);
  const g = (357.529 + 0.98560028 * d) * RAD;
  const q = 280.459 + 0.98564736 * d;
  const ecliptic = (q + 1.915 * Math.sin(g) + 0.02 * Math.sin(2 * g)) * RAD;
  const tilt = (23.439 - 0.00000036 * d) * RAD;
  return {
    d,
    ra: Math.atan2(Math.cos(tilt) * Math.sin(ecliptic), Math.cos(ecliptic)),
    dec: Math.asin(Math.sin(tilt) * Math.sin(ecliptic)),
  };
}

/** The sun's elevation above the horizon at a point, in degrees. */
function sunElevation(lat, lon, now = Date.now()) {
  const { d, ra, dec } = sunPosition(now);
  const sidereal = ((18.697374558 + 24.06570982441908 * d) % 24) * 15;
  const hourAngle = (sidereal + lon) * RAD - ra;
  return (
    Math.asin(
      Math.sin(lat * RAD) * Math.sin(dec) +
        Math.cos(lat * RAD) * Math.cos(dec) * Math.cos(hourAngle),
    ) / RAD
  );
}

/**
 * How long the sun is up today at a latitude, in minutes (sunrise to sunset,
 * with the usual 0.833° for refraction and the sun's size): 0 in polar night,
 * 1440 in midnight sun.
 */
export function dayLengthMinutes(lat, now = Date.now()) {
  const { dec } = sunPosition(now);
  const cosH =
    (Math.sin(-0.833 * RAD) - Math.sin(lat * RAD) * Math.sin(dec)) /
    (Math.cos(lat * RAD) * Math.cos(dec));
  if (cosH >= 1) return 0;
  if (cosH <= -1) return 1440;
  return Math.round(((2 * Math.acos(cosH)) / RAD / 15) * 60);
}

/** The share of the Earth's surface in daylight now, 0 to 1. */
export function daylightShare(now = Date.now()) {
  // Sampled on an equal-area grid: bands of equal sine of latitude.
  let lit = 0;
  let all = 0;
  for (let band = 0; band < 36; band++) {
    const lat = Math.asin(-1 + (2 * (band + 0.5)) / 36) / RAD;
    for (let lon = -175; lon < 180; lon += 10) {
      all++;
      if (sunElevation(lat, lon, now) > -0.833) lit++;
    }
  }
  return lit / all;
}
