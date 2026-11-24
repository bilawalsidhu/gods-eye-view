// Pure records for the SondeHub radiosonde layer, shared by the local proxy
// (server/providers/sondehub.js) and the browser. A portable module: no
// i18n, no renderer.

/** Frames older than this leave the map. */
export const SONDE_MAX_AGE_MS = 3 * 60 * 60_000;
/** A sonde not heard for this long is shown as silent (landed or out of range). */
export const SONDE_SILENT_MS = 15 * 60_000;
/** Vertical speed, m/s, past which a sonde counts as rising or falling. */
const CLIMB_THRESHOLD = 1;

/** Display states, in legend order. */
export const SONDE_STATES = Object.freeze([
  Object.freeze({ id: 'rising', color: '#5ec8ff' }),
  Object.freeze({ id: 'falling', color: '#ff9f43' }),
  Object.freeze({ id: 'silent', color: '#9aa3ad' }),
]);

const number = (value) => {
  if (value === null || value === undefined || value === '') return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
};
const text = (value, max = 40) =>
  typeof value === 'string' && value.trim() ? value.trim().slice(0, max) : null;

/** Milliseconds of an ISO time, read as UTC when it carries no zone, or null. */
export function parseSondeTime(value) {
  if (typeof value !== 'string' || !value) return null;
  const zoned = /([zZ]|[+-]\d\d:?\d\d)$/.test(value) ? value : `${value}Z`;
  const ms = Date.parse(zoned);
  return Number.isFinite(ms) ? ms : null;
}

/**
 * One SondeHub telemetry frame as the balloon's own fields, or null when it
 * has no serial, time or position. Receiver details (callsign, station
 * position, antenna) are dropped: they describe the hobbyist who heard it.
 */
export function normalizeSondeFrame(frame) {
  if (!frame || typeof frame !== 'object') return null;
  const serial = text(frame.serial, 32);
  const time = parseSondeTime(frame.datetime);
  const lat = number(frame.lat);
  const lon = number(frame.lon);
  const altM = number(frame.alt);
  if (
    !serial ||
    !/^[\w.-]+$/.test(serial) ||
    time === null ||
    lat === null ||
    lon === null ||
    Math.abs(lat) > 90 ||
    Math.abs(lon) > 180 ||
    (lat === 0 && lon === 0)
  )
    return null;
  const humidity = number(frame.humidity);
  const pressure = number(frame.pressure);
  const frequency = number(frame.frequency);
  return {
    serial,
    time,
    lat,
    lon,
    altM: altM !== null && altM > -500 && altM < 60_000 ? altM : null,
    climbMps: number(frame.vel_v),
    speedMps: number(frame.vel_h),
    headingDeg: number(frame.heading),
    type: text(frame.subtype) ?? text(frame.type),
    manufacturer: text(frame.manufacturer),
    frequencyMhz: frequency !== null && frequency > 0 ? frequency : null,
    tempC: number(frame.temp),
    humidityPct:
      humidity !== null && humidity >= 0 && humidity <= 100 ? humidity : null,
    pressureHpa: pressure !== null && pressure > 0 ? pressure : null,
  };
}

/**
 * Fold frames into a store of the latest frame per serial: a frame replaces
 * the stored one only when it is newer. Returns how many it changed.
 */
export function mergeSondeFrames(store, frames) {
  let changed = 0;
  for (const frame of frames) {
    const row = normalizeSondeFrame(frame);
    if (!row) continue;
    const previous = store.get(row.serial);
    if (previous && previous.time >= row.time) continue;
    store.set(row.serial, row);
    changed += 1;
  }
  return changed;
}

/** Drop rows older than `maxAgeMs`; the count dropped. */
export function pruneSondes(store, nowMs, maxAgeMs = SONDE_MAX_AGE_MS) {
  let dropped = 0;
  for (const [serial, row] of store)
    if (nowMs - row.time > maxAgeMs) {
      store.delete(serial);
      dropped += 1;
    }
  return dropped;
}

/** `rising`, `falling` or `silent` (not heard lately, or neither). */
export function sondeState(row, nowMs) {
  if (nowMs - row.time > SONDE_SILENT_MS) return 'silent';
  if (row.climbMps !== null && row.climbMps >= CLIMB_THRESHOLD) return 'rising';
  if (row.climbMps !== null && row.climbMps <= -CLIMB_THRESHOLD)
    return 'falling';
  return 'silent';
}

/**
 * A SondeHub prediction as a path and landing point, or null. `data` is the
 * predicted track as a JSON string of `{time (s), lat, lon, alt}` points.
 */
export function normalizePrediction(row) {
  if (!row || typeof row !== 'object') return null;
  const serial = text(row.vehicle, 32);
  let points = row.data;
  if (typeof points === 'string') {
    try {
      points = JSON.parse(points);
    } catch {
      return null;
    }
  }
  if (!serial || !Array.isArray(points)) return null;
  const path = [];
  for (const point of points) {
    const lat = number(point?.lat);
    let lon = number(point?.lon);
    const altM = number(point?.alt);
    const seconds = number(point?.time);
    if (lat === null || lon === null || Math.abs(lat) > 90) continue;
    // Tawhiri can answer in 0..360 longitude.
    if (lon > 180) lon -= 360;
    if (Math.abs(lon) > 180) continue;
    path.push({
      lat,
      lon,
      altM: altM !== null ? Math.max(0, altM) : 0,
      time: seconds !== null ? seconds * 1000 : null,
    });
  }
  if (path.length < 2) return null;
  const landing = path.at(-1);
  const burst = number(row.burst_altitude);
  return {
    serial,
    path,
    landing: { lat: landing.lat, lon: landing.lon, time: landing.time },
    burstAltM: burst !== null && burst > 0 ? burst : null,
    descending: Number(row.descending) === 1 || row.descending === true,
  };
}

/** The SondeHub tracker page for a sonde. */
export const sondeTrackerUrl = (serial) =>
  `https://sondehub.org/${encodeURIComponent(serial)}`;

/** Where the layer's data comes from. */
export const SONDE_PROVENANCE = Object.freeze({
  provider: 'SondeHub (Project Horus)',
  dataset: 'Radiosonde telemetry received by volunteer stations',
  url: 'https://sondehub.org/',
  license: 'CC BY-SA 2.0',
});
