// Ported from CesiumJS 1.138 (Apache-2.0) — scaleToGeodeticSurface.js
//
// Scales a position onto an ellipsoid's geodetic surface (Newton iteration).
// Internal to src/geo (not re-exported by index.js): used by ellipsoid.js and,
// as in Cesium, directly by cartographic.fromCartesian.

import { EPSILON12 } from './math.js';
import {
  clone,
  create as vec,
  magnitude,
  multiplyByScalar,
} from './cartesian3.js';

const scaleIntersectionScratch = vec();
const scaleGradientScratch = vec();

/**
 * Scales a position to the geodetic surface of the ellipsoid given by
 * `oneOverRadii`/`oneOverRadiiSquared`, or `undefined` near the centre.
 */
export function scaleToGeodeticSurface(
  cartesian,
  oneOverRadii,
  oneOverRadiiSquared,
  centerToleranceSquared,
  result,
) {
  const positionX = cartesian.x;
  const positionY = cartesian.y;
  const positionZ = cartesian.z;

  const oneOverRadiiX = oneOverRadii.x;
  const oneOverRadiiY = oneOverRadii.y;
  const oneOverRadiiZ = oneOverRadii.z;

  const x2 = positionX * positionX * oneOverRadiiX * oneOverRadiiX;
  const y2 = positionY * positionY * oneOverRadiiY * oneOverRadiiY;
  const z2 = positionZ * positionZ * oneOverRadiiZ * oneOverRadiiZ;

  // Compute the squared ellipsoid norm.
  const squaredNorm = x2 + y2 + z2;
  const ratio = Math.sqrt(1.0 / squaredNorm);

  // As an initial approximation, assume that the radial intersection is the projection point.
  const intersection = multiplyByScalar(
    cartesian,
    ratio,
    scaleIntersectionScratch,
  );

  // If the position is near the center, the iteration will not converge.
  if (squaredNorm < centerToleranceSquared) {
    return !isFinite(ratio) ? undefined : clone(intersection, result);
  }

  const oneOverRadiiSquaredX = oneOverRadiiSquared.x;
  const oneOverRadiiSquaredY = oneOverRadiiSquared.y;
  const oneOverRadiiSquaredZ = oneOverRadiiSquared.z;

  // Use the gradient at the intersection point in place of the true unit normal.
  // The difference in magnitude will be absorbed in the multiplier.
  const gradient = scaleGradientScratch;
  gradient.x = intersection.x * oneOverRadiiSquaredX * 2.0;
  gradient.y = intersection.y * oneOverRadiiSquaredY * 2.0;
  gradient.z = intersection.z * oneOverRadiiSquaredZ * 2.0;

  // Compute the initial guess at the normal vector multiplier, lambda.
  let lambda =
    ((1.0 - ratio) * magnitude(cartesian)) / (0.5 * magnitude(gradient));
  let correction = 0.0;

  let func;
  let denominator;
  let xMultiplier;
  let yMultiplier;
  let zMultiplier;
  let xMultiplier2;
  let yMultiplier2;
  let zMultiplier2;
  let xMultiplier3;
  let yMultiplier3;
  let zMultiplier3;

  do {
    lambda -= correction;

    xMultiplier = 1.0 / (1.0 + lambda * oneOverRadiiSquaredX);
    yMultiplier = 1.0 / (1.0 + lambda * oneOverRadiiSquaredY);
    zMultiplier = 1.0 / (1.0 + lambda * oneOverRadiiSquaredZ);

    xMultiplier2 = xMultiplier * xMultiplier;
    yMultiplier2 = yMultiplier * yMultiplier;
    zMultiplier2 = zMultiplier * zMultiplier;

    xMultiplier3 = xMultiplier2 * xMultiplier;
    yMultiplier3 = yMultiplier2 * yMultiplier;
    zMultiplier3 = zMultiplier2 * zMultiplier;

    func = x2 * xMultiplier2 + y2 * yMultiplier2 + z2 * zMultiplier2 - 1.0;

    denominator =
      x2 * xMultiplier3 * oneOverRadiiSquaredX +
      y2 * yMultiplier3 * oneOverRadiiSquaredY +
      z2 * zMultiplier3 * oneOverRadiiSquaredZ;

    const derivative = -2.0 * denominator;

    correction = func / derivative;
  } while (Math.abs(func) > EPSILON12);

  if (result == null) {
    return vec(
      positionX * xMultiplier,
      positionY * yMultiplier,
      positionZ * zMultiplier,
    );
  }
  result.x = positionX * xMultiplier;
  result.y = positionY * yMultiplier;
  result.z = positionZ * zMultiplier;
  return result;
}
