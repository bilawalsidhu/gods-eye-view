/**
 * @module geo/sphere
 * @description Bounding spheres of ECEF points, by the default renderer's
 * own method (`BoundingSphere.fromPoints`): Ritter's sphere and the box's
 * circumsphere, whichever is smaller. Same arithmetic in the same order, so
 * a camera framed on one goes where it went before.
 */

const copy = (p) => ({ x: p.x, y: p.y, z: p.z });
const squared = (a, b) =>
  (a.x - b.x) * (a.x - b.x) +
  (a.y - b.y) * (a.y - b.y) +
  (a.z - b.z) * (a.z - b.z);

/**
 * @param {ReadonlyArray<{x: number, y: number, z: number}>} points
 * @returns {{center: {x: number, y: number, z: number}, radius: number}}
 *   Centre at the origin with radius 0 for no points.
 */
export function sphereFromPoints(points) {
  if (!points?.length) return { center: { x: 0, y: 0, z: 0 }, radius: 0 };
  const first = points[0];
  let xMin = copy(first);
  let yMin = copy(first);
  let zMin = copy(first);
  let xMax = copy(first);
  let yMax = copy(first);
  let zMax = copy(first);
  for (let i = 1; i < points.length; i++) {
    const p = points[i];
    if (p.x < xMin.x) xMin = copy(p);
    if (p.x > xMax.x) xMax = copy(p);
    if (p.y < yMin.y) yMin = copy(p);
    if (p.y > yMax.y) yMax = copy(p);
    if (p.z < zMin.z) zMin = copy(p);
    if (p.z > zMax.z) zMax = copy(p);
  }
  const xSpan = squared(xMax, xMin);
  const ySpan = squared(yMax, yMin);
  const zSpan = squared(zMax, zMin);
  let diameter1 = xMin;
  let diameter2 = xMax;
  let maxSpan = xSpan;
  if (ySpan > maxSpan) {
    maxSpan = ySpan;
    diameter1 = yMin;
    diameter2 = yMax;
  }
  if (zSpan > maxSpan) {
    diameter1 = zMin;
    diameter2 = zMax;
  }
  const ritter = {
    x: (diameter1.x + diameter2.x) * 0.5,
    y: (diameter1.y + diameter2.y) * 0.5,
    z: (diameter1.z + diameter2.z) * 0.5,
  };
  let radiusSquared = squared(diameter2, ritter);
  let ritterRadius = Math.sqrt(radiusSquared);
  const naive = {
    x: (xMin.x + xMax.x) * 0.5,
    y: (yMin.y + yMax.y) * 0.5,
    z: (zMin.z + zMax.z) * 0.5,
  };
  let naiveRadius = 0;
  for (const p of points) {
    const r = Math.sqrt(squared(p, naive));
    if (r > naiveRadius) naiveRadius = r;
    const toPointSquared = squared(p, ritter);
    if (toPointSquared > radiusSquared) {
      const toPoint = Math.sqrt(toPointSquared);
      ritterRadius = (ritterRadius + toPoint) * 0.5;
      radiusSquared = ritterRadius * ritterRadius;
      const oldToNew = toPoint - ritterRadius;
      ritter.x = (ritterRadius * ritter.x + oldToNew * p.x) / toPoint;
      ritter.y = (ritterRadius * ritter.y + oldToNew * p.y) / toPoint;
      ritter.z = (ritterRadius * ritter.z + oldToNew * p.z) / toPoint;
    }
  }
  return ritterRadius < naiveRadius
    ? { center: ritter, radius: ritterRadius }
    : { center: naive, radius: naiveRadius };
}

/**
 * The smallest sphere holding both spheres, by the default renderer's own
 * method (`BoundingSphere.union`).
 * @param {{center: {x: number, y: number, z: number}, radius: number}} left
 * @param {{center: {x: number, y: number, z: number}, radius: number}} right
 * @returns {{center: {x: number, y: number, z: number}, radius: number}}
 */
export function sphereUnion(left, right) {
  const toRight = {
    x: right.center.x - left.center.x,
    y: right.center.y - left.center.y,
    z: right.center.z - left.center.z,
  };
  const separation = Math.sqrt(
    toRight.x * toRight.x + toRight.y * toRight.y + toRight.z * toRight.z,
  );
  if (left.radius >= separation + right.radius)
    return { center: copy(left.center), radius: left.radius };
  if (right.radius >= separation + left.radius)
    return { center: copy(right.center), radius: right.radius };
  // Halfway between the two tangent points, one on the far side of each.
  const half = (left.radius + separation + right.radius) * 0.5;
  const along = (-left.radius + half) / separation;
  return {
    center: {
      x: toRight.x * along + left.center.x,
      y: toRight.y * along + left.center.y,
      z: toRight.z * along + left.center.z,
    },
    radius: half,
  };
}
