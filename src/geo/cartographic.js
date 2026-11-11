// Ported from CesiumJS 1.138 (Apache-2.0) — Cartographic.js
//
// Geodetic positions as plain-data {longitude, latitude, height} objects (radians and
// metres). Every function takes an optional `result` and returns it.
//
// Geo values are not Object.prototype objects, so src/app/stateChannel.js
// copyState and src/director/documentFields.js jsonTree reject them: copy
// the fields into a literal before putting one into product state or a
// scene document.

import { toRadians } from './math.js';
import * as cartesian3 from './cartesian3.js';
import { scaleToGeodeticSurface } from './scaleToGeodeticSurface.js';

// Values are instances of a module-private constructor rather than object
// literals: every `{longitude, latitude, height}` literal in the process shares one V8 hidden
// class, and code elsewhere that builds such literals would make geo's hot
// functions polymorphic. The instances still look like plain data: own
// enumerable fields only, no prototype methods or getters.
function Geodetic(longitude, latitude, height) {
  this.longitude = longitude;
  this.latitude = latitude;
  this.height = height;
}

/** A geodetic position (Cesium's `new Cartographic(longitude, latitude, height)`). */
export function create(longitude, latitude, height) {
  return new Geodetic(longitude ?? 0.0, latitude ?? 0.0, height ?? 0.0);
}

// WGS84 constants used when no ellipsoid is given (Cesium's
// Cartographic._ellipsoidOneOverRadii and friends; bit-equal to
// ellipsoid.WGS84's fields). Local, as in Cesium, so that ellipsoid.js can
// import this module without a cycle.
const WGS84_ONE_OVER_RADII = Object.freeze(
  cartesian3.create(1.0 / 6378137.0, 1.0 / 6378137.0, 1.0 / 6356752.3142451793),
);
const WGS84_ONE_OVER_RADII_SQUARED = Object.freeze(
  cartesian3.create(
    1.0 / (6378137.0 * 6378137.0),
    1.0 / (6378137.0 * 6378137.0),
    1.0 / (6356752.3142451793 * 6356752.3142451793),
  ),
);
// Cesium's CesiumMath.EPSILON1.
const WGS84_CENTER_TOLERANCE_SQUARED = 0.1;

/** A geodetic position from radians. */
export function fromRadians(longitude, latitude, height, result) {
  height = height ?? 0.0;
  if (result == null) return create(longitude, latitude, height);
  result.longitude = longitude;
  result.latitude = latitude;
  result.height = height;
  return result;
}

/** A geodetic position from degrees; the result is in radians. */
export function fromDegrees(longitude, latitude, height, result) {
  longitude = toRadians(longitude);
  latitude = toRadians(latitude);
  return fromRadians(longitude, latitude, height, result);
}

const cartesianToCartographicN = cartesian3.create();
const cartesianToCartographicP = cartesian3.create();
const cartesianToCartographicH = cartesian3.create();

/**
 * The geodetic position of an Earth-fixed point, or `undefined` when the point
 * is at the centre of the ellipsoid (WGS84 by default).
 */
export function fromCartesian(cartesian, ellipsoid, result) {
  // Cesium falls back to Ellipsoid.default; gev never changes it, so WGS84.
  // A Cesium Ellipsoid keeps the tolerance in `_centerToleranceSquared`.
  const oneOverRadii =
    ellipsoid == null ? WGS84_ONE_OVER_RADII : ellipsoid.oneOverRadii;
  const oneOverRadiiSquared =
    ellipsoid == null
      ? WGS84_ONE_OVER_RADII_SQUARED
      : ellipsoid.oneOverRadiiSquared;
  const centerToleranceSquared =
    ellipsoid == null
      ? WGS84_CENTER_TOLERANCE_SQUARED
      : (ellipsoid.centerToleranceSquared ?? ellipsoid._centerToleranceSquared);

  const p = scaleToGeodeticSurface(
    cartesian,
    oneOverRadii,
    oneOverRadiiSquared,
    centerToleranceSquared,
    cartesianToCartographicP,
  );
  if (p === undefined) return undefined;

  let n = cartesian3.multiplyComponents(
    p,
    oneOverRadiiSquared,
    cartesianToCartographicN,
  );
  n = cartesian3.normalize(n, n);

  const h = cartesian3.subtract(cartesian, p, cartesianToCartographicH);

  const longitude = Math.atan2(n.y, n.x);
  const latitude = Math.asin(n.z);
  const height =
    Math.sign(cartesian3.dot(h, cartesian)) * cartesian3.magnitude(h);

  if (result == null) return create(longitude, latitude, height);
  result.longitude = longitude;
  result.latitude = latitude;
  result.height = height;
  return result;
}

/**
 * The Earth-fixed position of a geodetic one on the ellipsoid (WGS84 by default,
 * where Cesium uses Ellipsoid.default; gev never changes it).
 */
export function toCartesian(cartographic, ellipsoid, result) {
  return cartesian3.fromRadians(
    cartographic.longitude,
    cartographic.latitude,
    cartographic.height,
    ellipsoid,
    result,
  );
}

/** Copies a geodetic position; `undefined` when there is none. */
export function clone(cartographic, result) {
  if (cartographic == null) return undefined;
  if (result == null) {
    return create(
      cartographic.longitude,
      cartographic.latitude,
      cartographic.height,
    );
  }
  result.longitude = cartographic.longitude;
  result.latitude = cartographic.latitude;
  result.height = cartographic.height;
  return result;
}
