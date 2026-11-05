// Ported from CesiumJS 1.138 (Apache-2.0) — BoundingSphere.js subset.
// Exact mission framing: Ritter/box fit and the union of two spheres.
import * as Cartesian3 from './cartesian3.js';
const defined = (value) => value !== null && value !== undefined;
export function create(center = Cartesian3.ZERO, radius = 0) {
  return { center: Cartesian3.clone(center), radius };
}
export function clone(sphere, result = create()) {
  Cartesian3.clone(sphere.center, result.center);
  result.radius = sphere.radius;
  return result;
}
const fromPointsXMin = Cartesian3.create();
const fromPointsYMin = Cartesian3.create();
const fromPointsZMin = Cartesian3.create();
const fromPointsXMax = Cartesian3.create();
const fromPointsYMax = Cartesian3.create();
const fromPointsZMax = Cartesian3.create();
const fromPointsCurrentPos = Cartesian3.create();
const fromPointsScratch = Cartesian3.create();
const fromPointsRitterCenter = Cartesian3.create();
const fromPointsMinBoxPt = Cartesian3.create();
const fromPointsMaxBoxPt = Cartesian3.create();
const fromPointsNaiveCenterScratch = Cartesian3.create();
const unionScratch = Cartesian3.create();
const unionScratchCenter = Cartesian3.create();
export function fromPoints(positions, result) {
  if (!defined(result)) {
    result = create();
  }

  if (!defined(positions) || positions.length === 0) {
    result.center = Cartesian3.clone(Cartesian3.ZERO, result.center);
    result.radius = 0.0;
    return result;
  }

  const currentPos = Cartesian3.clone(positions[0], fromPointsCurrentPos);

  const xMin = Cartesian3.clone(currentPos, fromPointsXMin);
  const yMin = Cartesian3.clone(currentPos, fromPointsYMin);
  const zMin = Cartesian3.clone(currentPos, fromPointsZMin);

  const xMax = Cartesian3.clone(currentPos, fromPointsXMax);
  const yMax = Cartesian3.clone(currentPos, fromPointsYMax);
  const zMax = Cartesian3.clone(currentPos, fromPointsZMax);

  const numPositions = positions.length;
  let i;
  for (i = 1; i < numPositions; i++) {
    Cartesian3.clone(positions[i], currentPos);

    const x = currentPos.x;
    const y = currentPos.y;
    const z = currentPos.z;

    // Store points containing the the smallest and largest components
    if (x < xMin.x) {
      Cartesian3.clone(currentPos, xMin);
    }

    if (x > xMax.x) {
      Cartesian3.clone(currentPos, xMax);
    }

    if (y < yMin.y) {
      Cartesian3.clone(currentPos, yMin);
    }

    if (y > yMax.y) {
      Cartesian3.clone(currentPos, yMax);
    }

    if (z < zMin.z) {
      Cartesian3.clone(currentPos, zMin);
    }

    if (z > zMax.z) {
      Cartesian3.clone(currentPos, zMax);
    }
  }

  // Compute x-, y-, and z-spans (Squared distances b/n each component's min. and max.).
  const xSpan = Cartesian3.magnitudeSquared(
    Cartesian3.subtract(xMax, xMin, fromPointsScratch),
  );
  const ySpan = Cartesian3.magnitudeSquared(
    Cartesian3.subtract(yMax, yMin, fromPointsScratch),
  );
  const zSpan = Cartesian3.magnitudeSquared(
    Cartesian3.subtract(zMax, zMin, fromPointsScratch),
  );

  // Set the diameter endpoints to the largest span.
  let diameter1 = xMin;
  let diameter2 = xMax;
  let maxSpan = xSpan;
  if (ySpan > maxSpan) {
    maxSpan = ySpan;
    diameter1 = yMin;
    diameter2 = yMax;
  }
  if (zSpan > maxSpan) {
    maxSpan = zSpan;
    diameter1 = zMin;
    diameter2 = zMax;
  }

  // Calculate the center of the initial sphere found by Ritter's algorithm
  const ritterCenter = fromPointsRitterCenter;
  ritterCenter.x = (diameter1.x + diameter2.x) * 0.5;
  ritterCenter.y = (diameter1.y + diameter2.y) * 0.5;
  ritterCenter.z = (diameter1.z + diameter2.z) * 0.5;

  // Calculate the radius of the initial sphere found by Ritter's algorithm
  let radiusSquared = Cartesian3.magnitudeSquared(
    Cartesian3.subtract(diameter2, ritterCenter, fromPointsScratch),
  );
  let ritterRadius = Math.sqrt(radiusSquared);

  // Find the center of the sphere found using the Naive method.
  const minBoxPt = fromPointsMinBoxPt;
  minBoxPt.x = xMin.x;
  minBoxPt.y = yMin.y;
  minBoxPt.z = zMin.z;

  const maxBoxPt = fromPointsMaxBoxPt;
  maxBoxPt.x = xMax.x;
  maxBoxPt.y = yMax.y;
  maxBoxPt.z = zMax.z;

  const naiveCenter = Cartesian3.midpoint(
    minBoxPt,
    maxBoxPt,
    fromPointsNaiveCenterScratch,
  );

  // Begin 2nd pass to find naive radius and modify the ritter sphere.
  let naiveRadius = 0;
  for (i = 0; i < numPositions; i++) {
    Cartesian3.clone(positions[i], currentPos);

    // Find the furthest point from the naive center to calculate the naive radius.
    const r = Cartesian3.magnitude(
      Cartesian3.subtract(currentPos, naiveCenter, fromPointsScratch),
    );
    if (r > naiveRadius) {
      naiveRadius = r;
    }

    // Make adjustments to the Ritter Sphere to include all points.
    const oldCenterToPointSquared = Cartesian3.magnitudeSquared(
      Cartesian3.subtract(currentPos, ritterCenter, fromPointsScratch),
    );
    if (oldCenterToPointSquared > radiusSquared) {
      const oldCenterToPoint = Math.sqrt(oldCenterToPointSquared);
      // Calculate new radius to include the point that lies outside
      ritterRadius = (ritterRadius + oldCenterToPoint) * 0.5;
      radiusSquared = ritterRadius * ritterRadius;
      // Calculate center of new Ritter sphere
      const oldToNew = oldCenterToPoint - ritterRadius;
      ritterCenter.x =
        (ritterRadius * ritterCenter.x + oldToNew * currentPos.x) /
        oldCenterToPoint;
      ritterCenter.y =
        (ritterRadius * ritterCenter.y + oldToNew * currentPos.y) /
        oldCenterToPoint;
      ritterCenter.z =
        (ritterRadius * ritterCenter.z + oldToNew * currentPos.z) /
        oldCenterToPoint;
    }
  }

  if (ritterRadius < naiveRadius) {
    Cartesian3.clone(ritterCenter, result.center);
    result.radius = ritterRadius;
  } else {
    Cartesian3.clone(naiveCenter, result.center);
    result.radius = naiveRadius;
  }

  return result;
}
export function union(left, right, result) {
  if (!defined(result)) {
    result = create();
  }

  const leftCenter = left.center;
  const leftRadius = left.radius;
  const rightCenter = right.center;
  const rightRadius = right.radius;

  const toRightCenter = Cartesian3.subtract(
    rightCenter,
    leftCenter,
    unionScratch,
  );
  const centerSeparation = Cartesian3.magnitude(toRightCenter);

  if (leftRadius >= centerSeparation + rightRadius) {
    // Left sphere wins.
    clone(left, result);
    return result;
  }

  if (rightRadius >= centerSeparation + leftRadius) {
    // Right sphere wins.
    clone(right, result);
    return result;
  }

  // There are two tangent points, one on far side of each sphere.
  const halfDistanceBetweenTangentPoints =
    (leftRadius + centerSeparation + rightRadius) * 0.5;

  // Compute the center point halfway between the two tangent points.
  const center = Cartesian3.multiplyByScalar(
    toRightCenter,
    (-leftRadius + halfDistanceBetweenTangentPoints) / centerSeparation,
    unionScratchCenter,
  );
  Cartesian3.add(center, leftCenter, center);
  Cartesian3.clone(center, result.center);
  result.radius = halfDistanceBetweenTangentPoints;

  return result;
}
