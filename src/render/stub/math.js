/**
 * @module render/stub/math
 * @description The geodesy and vector maths the stub renderer poses its
 * camera with: WGS84, east-north-up frames, rigid transforms and the camera
 * angle conventions of the contract (heading clockwise from north, pitch
 * negative looking down). Plain objects and numbers, no engine.
 *
 * The formulas follow the default renderer's, step for step, so the stub's
 * poses match its reference traces to floating-point noise.
 */

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

export const TWO_PI = Math.PI * 2;
export const PI_OVER_TWO = Math.PI / 2;
const EPSILON3 = 1e-3;
const EPSILON10 = 1e-10;
const EPSILON12 = 1e-12;
const EPSILON14 = 1e-14;
const CENTER_TOLERANCE_SQUARED = 0.1;

export const vec = (x = 0, y = 0, z = 0) => ({ x, y, z });
export const clone = (a) => ({ x: a.x, y: a.y, z: a.z });
export const add = (a, b) => vec(a.x + b.x, a.y + b.y, a.z + b.z);
export const sub = (a, b) => vec(a.x - b.x, a.y - b.y, a.z - b.z);
export const scale = (a, s) => vec(a.x * s, a.y * s, a.z * s);
export const negate = (a) => vec(-a.x, -a.y, -a.z);
export const dot = (a, b) => a.x * b.x + a.y * b.y + a.z * b.z;
export const cross = (a, b) =>
  vec(a.y * b.z - a.z * b.y, a.z * b.x - a.x * b.z, a.x * b.y - a.y * b.x);
export const magnitude = (a) => Math.sqrt(dot(a, a));
export const distance = (a, b) => magnitude(sub(a, b));
export function normalize(a) {
  const m = magnitude(a);
  return vec(a.x / m, a.y / m, a.z / m);
}

export const toRadians = (degrees) => (degrees * Math.PI) / 180;
export const toDegrees = (radians) => (radians * 180) / Math.PI;
export const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
export const acosClamped = (v) => Math.acos(clamp(v, -1, 1));
export const equalsEpsilon = (a, b, eps) => Math.abs(a - b) <= eps;

/** An angle in [0, 2π). */
export function zeroToTwoPi(angle) {
  if (angle >= 0 && angle <= TWO_PI) return angle;
  const mod = ((angle % TWO_PI) + TWO_PI) % TWO_PI;
  if (Math.abs(mod) < EPSILON14 && Math.abs(angle) > EPSILON14) return TWO_PI;
  return mod;
}

/** An angle in [-π, π]. */
export function negativePiToPi(angle) {
  if (angle >= -Math.PI && angle <= Math.PI) return angle;
  return zeroToTwoPi(angle + Math.PI) - Math.PI;
}

// --- Geodesy -----------------------------------------------------------------

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

// --- Rigid frames ------------------------------------------------------------

/**
 * A rigid frame: unit axes `x`, `y`, `z` (columns) and an `origin`, mapping
 * local coordinates to ECEF.
 * @typedef {{x: object, y: object, z: object, origin: object}} Frame
 */

export const IDENTITY = Object.freeze({
  x: Object.freeze(vec(1, 0, 0)),
  y: Object.freeze(vec(0, 1, 0)),
  z: Object.freeze(vec(0, 0, 1)),
  origin: Object.freeze(vec(0, 0, 0)),
});

export const isIdentity = (frame) =>
  frame === IDENTITY ||
  (frame.x.x === 1 &&
    frame.y.y === 1 &&
    frame.z.z === 1 &&
    frame.x.y === 0 &&
    frame.x.z === 0 &&
    frame.y.x === 0 &&
    frame.y.z === 0 &&
    frame.z.x === 0 &&
    frame.z.y === 0 &&
    frame.origin.x === 0 &&
    frame.origin.y === 0 &&
    frame.origin.z === 0);

/** East-north-up at `origin`. */
export function eastNorthUp(origin) {
  if (
    equalsEpsilon(origin.x, 0, EPSILON14) &&
    equalsEpsilon(origin.y, 0, EPSILON14)
  ) {
    // At a pole: east is +y, north points away from the pole.
    const sign = Math.sign(origin.z) || 1;
    return {
      x: vec(0, 1, 0),
      y: vec(-sign, 0, 0),
      z: vec(0, 0, sign),
      origin: clone(origin),
    };
  }
  const up = geodeticSurfaceNormal(origin);
  const east = normalize(vec(-origin.y, origin.x, 0));
  const north = cross(up, east);
  return { x: east, y: north, z: up, origin: clone(origin) };
}

export const frameVector = (frame, v) =>
  vec(
    frame.x.x * v.x + frame.y.x * v.y + frame.z.x * v.z,
    frame.x.y * v.x + frame.y.y * v.y + frame.z.y * v.z,
    frame.x.z * v.x + frame.y.z * v.y + frame.z.z * v.z,
  );
export const framePoint = (frame, p) =>
  add(frameVector(frame, p), frame.origin);
export const inverseFrameVector = (frame, v) =>
  vec(dot(frame.x, v), dot(frame.y, v), dot(frame.z, v));
export const inverseFramePoint = (frame, p) =>
  inverseFrameVector(frame, sub(p, frame.origin));

// --- Rotations ---------------------------------------------------------------

/** Rotate `v` about unit `axis` by `angle` (right-handed). */
export function rotate(v, axis, angle) {
  const c = Math.cos(angle);
  const s = Math.sin(angle);
  const d = dot(axis, v);
  const k = cross(axis, v);
  return vec(
    v.x * c + k.x * s + axis.x * d * (1 - c),
    v.y * c + k.y * s + axis.y * d * (1 - c),
    v.z * c + k.z * s + axis.z * d * (1 - c),
  );
}

/**
 * The rotation the contract's heading, pitch and roll describe in a local
 * east-north-up frame, as its three columns: the direction, the left axis
 * and the up vector.
 */
export function headingPitchRollColumns(heading, pitch, roll) {
  const h = heading - PI_OVER_TWO;
  const rotateAll = (v) =>
    rotate(
      rotate(rotate(v, vec(1, 0, 0), roll), vec(0, 1, 0), -pitch),
      vec(0, 0, 1),
      -h,
    );
  return {
    direction: rotateAll(vec(1, 0, 0)),
    left: rotateAll(vec(0, 1, 0)),
    up: rotateAll(vec(0, 0, 1)),
  };
}

/** Heading of a local direction and up, radians clockwise from north. */
export function headingOf(direction, up) {
  const h = !equalsEpsilon(Math.abs(direction.z), 1.0, EPSILON3)
    ? Math.atan2(direction.y, direction.x) - PI_OVER_TWO
    : Math.atan2(up.y, up.x) - PI_OVER_TWO;
  return TWO_PI - zeroToTwoPi(h);
}

export const pitchOf = (direction) => PI_OVER_TWO - acosClamped(direction.z);

export function rollOf(direction, up, right) {
  if (equalsEpsilon(Math.abs(direction.z), 1.0, EPSILON3)) return 0;
  return zeroToTwoPi(Math.atan2(-right.z, up.z) + TWO_PI);
}

/** The local offset a heading, pitch and range puts the eye at. */
export function offsetFromHeadingPitchRange(heading, pitch, range) {
  const p = clamp(pitch, -PI_OVER_TWO, PI_OVER_TWO);
  const h = zeroToTwoPi(heading) - PI_OVER_TWO;
  const offset = rotate(
    rotate(vec(1, 0, 0), vec(0, 1, 0), -p),
    vec(0, 0, 1),
    -h,
  );
  return scale(negate(offset), range);
}

export { EPSILON10 };
