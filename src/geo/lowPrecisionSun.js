// USNO low-precision solar coordinates: about 1′ within centuries of J2000.
import { norm360 } from './vector.js';

const D2R = Math.PI / 180;

/**
 * The Sun's apparent ecliptic longitude and the obliquity of the ecliptic at
 * a UTC epoch time in milliseconds, both in radians.
 * @param {number} dateMs
 * @returns {{ eclipticLongitudeRad: number, obliquityRad: number }}
 */
export function lowPrecisionSun(dateMs) {
  const D = dateMs / 86400000 + 2440587.5 - 2451545.0; // days since J2000.0
  const g = norm360(357.529 + 0.98560028 * D) * D2R;
  const q = norm360(280.459 + 0.98564736 * D);
  const eclipticLongitudeRad =
    norm360(q + 1.915 * Math.sin(g) + 0.02 * Math.sin(2 * g)) * D2R;
  const obliquityRad = (23.439 - 0.00000036 * D) * D2R;
  return { eclipticLongitudeRad, obliquityRad };
}
