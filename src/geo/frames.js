/**
 * @module geo/frames
 * @description Rigid frames (unit axes and an origin, local to ECEF), the
 * east-north-up frame at a point, and rotation about an axis.
 */
import { geodeticSurfaceNormal } from './ellipsoid.js';
import {
  EPSILON14,
  add,
  clone,
  cross,
  dot,
  equalsEpsilon,
  normalize,
  sub,
  vec,
} from './vector.js';

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
