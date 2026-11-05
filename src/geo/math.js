// Ported from CesiumJS 1.138 (Apache-2.0) — Math.js
//
// Engine-neutral angle maths. Formulas and constants match Cesium.Math bit for
// bit.

export const EPSILON10 = 0.0000000001;
export const EPSILON12 = 0.000000000001;
export const EPSILON14 = 0.00000000000001;
export const PI_OVER_TWO = Math.PI / 2.0;
export const TWO_PI = 2.0 * Math.PI;
export const RADIANS_PER_DEGREE = Math.PI / 180.0;
export const DEGREES_PER_RADIAN = 180.0 / Math.PI;

/** Converts degrees to radians. */
export function toRadians(degrees) {
  return degrees * RADIANS_PER_DEGREE;
}

/** Converts radians to degrees. */
export function toDegrees(radians) {
  return radians * DEGREES_PER_RADIAN;
}

/** Constrains a value to lie between two values. */
export function clamp(value, min, max) {
  return value < min ? min : value > max ? max : value;
}

/** Computes the linear interpolation of two values. */
export function lerp(p, q, time) {
  return (1.0 - time) * p + time * q;
}

/** The modulo operation that also works for negative dividends. */
export function mod(m, n) {
  if (Math.sign(m) === Math.sign(n) && Math.abs(m) < Math.abs(n)) {
    // Early exit if the input does not need to be modded. This avoids
    // unnecessary math which could introduce floating point error.
    return m;
  }
  return ((m % n) + n) % n;
}

/** Produces an angle in the range 0 <= angle <= 2Pi equivalent to the provided angle. */
export function zeroToTwoPi(angle) {
  if (angle >= 0 && angle <= TWO_PI) {
    // Early exit if the input is already inside the range. This avoids
    // unnecessary math which could introduce floating point error.
    return angle;
  }
  const result = mod(angle, TWO_PI);
  if (Math.abs(result) < EPSILON14 && Math.abs(angle) > EPSILON14) {
    return TWO_PI;
  }
  return result;
}

/** Produces an angle in the range -Pi <= angle <= Pi equivalent to the provided angle. */
export function negativePiToPi(angle) {
  if (angle >= -Math.PI && angle <= Math.PI) {
    // Early exit if the input is already inside the range. This avoids
    // unnecessary math which could introduce floating point error.
    return angle;
  }
  return zeroToTwoPi(angle + Math.PI) - Math.PI;
}

/**
 * Whether two values are equal within an absolute or a relative tolerance
 * (the absolute one defaults to the relative one).
 */
export function equalsEpsilon(left, right, relativeEpsilon, absoluteEpsilon) {
  relativeEpsilon = relativeEpsilon ?? 0.0;
  absoluteEpsilon = absoluteEpsilon ?? relativeEpsilon;
  const absDiff = Math.abs(left - right);
  return (
    absDiff <= absoluteEpsilon ||
    absDiff <= relativeEpsilon * Math.max(Math.abs(left), Math.abs(right))
  );
}
