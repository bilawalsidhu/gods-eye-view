/**
 * @module geo/vector
 * @description Three-vectors as plain `{x, y, z}` objects, and the angle
 * helpers the rest of `geo` uses. No engine.
 */

export const TWO_PI = Math.PI * 2;
export const PI_OVER_TWO = Math.PI / 2;
export const EPSILON14 = 1e-14;

export const vec = (x = 0, y = 0, z = 0) => ({ x, y, z });
export const clone = (a) => ({ x: a.x, y: a.y, z: a.z });
export const add = (a, b) => vec(a.x + b.x, a.y + b.y, a.z + b.z);
export const sub = (a, b) => vec(a.x - b.x, a.y - b.y, a.z - b.z);
export const scale = (a, s) => vec(a.x * s, a.y * s, a.z * s);
export const negate = (a) => vec(-a.x, -a.y, -a.z);
export const dot = (a, b) => a.x * b.x + a.y * b.y + a.z * b.z;
export const cross = (a, b) =>
  vec(a.y * b.z - a.z * b.y, a.z * b.x - a.x * b.z, a.x * b.y - a.y * b.x);
export const magnitude = (a) => Math.sqrt(dot(a, a));
/** Straight-line (chord) distance, not along the surface. */
export const distance = (a, b) => magnitude(sub(a, b));
export function normalize(a) {
  const m = magnitude(a);
  return vec(a.x / m, a.y / m, a.z / m);
}

// As the default renderer converts: by a precomputed factor, so results are
// bit for bit its own.
export const RADIANS_PER_DEGREE = Math.PI / 180;
export const DEGREES_PER_RADIAN = 180 / Math.PI;
export const toRadians = (degrees) => degrees * RADIANS_PER_DEGREE;
export const toDegrees = (radians) => radians * DEGREES_PER_RADIAN;
export const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
export const acosClamped = (v) => Math.acos(clamp(v, -1, 1));
export const equalsEpsilon = (a, b, eps) => Math.abs(a - b) <= eps;

/** An angle in [0, 2π). */
export function zeroToTwoPi(angle) {
  if (angle >= 0 && angle <= TWO_PI) return angle;
  const mod = ((angle % TWO_PI) + TWO_PI) % TWO_PI;
  if (Math.abs(mod) < EPSILON14 && Math.abs(angle) > EPSILON14) return TWO_PI;
  return mod;
}

/** An angle in [-π, π]. */
export function negativePiToPi(angle) {
  if (angle >= -Math.PI && angle <= Math.PI) return angle;
  return zeroToTwoPi(angle + Math.PI) - Math.PI;
}
