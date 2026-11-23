/**
 * Magnetic declination for "Point at the sky".
 *
 * Phone compasses (iOS webkitCompassHeading, Android
 * deviceorientationabsolute / AbsoluteOrientationSensor) measure against
 * MAGNETIC north; the sky is drawn against TRUE north. True azimuth =
 * magnetic azimuth + declination (east positive).
 *
 * Model: the World Magnetic Model WMM2025 (NOAA NCEI / BGS, US-government
 * work) as bundled by npm `geomagnetism` 0.2.0 (Apache-2.0; its
 * data/wmm-2025.json is valid 2024-11-13 .. 2029-11-13). Outside the model's
 * validity the package throws; we return null and the UI says "declination
 * unknown" (the Align step still fixes the heading).
 * Checked against the NOAA calculator to < 0.001 deg (declination.test.mjs).
 */
import geomagnetism from 'geomagnetism';

export const WMM_MODEL_NAME = 'WMM-2025';
/** Cache cell: 0.1 deg in lat/lon (a declination changes ~0.01 deg there). */
const CELL_DEG = 0.1;
const DAY_MS = 86_400_000;
const cache = new Map();
const CACHE_MAX = 64;

const finite = (value) => Number.isFinite(Number(value));

/**
 * Declination in degrees (east positive) at a place and instant, or null
 * when the inputs are invalid or outside the bundled model's validity.
 * Cached per 0.1 deg cell and UTC day.
 */
export function declinationDeg(latDeg, lonDeg, ms = Date.now(), heightKm = 0) {
  if (!finite(latDeg) || !finite(lonDeg) || !finite(ms)) return null;
  const lat = Number(latDeg);
  const lon = Number(lonDeg);
  if (Math.abs(lat) > 90 || Math.abs(lon) > 540) return null;
  const key = `${Math.round(lat / CELL_DEG)},${Math.round(lon / CELL_DEG)},${Math.floor(Number(ms) / DAY_MS)},${Math.round(Number(heightKm) || 0)}`;
  if (cache.has(key)) return cache.get(key);
  let value = null;
  try {
    const model = geomagnetism.model(new Date(Number(ms)));
    const point = model.point([lat, lon, Number(heightKm) || 0]);
    value = Number.isFinite(point?.decl) ? point.decl : null;
  } catch {
    value = null; // outside the WMM validity window
  }
  if (cache.size >= CACHE_MAX) cache.delete(cache.keys().next().value);
  cache.set(key, value);
  return value;
}

/** True azimuth (degrees, [0, 360)) from a magnetic one. */
export function magneticToTrue(magneticAzDeg, declDeg) {
  const v = (Number(magneticAzDeg) + (Number(declDeg) || 0)) % 360;
  return v < 0 ? v + 360 : v;
}

/** "+1.7° E" / "-12.5° W" for the status line. */
export function declinationText(declDeg) {
  if (!Number.isFinite(declDeg)) return 'declination unknown';
  const side = declDeg >= 0 ? 'E' : 'W';
  return `declination ${Math.abs(declDeg).toFixed(1)}° ${side}`;
}
