/**
 * @module geo/ellipsoid
 * @description The WGS84 ellipsoid: geodetic and Earth-centred, Earth-fixed
 * (ECEF) conversions, surface normals and projection onto the surface. The
 * formulas follow the default renderer's step for step, so they agree with
 * it to floating-point noise.
 */
import {
  add,
  clone,
  dot,
  magnitude,
  normalize,
  scale,
  sub,
  toDegrees,
  toRadians,
  vec,
} from './vector.js';

export const WGS84 = Object.freeze({
  radii: Object.freeze({ x: 6378137.0, y: 6378137.0, z: 6356752.3142451793 }),
  radiiSquared: Object.freeze({
    x: 6378137.0 * 6378137.0,
    y: 6378137.0 * 6378137.0,
    z: 6356752.3142451793 * 6356752.3142451793,
  }),
  oneOverRadii: Object.freeze({
    x: 1 / 6378137.0,
    y: 1 / 6378137.0,
    z: 1 / 6356752.3142451793,
  }),
  oneOverRadiiSquared: Object.freeze({
    x: 1 / (6378137.0 * 6378137.0),
    y: 1 / (6378137.0 * 6378137.0),
    z: 1 / (6356752.3142451793 * 6356752.3142451793),
  }),
});

const EPSILON12 = 1e-12;
const CENTER_TOLERANCE_SQUARED = 0.1;

export function geodeticSurfaceNormal(p) {
  const o = WGS84.oneOverRadiiSquared;
  return normalize(vec(p.x * o.x, p.y * o.y, p.z * o.z));
}

function geodeticSurfaceNormalCartographic(lon, lat) {
  const cosLat = Math.cos(lat);
  return normalize(
    vec(cosLat * Math.cos(lon), cosLat * Math.sin(lon), Math.sin(lat)),
  );
}

/** Geodetic radians and metres to ECEF. */
export function fromRadians(lon, lat, height = 0) {
  const n = geodeticSurfaceNormalCartographic(lon, lat);
  const r = WGS84.radiiSquared;
  let k = vec(r.x * n.x, r.y * n.y, r.z * n.z);
  const gamma = Math.sqrt(dot(n, k));
  k = scale(k, 1 / gamma);
  return add(k, scale(n, height));
}

/** Geodetic degrees and metres to ECEF. */
export const fromDegrees = (lon, lat, height = 0) =>
  fromRadians(toRadians(lon), toRadians(lat), height);

/** A position in either contract form, as ECEF. */
export function toEcef(position) {
  if ('lon' in position && 'lat' in position)
    return fromDegrees(position.lon, position.lat, position.height ?? 0);
  return clone(position);
}

/** The point on the ellipsoid along the geodetic normal, or null at the centre. */
export function scaleToGeodeticSurface(p) {
  const { x: positionX, y: positionY, z: positionZ } = p;
  const oneOverRadiiX = WGS84.oneOverRadii.x;
  const oneOverRadiiY = WGS84.oneOverRadii.y;
  const oneOverRadiiZ = WGS84.oneOverRadii.z;
  const x2 = positionX * positionX * oneOverRadiiX * oneOverRadiiX;
  const y2 = positionY * positionY * oneOverRadiiY * oneOverRadiiY;
  const z2 = positionZ * positionZ * oneOverRadiiZ * oneOverRadiiZ;
  const squaredNorm = x2 + y2 + z2;
  const ratio = Math.sqrt(1.0 / squaredNorm);
  const intersection = scale(p, ratio);
  if (squaredNorm < CENTER_TOLERANCE_SQUARED)
    return Number.isFinite(ratio) ? intersection : null;

  const oneOverRadiiSquaredX = WGS84.oneOverRadiiSquared.x;
  const oneOverRadiiSquaredY = WGS84.oneOverRadiiSquared.y;
  const oneOverRadiiSquaredZ = WGS84.oneOverRadiiSquared.z;
  const gradient = vec(
    intersection.x * oneOverRadiiSquaredX * 2.0,
    intersection.y * oneOverRadiiSquaredY * 2.0,
    intersection.z * oneOverRadiiSquaredZ * 2.0,
  );
  let lambda = ((1.0 - ratio) * magnitude(p)) / (0.5 * magnitude(gradient));
  let correction = 0.0;
  let func, denominator, xMultiplier, yMultiplier, zMultiplier;
  let xMultiplier2, yMultiplier2, zMultiplier2;
  let xMultiplier3, yMultiplier3, zMultiplier3;
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
  return vec(
    positionX * xMultiplier,
    positionY * yMultiplier,
    positionZ * zMultiplier,
  );
}

/** ECEF to geodetic `{lon, lat}` radians and `height` metres, or null at the centre. */
export function toCartographicRadians(p) {
  const surface = scaleToGeodeticSurface(p);
  if (!surface) return null;
  const n = geodeticSurfaceNormal(surface);
  const h = sub(p, surface);
  return {
    lon: Math.atan2(n.y, n.x),
    lat: Math.asin(n.z),
    height: Math.sign(dot(h, p)) * magnitude(h),
  };
}

/** ECEF to `{lon, lat}` degrees and `height` metres. */
export function toLonLatH(p) {
  const c = toCartographicRadians(p);
  if (!c) return null;
  return { lon: toDegrees(c.lon), lat: toDegrees(c.lat), height: c.height };
}
