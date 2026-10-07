/**
 * Magnetic local time: where the auroral oval sits relative to the Sun.
 *
 * The oval is not a geographic feature. It is organised around the geomagnetic
 * pole and anchored to the Sun — a ring at roughly fixed magnetic latitude,
 * displaced toward magnetic midnight — and the Earth turns underneath it. Two
 * OVATION forecasts five minutes apart therefore show the same oval rotated
 * about the dipole axis, not a different oval in the same place.
 *
 * That matters for one job only: blending consecutive forecasts. Cross-fading
 * them as flat rasters dissolves one oval while another appears beside it,
 * which reads as a ghost rather than as movement. Rotating the older field
 * forward by the magnetic-local-time difference first lines the two ovals up,
 * so the blend slides.
 *
 * Everything here is arithmetic on dates — no Cesium, no network — so the whole
 * thing is unit testable.
 *
 * @module layers/aurora/magneticLocalTime
 */

const DEG = Math.PI / 180;
const MS_PER_DAY = 86_400_000;
const J2000_MS = Date.UTC(2000, 0, 1, 12, 0, 0);

/**
 * Geomagnetic north pole, as a position plus a linear drift.
 *
 * Derived from the IGRF-14 degree-1 coefficients rather than quoted: the
 * magnetosphere layer evaluates the same table and agrees to four decimals.
 * It is carried as four numbers here because the aurora layer needs the dipole
 * axis and nothing else from geomagnetism, and vendoring a 1,379-line
 * coefficient table to get it would be absurd. The drift is linear over the
 * model's five-year span, which is ample: the pole moves about 4 km a year and
 * the oval is hundreds of kilometres wide.
 */
export const GEOMAGNETIC_POLE = Object.freeze({
  epochYear: 2025,
  latitudeDeg: 80.7894,
  longitudeDeg: -72.7628,
  latitudeDriftPerYear: 0.04083,
  longitudeDriftPerYear: -0.03847,
});

/**
 * Decimal year, for the pole's secular drift.
 *
 * @param {Date} date Instant to convert.
 * @returns {number} Year plus the fraction elapsed within it.
 */
export function decimalYear(date) {
  const year = date.getUTCFullYear();
  const start = Date.UTC(year, 0, 1);
  const end = Date.UTC(year + 1, 0, 1);
  return year + (date.getTime() - start) / (end - start);
}

/**
 * Geomagnetic north pole at a given instant.
 *
 * @param {Date} date Instant to evaluate.
 * @returns {{latitudeDeg: number, longitudeDeg: number}} Pole position.
 */
export function geomagneticPole(date) {
  const years = decimalYear(date) - GEOMAGNETIC_POLE.epochYear;
  return {
    latitudeDeg:
      GEOMAGNETIC_POLE.latitudeDeg +
      years * GEOMAGNETIC_POLE.latitudeDriftPerYear,
    longitudeDeg:
      GEOMAGNETIC_POLE.longitudeDeg +
      years * GEOMAGNETIC_POLE.longitudeDriftPerYear,
  };
}

/**
 * Unit vector for a geographic position, in the Earth-fixed frame.
 *
 * @param {number} latitudeDeg Latitude in degrees.
 * @param {number} longitudeDeg Longitude in degrees.
 * @returns {{x: number, y: number, z: number}} Unit vector.
 */
export function unitVector(latitudeDeg, longitudeDeg) {
  const lat = latitudeDeg * DEG;
  const lon = longitudeDeg * DEG;
  const cos = Math.cos(lat);
  return { x: cos * Math.cos(lon), y: cos * Math.sin(lon), z: Math.sin(lat) };
}

/**
 * Earth-fixed unit vector along the geomagnetic dipole axis, pointing north.
 *
 * @param {Date} date Instant to evaluate.
 * @returns {{x: number, y: number, z: number}} Unit vector.
 */
export function dipoleAxis(date) {
  const pole = geomagneticPole(date);
  return unitVector(pole.latitudeDeg, pole.longitudeDeg);
}

/**
 * Subsolar point: where the Sun is overhead.
 *
 * The low-precision solar position from the Astronomical Almanac, good to
 * about an arcminute this century. That is far more than enough, because every
 * use below takes a *difference* between two instants minutes apart, and the
 * slowly varying terms cancel almost entirely.
 *
 * @param {Date} date Instant to evaluate.
 * @returns {{latitudeDeg: number, longitudeDeg: number}} Subsolar position.
 */
export function subsolarPoint(date) {
  const n = (date.getTime() - J2000_MS) / MS_PER_DAY;
  const meanLongitude = 280.46 + 0.9856474 * n;
  const meanAnomaly = (357.528 + 0.9856003 * n) * DEG;
  const eclipticLongitude =
    (meanLongitude +
      1.915 * Math.sin(meanAnomaly) +
      0.02 * Math.sin(2 * meanAnomaly)) *
    DEG;
  const obliquity = (23.439 - 0.0000004 * n) * DEG;

  const declination = Math.asin(
    Math.sin(obliquity) * Math.sin(eclipticLongitude),
  );
  const rightAscension = Math.atan2(
    Math.cos(obliquity) * Math.sin(eclipticLongitude),
    Math.cos(eclipticLongitude),
  );

  // Equation of time, as the gap between mean and apparent solar position.
  let equationOfTimeDeg =
    (((meanLongitude % 360) + 360) % 360) -
    ((rightAscension / DEG + 360) % 360);
  equationOfTimeDeg = ((((equationOfTimeDeg + 180) % 360) + 360) % 360) - 180;

  const utcHours =
    (date.getTime() -
      Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate())) /
    3_600_000;
  const longitudeDeg = 15 * (12 - utcHours) - equationOfTimeDeg;

  return {
    latitudeDeg: declination / DEG,
    longitudeDeg: ((((longitudeDeg + 180) % 360) + 360) % 360) - 180,
  };
}

/**
 * Earth-fixed unit vector toward the Sun.
 *
 * @param {Date} date Instant to evaluate.
 * @returns {{x: number, y: number, z: number}} Unit vector.
 */
export function sunDirection(date) {
  const sun = subsolarPoint(date);
  return unitVector(sun.latitudeDeg, sun.longitudeDeg);
}

const dot = (a, b) => a.x * b.x + a.y * b.y + a.z * b.z;
const cross = (a, b) => ({
  x: a.y * b.z - a.z * b.y,
  y: a.z * b.x - a.x * b.z,
  z: a.x * b.y - a.y * b.x,
});

/**
 * How far the oval turns about the dipole axis between two instants.
 *
 * Measured rather than assumed: the Sun's direction is projected into the plane
 * perpendicular to the dipole axis at each instant and the signed angle between
 * those projections is taken. A uniform 15 degrees an hour is close, but it is
 * only exactly right for a dipole parallel to the spin axis, and this one is
 * tilted about nine degrees.
 *
 * @param {Date} from Earlier instant.
 * @param {Date} to Later instant.
 * @returns {number} Signed rotation about the dipole axis, in radians.
 */
export function mltRotationRadians(from, to) {
  // The axis is Earth-fixed and drifts only with secular variation, so which of
  // the two instants it is evaluated at cannot matter over minutes.
  const axis = dipoleAxis(to);
  const project = (v) => {
    const along = dot(v, axis);
    const p = {
      x: v.x - along * axis.x,
      y: v.y - along * axis.y,
      z: v.z - along * axis.z,
    };
    const length = Math.hypot(p.x, p.y, p.z);
    // Degenerate only if the Sun were exactly over the magnetic pole, which
    // cannot happen for Earth, but returning zero beats returning NaN.
    if (!(length > 0)) return null;
    return { x: p.x / length, y: p.y / length, z: p.z / length };
  };

  const a = project(sunDirection(from));
  const b = project(sunDirection(to));
  if (!a || !b) return 0;
  return Math.atan2(dot(cross(a, b), axis), dot(a, b));
}

/**
 * Rotate a unit vector about an axis, by Rodrigues' formula.
 *
 * @param {{x: number, y: number, z: number}} v Vector to rotate.
 * @param {{x: number, y: number, z: number}} axis Unit axis.
 * @param {number} radians Rotation angle.
 * @returns {{x: number, y: number, z: number}} Rotated vector.
 */
export function rotateAbout(v, axis, radians) {
  const cos = Math.cos(radians);
  const sin = Math.sin(radians);
  const k = cross(axis, v);
  const d = dot(axis, v) * (1 - cos);
  return {
    x: v.x * cos + k.x * sin + axis.x * d,
    y: v.y * cos + k.y * sin + axis.y * d,
    z: v.z * cos + k.z * sin + axis.z * d,
  };
}
