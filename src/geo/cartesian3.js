// Ported from CesiumJS 1.138 (Apache-2.0) — Cartesian3.js
//
// 3D vectors as plain-data {x, y, z} objects. Arithmetic takes a required `result`
// (as Cesium does) that may be one of the inputs; creators take an optional
// one. The operation order matches Cesium so the outputs are bit-identical.
// With DEBUG on (development and tests; see debug.js) invalid arguments throw
// the same DeveloperError as Cesium's debug checks, and `normalize` throws on a
// zero or non-finite vector; production builds skip the checks and return NaN
// components there, as release Cesium does.
//
// Geo values are not Object.prototype objects, so src/app/stateChannel.js
// copyState and src/director/documentFields.js jsonTree reject them: copy
// the fields into a literal before putting one into product state or a
// scene document.

import { DEBUG } from './debug.js';
import { Check } from './check.js';
import { DeveloperError } from './developerError.js';
import { equalsEpsilon as scalarEqualsEpsilon, toRadians } from './math.js';

// Values are instances of a module-private constructor rather than object
// literals: every `{x, y, z}` literal in the process shares one V8 hidden
// class, and code elsewhere that builds such literals would make geo's hot
// functions polymorphic. The instances still look like plain data: own
// enumerable fields only, no prototype methods or getters.
function Vector3(x, y, z) {
  this.x = x;
  this.y = y;
  this.z = z;
}

/** A vector (Cesium's `new Cartesian3(x, y, z)`). */
export function create(x, y, z) {
  return new Vector3(x ?? 0.0, y ?? 0.0, z ?? 0.0);
}

/** Sets a vector's components. */
export function fromElements(x, y, z, result) {
  if (result == null) return create(x, y, z);
  result.x = x;
  result.y = y;
  result.z = z;
  return result;
}

/** Copies a vector; `undefined` when there is none. */
export function clone(cartesian, result) {
  if (cartesian == null) return undefined;
  if (result == null) return create(cartesian.x, cartesian.y, cartesian.z);
  result.x = cartesian.x;
  result.y = cartesian.y;
  result.z = cartesian.z;
  return result;
}

export const ZERO = Object.freeze(create(0.0, 0.0, 0.0));
export const UNIT_X = Object.freeze(create(1.0, 0.0, 0.0));
export const UNIT_Y = Object.freeze(create(0.0, 1.0, 0.0));
export const UNIT_Z = Object.freeze(create(0.0, 0.0, 1.0));

export function magnitudeSquared(cartesian) {
  if (DEBUG) {
    Check.typeOf.object('cartesian', cartesian);
  }

  return (
    cartesian.x * cartesian.x +
    cartesian.y * cartesian.y +
    cartesian.z * cartesian.z
  );
}

export function magnitude(cartesian) {
  return Math.sqrt(magnitudeSquared(cartesian));
}

const distanceScratch = create();

export function distance(left, right) {
  if (DEBUG) {
    Check.typeOf.object('left', left);
    Check.typeOf.object('right', right);
  }

  subtract(left, right, distanceScratch);
  return magnitude(distanceScratch);
}

export function distanceSquared(left, right) {
  if (DEBUG) {
    Check.typeOf.object('left', left);
    Check.typeOf.object('right', right);
  }

  subtract(left, right, distanceScratch);
  return magnitudeSquared(distanceScratch);
}

/** The unit vector; with DEBUG on, throws when the vector has no direction (zero or non-finite). */
export function normalize(cartesian, result) {
  if (DEBUG) {
    Check.typeOf.object('cartesian', cartesian);
    Check.typeOf.object('result', result);
  }

  const length = magnitude(cartesian);
  result.x = cartesian.x / length;
  result.y = cartesian.y / length;
  result.z = cartesian.z / length;
  if (DEBUG) {
    if (isNaN(result.x) || isNaN(result.y) || isNaN(result.z)) {
      throw new DeveloperError('normalized result is not a number');
    }
  }
  return result;
}

export function dot(left, right) {
  if (DEBUG) {
    Check.typeOf.object('left', left);
    Check.typeOf.object('right', right);
  }

  return left.x * right.x + left.y * right.y + left.z * right.z;
}

export function multiplyComponents(left, right, result) {
  if (DEBUG) {
    Check.typeOf.object('left', left);
    Check.typeOf.object('right', right);
    Check.typeOf.object('result', result);
  }

  result.x = left.x * right.x;
  result.y = left.y * right.y;
  result.z = left.z * right.z;
  return result;
}

export function add(left, right, result) {
  if (DEBUG) {
    Check.typeOf.object('left', left);
    Check.typeOf.object('right', right);
    Check.typeOf.object('result', result);
  }

  result.x = left.x + right.x;
  result.y = left.y + right.y;
  result.z = left.z + right.z;
  return result;
}

export function subtract(left, right, result) {
  if (DEBUG) {
    Check.typeOf.object('left', left);
    Check.typeOf.object('right', right);
    Check.typeOf.object('result', result);
  }

  result.x = left.x - right.x;
  result.y = left.y - right.y;
  result.z = left.z - right.z;
  return result;
}

export function multiplyByScalar(cartesian, scalar, result) {
  if (DEBUG) {
    Check.typeOf.object('cartesian', cartesian);
    Check.typeOf.number('scalar', scalar);
    Check.typeOf.object('result', result);
  }

  result.x = cartesian.x * scalar;
  result.y = cartesian.y * scalar;
  result.z = cartesian.z * scalar;
  return result;
}

export function divideByScalar(cartesian, scalar, result) {
  if (DEBUG) {
    Check.typeOf.object('cartesian', cartesian);
    Check.typeOf.number('scalar', scalar);
    Check.typeOf.object('result', result);
  }

  result.x = cartesian.x / scalar;
  result.y = cartesian.y / scalar;
  result.z = cartesian.z / scalar;
  return result;
}

export function negate(cartesian, result) {
  if (DEBUG) {
    Check.typeOf.object('cartesian', cartesian);
    Check.typeOf.object('result', result);
  }

  result.x = -cartesian.x;
  result.y = -cartesian.y;
  result.z = -cartesian.z;
  return result;
}

const lerpScratch = create();

export function lerp(start, end, t, result) {
  if (DEBUG) {
    Check.typeOf.object('start', start);
    Check.typeOf.object('end', end);
    Check.typeOf.number('t', t);
    Check.typeOf.object('result', result);
  }

  multiplyByScalar(end, t, lerpScratch);
  result = multiplyByScalar(start, 1.0 - t, result);
  return add(lerpScratch, result, result);
}

export function cross(left, right, result) {
  if (DEBUG) {
    Check.typeOf.object('left', left);
    Check.typeOf.object('right', right);
    Check.typeOf.object('result', result);
  }

  const leftX = left.x;
  const leftY = left.y;
  const leftZ = left.z;
  const rightX = right.x;
  const rightY = right.y;
  const rightZ = right.z;

  const x = leftY * rightZ - leftZ * rightY;
  const y = leftZ * rightX - leftX * rightZ;
  const z = leftX * rightY - leftY * rightX;

  result.x = x;
  result.y = y;
  result.z = z;
  return result;
}

export function midpoint(left, right, result) {
  if (DEBUG) {
    Check.typeOf.object('left', left);
    Check.typeOf.object('right', right);
    Check.typeOf.object('result', result);
  }

  result.x = (left.x + right.x) * 0.5;
  result.y = (left.y + right.y) * 0.5;
  result.z = (left.z + right.z) * 0.5;
  return result;
}

export function equals(left, right) {
  return (
    left === right ||
    (left != null &&
      right != null &&
      left.x === right.x &&
      left.y === right.y &&
      left.z === right.z)
  );
}

export function equalsEpsilon(left, right, relativeEpsilon, absoluteEpsilon) {
  return (
    left === right ||
    (left != null &&
      right != null &&
      scalarEqualsEpsilon(left.x, right.x, relativeEpsilon, absoluteEpsilon) &&
      scalarEqualsEpsilon(left.y, right.y, relativeEpsilon, absoluteEpsilon) &&
      scalarEqualsEpsilon(left.z, right.z, relativeEpsilon, absoluteEpsilon))
  );
}

// WGS84 radii squared, used when no ellipsoid is given (Cesium's
// Cartesian3._ellipsoidRadiiSquared; equal to ellipsoid.WGS84.radiiSquared).
// Cesium follows Ellipsoid.default here; the default is WGS84 because gev never
// changes Ellipsoid.default.
const WGS84_RADII_SQUARED = Object.freeze(
  create(
    6378137.0 * 6378137.0,
    6378137.0 * 6378137.0,
    6356752.3142451793 * 6356752.3142451793,
  ),
);

let scratchN = create();
let scratchK = create();

/** The Earth-fixed position of a geodetic one in radians on the ellipsoid (WGS84 by default). */
export function fromRadians(longitude, latitude, height, ellipsoid, result) {
  if (DEBUG) {
    Check.typeOf.number('longitude', longitude);
    Check.typeOf.number('latitude', latitude);
  }

  height = height ?? 0.0;
  const radiiSquared =
    ellipsoid == null ? WGS84_RADII_SQUARED : ellipsoid.radiiSquared;

  const cosLatitude = Math.cos(latitude);
  scratchN.x = cosLatitude * Math.cos(longitude);
  scratchN.y = cosLatitude * Math.sin(longitude);
  scratchN.z = Math.sin(latitude);
  scratchN = normalize(scratchN, scratchN);

  multiplyComponents(radiiSquared, scratchN, scratchK);
  const gamma = Math.sqrt(dot(scratchN, scratchK));
  scratchK = divideByScalar(scratchK, gamma, scratchK);
  scratchN = multiplyByScalar(scratchN, height, scratchN);

  if (result == null) result = create();
  return add(scratchK, scratchN, result);
}

/** The Earth-fixed position of a geodetic one in degrees on the ellipsoid (WGS84 by default). */
export function fromDegrees(longitude, latitude, height, ellipsoid, result) {
  if (DEBUG) {
    Check.typeOf.number('longitude', longitude);
    Check.typeOf.number('latitude', latitude);
  }

  longitude = toRadians(longitude);
  latitude = toRadians(latitude);
  return fromRadians(longitude, latitude, height, ellipsoid, result);
}

/** Positions from a flat [lon, lat, lon, lat, …] list in degrees, at height 0. */
export function fromDegreesArray(coordinates, ellipsoid, result) {
  if (DEBUG) {
    Check.defined('coordinates', coordinates);
    if (coordinates.length < 2 || coordinates.length % 2 !== 0) {
      throw new DeveloperError(
        'the number of coordinates must be a multiple of 2 and at least 2',
      );
    }
  }

  const length = coordinates.length;
  if (result == null) {
    result = new Array(length / 2);
  } else {
    result.length = length / 2;
  }
  for (let i = 0; i < length; i += 2) {
    const index = i / 2;
    result[index] = fromDegrees(
      coordinates[i],
      coordinates[i + 1],
      0,
      ellipsoid,
      result[index],
    );
  }
  return result;
}

/** Positions from a flat [lon, lat, height, …] list in degrees and metres. */
export function fromDegreesArrayHeights(coordinates, ellipsoid, result) {
  if (DEBUG) {
    Check.defined('coordinates', coordinates);
    if (coordinates.length < 3 || coordinates.length % 3 !== 0) {
      throw new DeveloperError(
        'the number of coordinates must be a multiple of 3 and at least 3',
      );
    }
  }

  const length = coordinates.length;
  if (result == null) {
    result = new Array(length / 3);
  } else {
    result.length = length / 3;
  }
  for (let i = 0; i < length; i += 3) {
    const index = i / 3;
    result[index] = fromDegrees(
      coordinates[i],
      coordinates[i + 1],
      coordinates[i + 2],
      ellipsoid,
      result[index],
    );
  }
  return result;
}

const angleBetweenScratch = create();
const angleBetweenScratch2 = create();
export function angleBetween(left, right) {
  if (DEBUG) {
    Check.typeOf.object('left', left);
    Check.typeOf.object('right', right);
  }
  normalize(left, angleBetweenScratch);
  normalize(right, angleBetweenScratch2);
  const cosine = dot(angleBetweenScratch, angleBetweenScratch2);
  const sine = magnitude(
    cross(angleBetweenScratch, angleBetweenScratch2, angleBetweenScratch),
  );
  return Math.atan2(sine, cosine);
}
