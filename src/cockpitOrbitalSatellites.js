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
 * centre interpolated linearly. The circle is the one through both ends, so
 * the path moves smoothly as the destination does, however far round it
 * lies; only exactly opposite ends, which no single circle joins, turn about
 * a fixed axis square to them.
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
  const cosine = a.x * b.x + a.y * b.y + a.z * b.z;
  // The direction the circle leaves `a` in: `b` less its part along `a`.
  let c = {
    x: b.x - cosine * a.x,
    y: b.y - cosine * a.y,
    z: b.z - cosine * a.z,
  };
  let rc = Math.hypot(c.x, c.y, c.z);
  const r = ra + (rb - ra) * p;
  const omega = Math.atan2(rc, cosine);
  if (!(rc > 1e-12)) {
    if (cosine > 0) return { x: a.x * r, y: a.y * r, z: a.z * r };
    // Opposite ends: set off square to `a`, northward (or, near a pole,
    // toward the prime meridian).
    const pole =
      Math.abs(a.z) < 0.9 ? { x: 0, y: 0, z: 1 } : { x: 1, y: 0, z: 0 };
    const along = pole.x * a.x + pole.y * a.y + pole.z * a.z;
    c = {
      x: pole.x - along * a.x,
      y: pole.y - along * a.y,
      z: pole.z - along * a.z,
    };
    rc = Math.hypot(c.x, c.y, c.z);
  }
  const angle = p * omega;
  const cos = Math.cos(angle);
  const sin = Math.sin(angle) / rc;
  return {
    x: (a.x * cos + c.x * sin) * r,
    y: (a.y * cos + c.y * sin) * r,
    z: (a.z * cos + c.z * sin) * r,
  };
}
