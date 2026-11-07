/**
 * @module geo/ellipsoid
 * @description The WGS84 ellipsoid: geodetic and Earth-centred, Earth-fixed
 * (ECEF) conversions, surface normals and projection onto the surface. The
 * formulas follow the default renderer's step for step, so they agree with
 * it to floating-point noise.
 *
 * Into ECEF, positions are arguments (`fromDegrees(lon, lat, height)`,
 * `fromRadians` likewise); out of it, objects (`toLonLatH` gives
 * `{lon, lat, height}` in degrees, `toCartographicRadians` the same in
 * radians). Cesium's `Cartographic.fromDegrees(lon, lat, h)` is plain
 * `{lon: toRadians(lon), lat: toRadians(lat), height: h}`; for its ECEF
 * point, use `fromDegrees`.
 *
 * NaN in gives NaN fields out, never a throw (Cesium's debug build throws).
 * The Earth's centre, and points so near it that their squares round to
 * zero, answer null, as Cesium answers undefined.
 */
import {
  add,
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

/**
 * An ellipsoid with these radii, in the form `WGS84` has: for code that
 * works on a surface other than WGS84 (the ground raised to a height, a
 * horizon taken below it). Pass it as the trailing argument of the
 * functions that take one.
 * @param {{x: number, y: number, z: number}} radii
 */
export function ellipsoidOf({ x, y, z }) {
  return Object.freeze({
    radii: Object.freeze({ x, y, z }),
    radiiSquared: Object.freeze({ x: x * x, y: y * y, z: z * z }),
    oneOverRadii: Object.freeze({ x: 1 / x, y: 1 / y, z: 1 / z }),
    oneOverRadiiSquared: Object.freeze({
      x: 1 / (x * x),
      y: 1 / (y * y),
      z: 1 / (z * z),
    }),
  });
}

/** WGS84 with every radius `metres` longer (shorter, when negative). */
export function offsetEllipsoid(metres) {
  const { x, y, z } = WGS84.radii;
  return ellipsoidOf({ x: x + metres, y: y + metres, z: z + metres });
}

/**
 * The ellipsoid a trailing argument names: one from `ellipsoidOf`, else
 * WGS84 (so these functions can still be handed to `map`, whose index
 * lands there).
 */
const ellipsoidArg = (ellipsoid) =>
  ellipsoid?.oneOverRadiiSquared ? ellipsoid : WGS84;

const EPSILON12 = 1e-12;
const CENTER_TOLERANCE_SQUARED = 0.1;

export function geodeticSurfaceNormal(p, ellipsoid) {
  const o = ellipsoidArg(ellipsoid).oneOverRadiiSquared;
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
  k = vec(k.x / gamma, k.y / gamma, k.z / gamma);
  return add(k, scale(n, height));
}

/** Geodetic degrees and metres to ECEF. */
export const fromDegrees = (lon, lat, height = 0) =>
  fromRadians(toRadians(lon), toRadians(lat), height);

/**
 * A position as ECEF (a new object): `{lon, lat, height?}` (degrees, metres
 * above the ellipsoid) or `{x, y, z}`, the render contract's `Position`.
 */
export function positionToEcef(position) {
  if ('lon' in position && 'lat' in position)
    return fromDegrees(position.lon, position.lat, position.height ?? 0);
  return vec(position.x, position.y, position.z);
}

/** The point on the ellipsoid along the geodetic normal, or null at the centre. */
export function scaleToGeodeticSurface(p, ellipsoid) {
  const e = ellipsoidArg(ellipsoid);
  const { x: positionX, y: positionY, z: positionZ } = p;
  const oneOverRadiiX = e.oneOverRadii.x;
  const oneOverRadiiY = e.oneOverRadii.y;
  const oneOverRadiiZ = e.oneOverRadii.z;
  const x2 = positionX * positionX * oneOverRadiiX * oneOverRadiiX;
  const y2 = positionY * positionY * oneOverRadiiY * oneOverRadiiY;
  const z2 = positionZ * positionZ * oneOverRadiiZ * oneOverRadiiZ;
  const squaredNorm = x2 + y2 + z2;
  const ratio = Math.sqrt(1.0 / squaredNorm);
  const intersection = scale(p, ratio);
  if (squaredNorm < CENTER_TOLERANCE_SQUARED)
    return Number.isFinite(ratio) ? intersection : null;

  const oneOverRadiiSquaredX = e.oneOverRadiiSquared.x;
  const oneOverRadiiSquaredY = e.oneOverRadiiSquared.y;
  const oneOverRadiiSquaredZ = e.oneOverRadiiSquared.z;
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

/**
 * ECEF to geodetic `{lon, lat}` radians and `height` metres, or null at the
 * centre; on `ellipsoid` (from `ellipsoidOf`) when given, else WGS84.
 */
export function toCartographicRadians(p, ellipsoid) {
  const surface = scaleToGeodeticSurface(p, ellipsoid);
  if (!surface) return null;
  const n = geodeticSurfaceNormal(surface, ellipsoid);
  const h = sub(p, surface);
  return {
    lon: Math.atan2(n.y, n.x),
    lat: Math.asin(n.z),
    height: Math.sign(dot(h, p)) * magnitude(h),
  };
}

/** ECEF to `{lon, lat}` degrees and `height` metres, on `ellipsoid` as `toCartographicRadians`. */
export function toLonLatH(p, ellipsoid) {
  const c = toCartographicRadians(p, ellipsoid);
  if (!c) return null;
  return { lon: toDegrees(c.lon), lat: toDegrees(c.lat), height: c.height };
}

/**
 * Where a ray first meets the ellipsoid ahead of its origin, as Cesium's
 * `camera.pickEllipsoid` takes the hit, or null when it misses; on
 * `ellipsoid` (from `ellipsoidOf`) when given, else WGS84.
 * @param {{origin: {x: number, y: number, z: number},
 *   direction: {x: number, y: number, z: number}}} ray
 * @param {typeof WGS84} [ellipsoid]
 */
export function rayEllipsoid(ray, ellipsoid) {
  const r = ellipsoidArg(ellipsoid).oneOverRadii;
  const q = vec(ray.origin.x * r.x, ray.origin.y * r.y, ray.origin.z * r.z);
  const w = vec(
    ray.direction.x * r.x,
    ray.direction.y * r.y,
    ray.direction.z * r.z,
  );
  const a = dot(w, w);
  const b = 2 * dot(q, w);
  const c = dot(q, q) - 1;
  const disc = b * b - 4 * a * c;
  if (disc < 0) return null;
  const sq = Math.sqrt(disc);
  const t0 = (-b - sq) / (2 * a);
  const t1 = (-b + sq) / (2 * a);
  const t = t0 >= 0 ? t0 : t1 >= 0 ? t1 : null;
  if (t === null) return null;
  return add(ray.origin, scale(ray.direction, t));
}
