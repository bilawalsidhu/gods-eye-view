/**
 * @module firmsLabels
 * @description FIRMS-specific presentation formatting retained after the
 * dedicated card canvas moved into the shared world-overlay host.
 */

import { FRP_RAMP, hexToRgb } from './firmsIntensity.js';

/** Shipped ambient FIRMS card ceiling. Selected fires bypass this cohort. */
export const FIRMS_AMBIENT_COHORT_LIMIT = 18;
export const FIRMS_OVERLAY_SOURCE_ID = 'firms';

/** Refetch-stable identity for one FIRMS detection, including its source feed. */
export function fireDetectionKey(fire) {
  const lat = Number.isFinite(fire?.lat) ? fire.lat.toFixed(4) : 'x';
  const lon = Number.isFinite(fire?.lon) ? fire.lon.toFixed(4) : 'x';
  const acq =
    Number.isFinite(fire?.acqMs) && fire.acqMs > 0 ? String(fire.acqMs) : '0';
  const source =
    satelliteShortName(fire?.satellite) ||
    String(fire?.sensor || '')
      .trim()
      .toUpperCase() ||
    'x';
  return `firms:${lat}:${lon}:${acq}:${source}`;
}

/**
 * Severity accent palette — the FIRMS glow-sprite color stops (the six-stop
 * FRP ramp in firmsIntensity.js) as "r, g, b" strings for card accents.
 */
const ACCENT_RGB = Object.freeze(
  Object.fromEntries(
    FRP_RAMP.map((stop) => [stop.name, hexToRgb(stop.hex).join(', ')]),
  ),
);

/**
 * Severity stop name → "r, g, b" accent string (defaults to the coldest stop).
 * @param {string} stopName - A FRP_RAMP stop name ('blue' … 'red').
 * @returns {string}
 */
export function accentForSeverity(stopName) {
  return ACCENT_RGB[stopName] || ACCENT_RGB[FRP_RAMP[0].name];
}

/**
 * Fire radiative power as shown on a card: "9.9" below 10 MW, "10" once
 * one-decimal rounding reaches 10. "10.0" would sit beside a whole "10".
 * @param {number} frp Megawatts.
 * @returns {string}
 */
export function formatFrpMw(frp) {
  const digits = Number(Number(frp).toFixed(1)) >= 10 ? 0 : 1;
  return Number(frp).toFixed(digits);
}

/** Raw FIRMS satellite code → short display name (N = Suomi NPP). */
export function satelliteShortName(satellite) {
  const s = String(satellite || '')
    .trim()
    .toUpperCase();
  if (s === 'N20' || s === 'NOAA-20') return 'N20';
  if (s === 'N21' || s === 'NOAA-21') return 'N21';
  if (s === 'N' || s === 'NPP' || s === 'SUOMI NPP') return 'SNPP';
  return s ? s.slice(0, 6) : '';
}
