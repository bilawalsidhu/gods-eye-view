/**
 * @module hudLocalClock
 * @description The HUD's "local time at the camera subpoint" clock — a rough
 * solar-time estimate from longitude (15° per hour), the same approximation
 * the HUD summary line's `UTC±N` tag has always used, now given a shared name
 * and a visible clock face rather than just a compact offset label.
 *
 * Not a real IANA timezone: no DST, no political boundaries, no coastline
 * carve-outs (China's single UTC+8 zone reads as several different offsets
 * here, for instance). This app carries no timezone-boundary data, so a
 * longitude-based solar estimate is what's available — consistent with how
 * `_estimateSunElevation` and the rest of this HUD's camera-derived metrics
 * already work.
 *
 * Split out of `hud.js` purely so it is unit-testable, same reason as
 * hudLocality.js: hud.js pulls in the `mgrs` CommonJS package, which Vite
 * resolves but plain Node cannot import by named export.
 */

/**
 * Rough UTC offset in whole hours for a longitude, by solar time (15° per
 * hour). Rounds to the nearest hour rather than truncating, so a camera at
 * 7.6°E (Zurich) reads UTC+1, not UTC+0.
 * @param {number} lonDeg Longitude in decimal degrees.
 * @returns {number} Signed whole-hour UTC offset.
 */
export function localUtcOffsetHours(lonDeg) {
  return Math.round(lonDeg / 15);
}

/**
 * Format a signed whole-hour offset as `UTC+N` / `UTC-N` / `UTC+0` — the
 * exact tag the HUD summary line has always shown.
 * @param {number} offsetHours Signed whole-hour offset, e.g. from {@link localUtcOffsetHours}.
 * @returns {string}
 */
export function formatUtcOffsetTag(offsetHours) {
  return `UTC${offsetHours >= 0 ? '+' : ''}${offsetHours}`;
}

/**
 * Format the local wall-clock time at a longitude, for a given instant.
 *
 * Applies the offset by shifting the epoch and reading UTC fields off the
 * shifted instant, which sidesteps the BROWSER's own timezone entirely — the
 * viewer's system clock never enters this calculation. That matters here
 * because the camera subpoint (what this clock reports) and the operator's
 * real location (what the browser's timezone reports) are usually different
 * places; using `toLocaleTimeString()` or similar would silently answer the
 * wrong question.
 * @param {number} nowMs Epoch milliseconds — pass `Date.now()` in production;
 *   parameterized so tests are deterministic.
 * @param {number} lonDeg Longitude in decimal degrees.
 * @returns {{time: string, offsetTag: string}} `"HH:MM:SS"` and `"UTC±N"`.
 */
export function formatLocalClock(nowMs, lonDeg) {
  const offsetHours = localUtcOffsetHours(lonDeg);
  const shifted = new Date(nowMs + offsetHours * 3_600_000);
  const h = String(shifted.getUTCHours()).padStart(2, '0');
  const m = String(shifted.getUTCMinutes()).padStart(2, '0');
  const s = String(shifted.getUTCSeconds()).padStart(2, '0');
  return { time: `${h}:${m}:${s}`, offsetTag: formatUtcOffsetTag(offsetHours) };
}
