/**
 * The camera's hop from the satellite the orbital view rides to another.
 * No DOM, Cesium or i18n dependencies: vectors are plain `{x, y, z}` objects
 * in Earth-fixed (ECEF) metres.
 */

/** The most nearby satellites asked for the orbital rows, nearest first. */
export const ORBITAL_SATELLITES_MAX = 8;

/** How long the camera takes to hop to another satellite, ms. */
export const ORBITAL_HOP_MS = 1200;

function finiteVector(v) {
  return (
    Boolean(v) &&
    Number.isFinite(v.x) &&
    Number.isFinite(v.y) &&
    Number.isFinite(v.z)
  );
}

/**
 * Where the camera is part-way through a hop: along the great circle
 * between the two positions (never through the Earth), its distance from the
 * centre interpolated linearly. Both ends may move during the hop; pass
 * their positions now.
 * @param {{x: number, y: number, z: number}} from
 * @param {{x: number, y: number, z: number}} to
 * @param {number} progress Eased, 0..1.
 * @returns {{x: number, y: number, z: number}|null}
 */
export function hopPosition(from, to, progress) {
  if (!finiteVector(from) || !finiteVector(to)) return null;
  const p = Math.min(1, Math.max(0, Number.isFinite(progress) ? progress : 1));
  const ra = Math.hypot(from.x, from.y, from.z);
  const rb = Math.hypot(to.x, to.y, to.z);
  if (!(ra > 0) || !(rb > 0)) return null;
  const a = { x: from.x / ra, y: from.y / ra, z: from.z / ra };
  const b = { x: to.x / rb, y: to.y / rb, z: to.z / rb };
  const cosine = Math.min(1, Math.max(-1, a.x * b.x + a.y * b.y + a.z * b.z));
  const omega = Math.acos(cosine);
  let ka = 1 - p;
  let kb = p;
  if (omega > 1e-9) {
    const sine = Math.sin(omega);
    ka = Math.sin((1 - p) * omega) / sine;
    kb = Math.sin(p * omega) / sine;
  }
  const r = ra + (rb - ra) * p;
  return {
    x: (a.x * ka + b.x * kb) * r,
    y: (a.y * ka + b.y * kb) * r,
    z: (a.z * ka + b.z * kb) * r,
  };
}
