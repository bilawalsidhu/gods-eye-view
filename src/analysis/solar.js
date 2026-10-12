import { getPosition, getTimes } from '../vendor/suncalc/index.js';

/** Format a wall-clock minute in an explicitly selected IANA time zone. */
export function wallTime(date, timeZone) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(date);
  const p = Object.fromEntries(parts.map((x) => [x.type, x.value]));
  return `${p.year}-${p.month}-${p.day}T${p.hour}:${p.minute}`;
}
export function zoneOffsetMinutes(date, timeZone) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(date);
  const p = Object.fromEntries(parts.map((x) => [x.type, Number(x.value)]));
  return (
    (Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second) -
      Math.floor(date.valueOf() / 1000) * 1000) /
    60000
  );
}
/** Reject DST gaps; explicitly report repeated times and choose their earlier instant. */
export function zonedInstant(value, timeZone) {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(value))
    throw Error('Choose a complete date and time.');
  const target = new Date(value + 'Z');
  if (
    !Number.isFinite(target.valueOf()) ||
    target.getUTCFullYear() < 1900 ||
    target.getUTCFullYear() > 2100
  )
    throw Error('Choose a date from 1900 to 2100.');
  let candidate = target;
  for (let n = 0; n < 6; n++)
    candidate = new Date(
      target.valueOf() - zoneOffsetMinutes(candidate, timeZone) * 60000,
    );
  if (wallTime(candidate, timeZone) !== value)
    throw Error(
      'This clock time does not exist in the chosen time zone. Choose another time.',
    );
  const matches = [candidate];
  for (const minutes of [-120, -60, -30, 30, 60, 120]) {
    const alternate = new Date(candidate.valueOf() + minutes * 60000);
    if (wallTime(alternate, timeZone) === value) matches.push(alternate);
  }
  matches.sort((a, b) => a - b);
  return { date: matches[0], ambiguous: matches.length > 1 };
}
/** Local solar calculation; shadow assumes a vertical object and level unobstructed ground. */
export function calculateSun({ lat, lon, value, timeZone, heightM }) {
  if (
    !Number.isFinite(lat) ||
    Math.abs(lat) > 89.9 ||
    !Number.isFinite(lon) ||
    Math.abs(lon) > 180
  )
    throw Error('Choose a valid map point away from the exact poles.');
  if (!Number.isFinite(heightM) || heightM < 0 || heightM > 200)
    throw Error('Object height must be between 0 and 200 meters.');
  const { date, ambiguous } = zonedInstant(value, timeZone);
  const position = getPosition(date, lat, lon),
    times = getTimes(date, lat, lon, 0, zoneOffsetMinutes(date, timeZone));
  const shadowLengthM =
    position.altitude >= 1
      ? heightM / Math.tan((position.altitude * Math.PI) / 180)
      : null;
  return {
    instant: date.toISOString(),
    timeZone,
    ambiguous,
    azimuthDeg: position.azimuth,
    altitudeDeg: position.altitude,
    shadowBearingDeg: (position.azimuth + 180) % 360,
    shadowLengthM,
    sunrise: times.sunrise?.toISOString() || null,
    sunset: times.sunset?.toISOString() || null,
    alwaysUp: !!times.alwaysUp,
    alwaysDown: !!times.alwaysDown,
  };
}
/** Spherical destination for an approximate ground sketch, not terrain ray tracing. */
export function shadowEndpoint(lat, lon, bearingDeg, distanceM) {
  const r = Math.PI / 180,
    a = distanceM / 6371008.8,
    p = lat * r,
    l = lon * r,
    b = bearingDeg * r;
  const q = Math.asin(
    Math.sin(p) * Math.cos(a) + Math.cos(p) * Math.sin(a) * Math.cos(b),
  );
  return {
    lat: q / r,
    lon:
      (((l +
        Math.atan2(
          Math.sin(b) * Math.sin(a) * Math.cos(p),
          Math.cos(a) - Math.sin(p) * Math.sin(q),
        )) /
        r +
        540) %
        360) -
      180,
  };
}
