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
 * centre interpolated linearly. Opposite ends turn about a fixed axis
 * square to them, so even then the path stays off the Earth.
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
  const r = ra + (rb - ra) * p;
  if (Math.PI - omega < 1e-6) {
    // No single great circle joins opposite points: turn about the axis
    // square to `a` that is least aligned with the Earth's.
    const pole =
      Math.abs(a.z) < 0.9 ? { x: 0, y: 0, z: 1 } : { x: 1, y: 0, z: 0 };
    const along = pole.x * a.x + pole.y * a.y + pole.z * a.z;
    const c = {
      x: pole.x - along * a.x,
      y: pole.y - along * a.y,
      z: pole.z - along * a.z,
    };
    const rc = Math.hypot(c.x, c.y, c.z);
    const cos = Math.cos(p * Math.PI);
    const sin = Math.sin(p * Math.PI);
    return {
      x: (a.x * cos + (c.x / rc) * sin) * r,
      y: (a.y * cos + (c.y / rc) * sin) * r,
      z: (a.z * cos + (c.z / rc) * sin) * r,
    };
  }
  let ka = 1 - p;
  let kb = p;
  if (omega > 1e-9) {
    const sine = Math.sin(omega);
    ka = Math.sin((1 - p) * omega) / sine;
    kb = Math.sin(p * omega) / sine;
  }
  return {
    x: (a.x * ka + b.x * kb) * r,
    y: (a.y * ka + b.y * kb) * r,
    z: (a.z * ka + b.z * kb) * r,
  };
}
