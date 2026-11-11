// Ported from CesiumJS 1.138 (Apache-2.0) — Ellipsoid.js
//
// A quadratic surface x²/a² + y²/b² + z²/c² = 1 as a plain, frozen object.
// Every method takes an optional `result` and returns it (a new object when it
// is absent); `result` may be the input. The algorithms and the operation order
// match Cesium so the outputs are bit-identical.

import { create as createCartographic } from './cartographic.js';
import { EPSILON14 } from './math.js';
import { scaleToGeodeticSurface } from './scaleToGeodeticSurface.js';
import {
  add,
  create as vec,
  equalsEpsilon,
  ZERO,
  divideByScalar,
  dot,
  magnitude,
  multiplyByScalar,
  multiplyComponents,
  normalize,
  subtract,
} from './cartesian3.js';

/** Cesium's CesiumMath.EPSILON1, the squared norm below which a point counts as the centre. */
const CENTER_TOLERANCE_SQUARED = 0.1;

/**
 * Builds an ellipsoid with radii `x`, `y`, `z` (Cesium's `new Ellipsoid(x, y, z)`).
 * The returned object and its vector fields are frozen (deeply; Cesium freezes
 * only the WGS84 object itself, not its radii vectors).
 */
export function create(x, y, z) {
  x = x ?? 0.0;
  y = y ?? 0.0;
  z = z ?? 0.0;

  const radii = Object.freeze(vec(x, y, z));
  const radiiSquared = Object.freeze(vec(x * x, y * y, z * z));
  const radiiToTheFourth = Object.freeze(
    vec(x * x * x * x, y * y * y * y, z * z * z * z),
  );
  const oneOverRadii = Object.freeze(
    vec(
      x === 0.0 ? 0.0 : 1.0 / x,
      y === 0.0 ? 0.0 : 1.0 / y,
      z === 0.0 ? 0.0 : 1.0 / z,
    ),
  );
  const oneOverRadiiSquared = Object.freeze(
    vec(
      x === 0.0 ? 0.0 : 1.0 / (x * x),
      y === 0.0 ? 0.0 : 1.0 / (y * y),
      z === 0.0 ? 0.0 : 1.0 / (z * z),
    ),
  );
  const centerToleranceSquared = CENTER_TOLERANCE_SQUARED;

  /** The normal to the ellipsoid surface at a geodetic position. */
  function geodeticSurfaceNormalCartographic(cartographic, result) {
    const longitude = cartographic.longitude;
    const latitude = cartographic.latitude;
    const cosLatitude = Math.cos(latitude);

    const nx = cosLatitude * Math.cos(longitude);
    const ny = cosLatitude * Math.sin(longitude);
    const nz = Math.sin(latitude);

    if (result == null) result = vec();
    result.x = nx;
    result.y = ny;
    result.z = nz;
    return normalize(result, result);
  }

  /** The normal to the ellipsoid surface at a position, or `undefined` at the centre. */
  function geodeticSurfaceNormal(cartesian, result) {
    if (equalsEpsilon(cartesian, ZERO, EPSILON14)) {
      return undefined;
    }
    if (result == null) result = vec();
    result = multiplyComponents(cartesian, oneOverRadiiSquared, result);
    return normalize(result, result);
  }

  /** Scales a position onto the geodetic surface, or `undefined` near the centre. */
  function scaleToSurface(cartesian, result) {
    return scaleToGeodeticSurface(
      cartesian,
      oneOverRadii,
      oneOverRadiiSquared,
      centerToleranceSquared,
      result,
    );
  }

  const cartographicToCartesianNormal = vec();
  const cartographicToCartesianK = vec();

  /** Converts a geodetic position to Earth-fixed Cartesian coordinates. */
  function cartographicToCartesian(cartographic, result) {
    const n = cartographicToCartesianNormal;
    const k = cartographicToCartesianK;
    geodeticSurfaceNormalCartographic(cartographic, n);
    multiplyComponents(radiiSquared, n, k);
    const gamma = Math.sqrt(dot(n, k));
    divideByScalar(k, gamma, k);
    multiplyByScalar(n, cartographic.height, n);
    if (result == null) result = vec();
    return add(k, n, result);
  }

  const cartesianToCartographicN = vec();
  const cartesianToCartographicP = vec();
  const cartesianToCartographicH = vec();

  /** Converts an Earth-fixed position to geodetic coordinates, or `undefined` at the centre. */
  function cartesianToCartographic(cartesian, result) {
    const p = scaleToSurface(cartesian, cartesianToCartographicP);
    if (p === undefined) return undefined;

    const n = geodeticSurfaceNormal(p, cartesianToCartographicN);
    const h = subtract(cartesian, p, cartesianToCartographicH);

    const longitude = Math.atan2(n.y, n.x);
    const latitude = Math.asin(n.z);
    const height = Math.sign(dot(h, cartesian)) * magnitude(h);

    if (result == null) return createCartographic(longitude, latitude, height);
    result.longitude = longitude;
    result.latitude = latitude;
    result.height = height;
    return result;
  }

  return Object.freeze({
    radii,
    radiiSquared,
    radiiToTheFourth,
    oneOverRadii,
    oneOverRadiiSquared,
    minimumRadius: Math.min(x, y, z),
    maximumRadius: Math.max(x, y, z),
    centerToleranceSquared,
    geodeticSurfaceNormal,
    geodeticSurfaceNormalCartographic,
    scaleToGeodeticSurface: scaleToSurface,
    cartographicToCartesian,
    cartesianToCartographic,
  });
}

/**
 * The WGS84 ellipsoid. For src/geo only: never pass it into a Cesium function
 * or constructor (pickEllipsoid, EllipsoidalOccluder, …). It lacks Cesium's
 * private fields and methods such as `_centerToleranceSquared` and
 * `transformPositionToScaledSpace`; use `Cesium.Ellipsoid.WGS84` there.
 */
export const WGS84 = create(6378137.0, 6378137.0, 6356752.3142451793);
