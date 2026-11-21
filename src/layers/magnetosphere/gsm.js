/**
 * The GSM frame, and the dipole tilt the external field models need.
 *
 * T89 is defined in Geocentric Solar Magnetospheric coordinates: X toward the
 * Sun, Z in the plane containing X and the dipole axis, Y completing the set.
 * The tracer works in Earth-fixed coordinates, so every step has to convert a
 * position in and the resulting field back out.
 *
 * The dipole axis is not a constant: it comes from the first-degree IGRF
 * coefficients and drifts with them, so it is derived here rather than
 * hardcoded.
 *
 * @module layers/magnetosphere/gsm
 */

function normalize(v) {
  const length = Math.hypot(v.x, v.y, v.z);
  if (!(length > 0)) return null;
  return { x: v.x / length, y: v.y / length, z: v.z / length };
}
const cross = (a, b) => ({
  x: a.y * b.z - a.z * b.y,
  y: a.z * b.x - a.x * b.z,
  z: a.x * b.y - a.y * b.x,
});
const dot = (a, b) => a.x * b.x + a.y * b.y + a.z * b.z;

/**
 * Earth-fixed unit vector along the geomagnetic dipole, pointing north.
 *
 * Built from g(1,0), g(1,1) and h(1,1). The moment vector is
 * -(g11, h11, g10) normalised: the leading minus is why the geomagnetic north
 * pole sits in northern Canada rather than its antipode, and dropping it
 * silently flips the whole magnetosphere front-to-back.
 */
export function dipoleAxis(coefficients) {
  const g10 = coefficients.g[1][0];
  const g11 = coefficients.g[1][1];
  const h11 = coefficients.h[1][1];
  return normalize({ x: -g11, y: -h11, z: -g10 });
}

/** Geographic latitude and longitude of the geomagnetic north pole. */
export function geomagneticNorthPole(coefficients) {
  const axis = dipoleAxis(coefficients);
  return {
    latitudeDeg: (Math.asin(axis.z) * 180) / Math.PI,
    longitudeDeg: (Math.atan2(axis.y, axis.x) * 180) / Math.PI,
  };
}

/**
 * Dipole tilt: the angle between the dipole axis and the plane perpendicular
 * to the Sun-Earth line. Positive when the north magnetic pole leans sunward.
 */
export function dipoleTilt(coefficients, sunDirection) {
  const sun = normalize(sunDirection);
  if (!sun) return null;
  return Math.asin(
    Math.min(1, Math.max(-1, dot(dipoleAxis(coefficients), sun))),
  );
}

/**
 * Earth-fixed basis vectors of the GSM frame.
 *
 * Z_GSM lies in the Sun/dipole plane, so it is the dipole with its sunward
 * component removed. When the dipole is exactly along the Sun line that is
 * degenerate — it cannot happen for Earth, whose tilt stays within about 35
 * degrees, but returning null beats returning a frame full of NaN.
 */
export function gsmBasis(coefficients, sunDirection) {
  const x = normalize(sunDirection);
  if (!x) return null;
  const dipole = dipoleAxis(coefficients);
  const alongSun = dot(dipole, x);
  const z = normalize({
    x: dipole.x - alongSun * x.x,
    y: dipole.y - alongSun * x.y,
    z: dipole.z - alongSun * x.z,
  });
  if (!z) return null;
  return { x, y: cross(z, x), z };
}

/** Earth-fixed vector to GSM components. */
export function toGsm(basis, v) {
  return { x: dot(v, basis.x), y: dot(v, basis.y), z: dot(v, basis.z) };
}

/** GSM components back to an Earth-fixed vector. */
export function fromGsm(basis, v) {
  return {
    x: basis.x.x * v.x + basis.y.x * v.y + basis.z.x * v.z,
    y: basis.x.y * v.x + basis.y.y * v.y + basis.z.y * v.z,
    z: basis.x.z * v.x + basis.y.z * v.y + basis.z.z * v.z,
  };
}

/**
 * An Earth-fixed external-field function for the tracer.
 *
 * Closes over the frame and the model parameters so the per-step cost is one
 * rotation in, one model evaluation and one rotation out. Positions arrive in
 * kilometres because that is the tracer's unit; both models want Earth radii.
 *
 * `parameters` is whatever the chosen model takes as its first argument - a
 * disturbance band for T89, an object of solar wind inputs for T96 - and is
 * passed through untouched. Returns null beyond the model's stated validity
 * (70 Re) rather than extrapolating an empirical fit into a region it was never
 * fitted for.
 *
 * @param {object} options Model and frame.
 * @param {object} options.coefficients IGRF coefficients, for the dipole axis.
 * @param {object} options.sunDirection Earth-fixed unit vector toward the Sun.
 * @param {*} options.parameters First argument for `evaluate`.
 * @param {Function} options.evaluate t89 or t96.
 * @param {number} options.earthRadiusKm Earth radius in km.
 * @param {number} [options.maxRadiusRe] Outer limit of model validity, in Re.
 * @returns {?(position: object) => ?object} Earth-fixed nT, or null.
 */
export function externalFieldFor({
  coefficients,
  sunDirection,
  parameters,
  evaluate,
  earthRadiusKm,
  maxRadiusRe = 70,
}) {
  const basis = gsmBasis(coefficients, sunDirection);
  const tilt = dipoleTilt(coefficients, sunDirection);
  if (!basis || tilt === null) return null;
  return (position) => {
    const radiusRe =
      Math.hypot(position.x, position.y, position.z) / earthRadiusKm;
    if (!(radiusRe > 0) || radiusRe > maxRadiusRe) return null;
    const gsm = toGsm(basis, position);
    const b = evaluate(
      parameters,
      tilt,
      gsm.x / earthRadiusKm,
      gsm.y / earthRadiusKm,
      gsm.z / earthRadiusKm,
    );
    return b ? fromGsm(basis, b) : null;
  };
}
