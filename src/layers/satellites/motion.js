import { propagate } from 'satellite.js';

/** The Earth's gravitational parameter, km³/s², as SGP4's WGS72 constants. */
const MU_KM3_S2 = 398600.8;

/** Floats in one orbit sample: its time, then position, velocity,
 * acceleration and jerk. */
export const ORBIT_SAMPLE_LENGTH = 13;

/**
 * One SGP4 state of a satellite for dead reckoning: its inertial (TEME)
 * position and velocity at `atMs`, with the two-body acceleration and its
 * rate of change (jerk) there.
 * Layout: [atMs, rx, ry, rz (km), vx, vy, vz (km/s), ax, ay, az (km/s²),
 * jx, jy, jz (km/s³)].
 * @param {object} satrec
 * @param {number} atMs Epoch milliseconds.
 * @param {Float64Array} [out]
 * @returns {Float64Array|null} Null when SGP4 has no state for that time.
 */
export function sampleOrbit(
  satrec,
  atMs,
  out = new Float64Array(ORBIT_SAMPLE_LENGTH),
) {
  let state;
  try {
    state = propagate(satrec, new Date(atMs));
  } catch {
    return null;
  }
  const p = state?.position;
  const v = state?.velocity;
  if (!p || typeof p === 'boolean' || !v || typeof v === 'boolean') return null;
  const r = Math.hypot(p.x, p.y, p.z);
  if (!(r > 0) || !Number.isFinite(v.x + v.y + v.z)) return null;
  const k = -MU_KM3_S2 / (r * r * r);
  // d/dt of -μ r/|r|³: -μ (v/|r|³ - 3 (r·v) r/|r|⁵).
  const radial = (3 * (p.x * v.x + p.y * v.y + p.z * v.z)) / (r * r);
  out[0] = atMs;
  out[1] = p.x;
  out[2] = p.y;
  out[3] = p.z;
  out[4] = v.x;
  out[5] = v.y;
  out[6] = v.z;
  out[7] = k * p.x;
  out[8] = k * p.y;
  out[9] = k * p.z;
  out[10] = k * (v.x - radial * p.x);
  out[11] = k * (v.y - radial * p.y);
  out[12] = k * (v.z - radial * p.z);
  return out;
}

/**
 * Where a satellite is at `atMs`, reckoned from its sample along the inertial
 * path (position, velocity, gravity and its change) and turned into the
 * Earth-fixed frame by the Greenwich sidereal angle at that time. Over half a
 * minute of world time the reckoned point stays within metres of SGP4.
 * @param {Float64Array} sample From sampleOrbit.
 * @param {number} atMs Epoch milliseconds.
 * @param {number} gmst Greenwich mean sidereal angle at `atMs`, radians.
 * @param {{x: number, y: number, z: number}} out Receives Earth-fixed metres.
 * @returns {{x: number, y: number, z: number}} `out`.
 */
export function reckonEarthFixed(sample, atMs, gmst, out) {
  const dt = (atMs - sample[0]) / 1000;
  const half = 0.5 * dt * dt;
  const sixth = (half * dt) / 3;
  const x = sample[1] + sample[4] * dt + sample[7] * half + sample[10] * sixth;
  const y = sample[2] + sample[5] * dt + sample[8] * half + sample[11] * sixth;
  const z = sample[3] + sample[6] * dt + sample[9] * half + sample[12] * sixth;
  const cos = Math.cos(gmst);
  const sin = Math.sin(gmst);
  out.x = (x * cos + y * sin) * 1000;
  out.y = (-x * sin + y * cos) * 1000;
  out.z = z * 1000;
  return out;
}
