/**
 * @module hudLocality
 * @description The locality half of the HUD summary line — either "NEAR <landmark>"
 * or the "SECTOR <lat/lon>" fallback.
 *
 * Split out of `hud.js` purely so it is unit-testable: `hud.js` pulls in the `mgrs`
 * CommonJS package, which Vite resolves but plain Node cannot import by named export.
 */
import { t } from './i18n/index.js';

/**
 * Maximum distance to a curated POI that still reads as "NEAR" it.
 *
 * The 2026-08-20 QA hunt found the HUD announcing NEAR SACRE-COEUR (PARIS) 2470KM
 * while parked over Moscow, and NEAR LINCOLN MEMORIAL 962KM over Chicago — the old
 * bound was 2,500 km, roughly a continent. The POI catalogue only covers eight
 * cities, so anywhere else on Earth matched whichever landmark happened to be
 * closest and reported an absurd distance as if it were a locality.
 *
 * 150 km is metro scale: a camera over San Francisco still reads NEAR ALCATRAZ, a
 * camera over DC still reads NEAR its monuments, and Chicago (962 km from the
 * nearest catalogued POI) correctly falls through to the SECTOR readout that
 * already worked for Honolulu and Rio.
 */
export const NEAR_POI_MAX_KM = 150;

/**
 * Format one hemisphere-tagged coordinate, e.g. `21.33N` / `157.80W`.
 * @param {number} value Signed decimal degrees.
 * @param {string} positive Suffix when the value is >= 0.
 * @param {string} negative Suffix when the value is < 0.
 * @returns {string}
 */
function coordinateTag(value, positive, negative) {
  return `${Math.abs(value).toFixed(2)}${value >= 0 ? positive : negative}`;
}

/**
 * Build the locality tag for the HUD summary line.
 *
 * @param {{poi: string, city: string, distKm: number}|null|undefined} nearest
 *   Closest catalogued POI with its great-circle distance, or null when the
 *   catalogue is empty.
 * @param {number} latDeg Camera latitude in decimal degrees.
 * @param {number} lonDeg Camera longitude in decimal degrees.
 * @returns {string} `NEAR <POI> (<CITY>) <N>KM` within the bound (inclusive),
 *   otherwise `SECTOR <lat> <lon>`.
 */
export function composeLocalityTag(nearest, latDeg, lonDeg) {
  const distKm = Number(nearest?.distKm);
  if (nearest && Number.isFinite(distKm) && distKm <= NEAR_POI_MAX_KM) {
    // POI and city names are catalogued proper nouns and stay verbatim.
    return t('hud.locality.near', {
      poi: String(nearest.poi).toUpperCase(),
      city: String(nearest.city).toUpperCase(),
      n: Math.round(distKm),
    });
  }
  return t('hud.locality.sector', {
    lat: coordinateTag(latDeg, 'N', 'S'),
    lon: coordinateTag(lonDeg, 'E', 'W'),
  });
}
