/**
 * @module sondehubFallback
 * @description Normalizes SondeHub's `/sondes` response (live radiosonde
 * telemetry, keyed by serial) into a flat, JSON-safe array this app renders.
 *
 * SondeHub (sondehub.org) aggregates amateur receiver uploads of weather
 * balloon (radiosonde) telemetry worldwide — the same volunteer-network model
 * as adsb.lol for aircraft. Its `/sondes?lat&lon&distance&last` endpoint
 * returns a dict keyed by serial number, one flat telemetry record per key
 * (not the nested per-timestamp shape `/sondes/telemetry` uses).
 */

function finiteNumber(value) {
  if (value === null || value === undefined || value === '') return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function text(value) {
  const trimmed = String(value ?? '').trim();
  return trimmed || null;
}

/**
 * One radiosonde record, or null when it carries no usable position.
 * @param {object} raw One value from the `/sondes` response dict.
 * @returns {object|null}
 */
export function normalizeSondehubBalloon(raw) {
  const serial = text(raw?.serial);
  const lat = finiteNumber(raw?.lat);
  const lon = finiteNumber(raw?.lon);
  if (!serial || lat === null || lon === null) return null;

  const timeMs = Date.parse(raw?.datetime || '');
  const verticalRateMps = finiteNumber(raw?.vel_v);
  return {
    serial,
    lat,
    lon,
    altitudeM: finiteNumber(raw?.alt),
    headingDeg: finiteNumber(raw?.heading),
    speedMps: finiteNumber(raw?.vel_h),
    verticalRateMps,
    // Burst is a one-way trip: a radiosonde only ever ascends until the
    // latex envelope pops, then falls under its parachute — there is no
    // "level flight" phase to distinguish, so sign-of-vel_v alone is a
    // reliable phase read (unlike an aircraft's climb/descent, which says
    // nothing about where in its flight it is).
    phase: verticalRateMps === null ? 'unknown' : (verticalRateMps >= -1 ? 'ascending' : 'descending'),
    manufacturer: text(raw?.manufacturer),
    type: text(raw?.type) || text(raw?.subtype),
    frequencyMhz: finiteNumber(raw?.frequency),
    tempC: finiteNumber(raw?.temp),
    uploaderCallsign: text(raw?.uploader_callsign),
    timeMs: Number.isFinite(timeMs) ? timeMs : null,
  };
}

/**
 * Normalize a full `/sondes` response (dict keyed by serial) to a flat array.
 * @param {object} payload Parsed JSON body.
 * @returns {{time: number, balloons: Array<object>}}
 */
export function normalizeSondehubResponse(payload) {
  const nowSeconds = Math.floor(Date.now() / 1000);
  const entries = payload && typeof payload === 'object' ? Object.values(payload) : [];
  const balloons = entries.map(normalizeSondehubBalloon).filter(Boolean);
  return { time: nowSeconds, balloons };
}
