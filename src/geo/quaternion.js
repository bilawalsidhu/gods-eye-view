/**
 * @module geo/quaternion
 * @description Unit quaternions `{x, y, z, w}` and the model
 * heading-pitch-roll convention, in the east-north-up frame at a point: the
 * forward axis is the body's x, which at heading 0 points east; heading
 * turns it clockwise seen from above (heading π/2 points south), pitch
 * raises it, roll turns about it. (The camera's heading, from north, is a
 * different convention.)
 *
 * Each function follows Cesium's formula step by step, so results match it
 * to the last bit. A rotation's axes are given as a frame's `x`, `y`, `z`
 * columns (`geo/frames`), the form of Cesium's column-major `Matrix3`.
 */
import { eastNorthUp } from './frames.js';
import { normalize, vec } from './vector.js';

/** @typedef {{x: number, y: number, z: number, w: number}} Quaternion */

export const quat = (x, y, z, w) => ({ x, y, z, w });

export const IDENTITY_QUATERNION = Object.freeze(quat(0, 0, 0, 1));

/**
 * Rotation by `angle` radians (right-handed) about `axis`, normalised first.
 * Throws a RangeError for an axis with no direction, where Cesium's debug
 * build throws.
 */
export function fromAxisAngle(axis, angle) {
  const halfAngle = angle / 2.0;
  const s = Math.sin(halfAngle);
  const n = normalize(axis);
  if (Number.isNaN(n.x) || Number.isNaN(n.y) || Number.isNaN(n.z))
    throw new RangeError('the axis has no direction');
  return quat(n.x * s, n.y * s, n.z * s, Math.cos(halfAngle));
}

/** The product `left · right`: the rotation that applies `right`, then `left`. */
export function multiplyQuaternions(left, right) {
  const { x: lx, y: ly, z: lz, w: lw } = left;
  const { x: rx, y: ry, z: rz, w: rw } = right;
  return quat(
    lw * rx + lx * rw + ly * rz - lz * ry,
    lw * ry - lx * rz + ly * rw + lz * rx,
    lw * rz + lx * ry - ly * rx + lz * rw,
    lw * rw - lx * rx - ly * ry - lz * rz,
  );
}

export const conjugateQuaternion = (q) => quat(-q.x, -q.y, -q.z, q.w);

/** The rotation's axes: where it takes the unit x, y and z vectors. */
export function toAxes(q) {
  const x2 = q.x * q.x;
  const xy = q.x * q.y;
  const xz = q.x * q.z;
  const xw = q.x * q.w;
  const y2 = q.y * q.y;
  const yz = q.y * q.z;
  const yw = q.y * q.w;
  const z2 = q.z * q.z;
  const zw = q.z * q.w;
  const w2 = q.w * q.w;
  return {
    x: vec(x2 - y2 - z2 + w2, 2.0 * (xy + zw), 2.0 * (xz - yw)),
    y: vec(2.0 * (xy - zw), -x2 + y2 - z2 + w2, 2.0 * (yz + xw)),
    z: vec(2.0 * (xz + yw), 2.0 * (yz - xw), -x2 - y2 + z2 + w2),
  };
}

const NEXT = [1, 2, 0];

/**
 * The quaternion of a rotation given by its axes (orthonormal, right-handed:
 * any frame's `x`, `y`, `z`). Its `w` is positive when the trace is. When
 * the trace is not positive the result is Cesium's: the negative of the
 * textbook quaternion (the same rotation). Keep that negation.
 */
export function fromAxes({ x: c0, y: c1, z: c2 }) {
  // m[i][j]: row i of column j.
  const m = [
    [c0.x, c1.x, c2.x],
    [c0.y, c1.y, c2.y],
    [c0.z, c1.z, c2.z],
  ];
  const trace = m[0][0] + m[1][1] + m[2][2];
  if (trace > 0.0) {
    let root = Math.sqrt(trace + 1.0);
    const w = 0.5 * root;
    root = 0.5 / root;
    return quat(
      (m[2][1] - m[1][2]) * root,
      (m[0][2] - m[2][0]) * root,
      (m[1][0] - m[0][1]) * root,
      w,
    );
  }
  let i = 0;
  if (m[1][1] > m[0][0]) i = 1;
  if (m[2][2] > m[0][0] && m[2][2] > m[1][1]) i = 2;
  const j = NEXT[i];
  const k = NEXT[j];
  let root = Math.sqrt(m[i][i] - m[j][j] - m[k][k] + 1.0);
  const q = [0, 0, 0];
  q[i] = 0.5 * root;
  root = 0.5 / root;
  // Cesium reads getElementIndex(column, row) here, i.e. m[row][column].
  const w = (m[j][k] - m[k][j]) * root;
  q[j] = (m[i][j] + m[j][i]) * root;
  q[k] = (m[i][k] + m[k][i]) * root;
  return quat(-q[0], -q[1], -q[2], w);
}

const UNIT_X = vec(1, 0, 0);
const UNIT_Y = vec(0, 1, 0);
const UNIT_Z = vec(0, 0, 1);

/**
 * Heading, pitch and roll (radians) as a rotation of the local frame: roll
 * about x, then pitch about y, then heading about z. In an east-north-up
 * frame x is east, so heading 0 faces east; see `headingPitchRollFrame`.
 */
export function fromHeadingPitchRoll({ heading = 0, pitch = 0, roll = 0 }) {
  const rollQ = fromAxisAngle(UNIT_X, roll);
  const pitchQ = fromAxisAngle(UNIT_Y, -pitch);
  const headingQ = fromAxisAngle(UNIT_Z, -heading);
  return multiplyQuaternions(headingQ, multiplyQuaternions(pitchQ, rollQ));
}

/**
 * The ECEF axes of a body at `origin` (ECEF metres) turned by heading, pitch
 * and roll in the east-north-up frame there: Cesium's
 * `Transforms.headingPitchRollToFixedFrame`, as a frame.
 */
export function headingPitchRollFrame(origin, hpr) {
  const enu = eastNorthUp(origin);
  const r = toAxes(fromHeadingPitchRoll(hpr));
  // enu · r, column by column, each sum in Cesium's Matrix4.multiply order,
  // its zero translation product included: it turns a -0 sum into +0.
  const col = (c) =>
    vec(
      enu.x.x * c.x + enu.y.x * c.y + enu.z.x * c.z + enu.origin.x * 0.0,
      enu.x.y * c.x + enu.y.y * c.y + enu.z.y * c.z + enu.origin.y * 0.0,
      enu.x.z * c.x + enu.y.z * c.y + enu.z.z * c.z + enu.origin.z * 0.0,
    );
  return { x: col(r.x), y: col(r.y), z: col(r.z), origin: enu.origin };
}

/** Cesium's `Transforms.headingPitchRollQuaternion`. */
export const headingPitchRollQuaternion = (origin, hpr) =>
  fromAxes(headingPitchRollFrame(origin, hpr));
