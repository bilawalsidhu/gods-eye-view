// Ported from CesiumJS 1.138 (Apache-2.0) — Transforms.js, Quaternion.js, Matrix4.js
//
// Local east-north-up frames and heading-pitch-roll orientations as 4x4
// column-major matrices (see matrix4.js). Outputs match Cesium bit for bit,
// including the degenerate frames at the Earth's centre and at the poles.

import {
  EPSILON14,
  TWO_PI,
  equalsEpsilon as scalarEqualsEpsilon,
} from './math.js';
import * as JulianDate from './julianDate.js';
import {
  create as createCartesian3,
  cross,
  equalsEpsilon,
  multiplyByScalar,
  normalize,
  UNIT_X,
  UNIT_Y,
  UNIT_Z,
  ZERO,
} from './cartesian3.js';
import { WGS84 } from './ellipsoid.js';
import { create as createMatrix4, multiply } from './matrix4.js';
import { create as createQuaternion, fromAxisAngle } from './quaternion.js';

// Cesium's degeneratePositionLocalFrame for the three ENU axes.
const DEGENERATE_EAST = [0, 1, 0];
const DEGENERATE_NORTH = [-1, 0, 0];
const DEGENERATE_UP = [0, 0, 1];

const scratchEast = createCartesian3();
const scratchNorth = createCartesian3();
const scratchUp = createCartesian3();

function unpack(array, result) {
  result.x = array[0];
  result.y = array[1];
  result.z = array[2];
  return result;
}

/**
 * The transformation from the local east-north-up frame centred at `origin`
 * to the Earth-fixed frame (Cesium's
 * `Transforms.localFrameToFixedFrameGenerator('east', 'north')`).
 */
export function eastNorthUpToFixedFrame(origin, ellipsoid, result) {
  if (result == null) result = createMatrix4();

  const east = scratchEast;
  const north = scratchNorth;
  const up = scratchUp;

  if (equalsEpsilon(origin, ZERO, EPSILON14)) {
    // If x, y, and z are zero, use the degenerate local frame, which is a special case
    unpack(DEGENERATE_EAST, east);
    unpack(DEGENERATE_NORTH, north);
    unpack(DEGENERATE_UP, up);
  } else if (
    scalarEqualsEpsilon(origin.x, 0.0, EPSILON14) &&
    scalarEqualsEpsilon(origin.y, 0.0, EPSILON14)
  ) {
    // If x and y are zero, assume origin is at a pole, which is a special case.
    const sign = Math.sign(origin.z);
    unpack(DEGENERATE_EAST, east);
    unpack(DEGENERATE_NORTH, north);
    multiplyByScalar(north, sign, north);
    unpack(DEGENERATE_UP, up);
    multiplyByScalar(up, sign, up);
  } else {
    // Cesium falls back to Ellipsoid.default; gev never changes it, so WGS84.
    ellipsoid = ellipsoid ?? WGS84;
    ellipsoid.geodeticSurfaceNormal(origin, up);
    east.x = -origin.y;
    east.y = origin.x;
    east.z = 0.0;
    normalize(east, east);
    cross(up, east, north);
  }

  result[0] = east.x;
  result[1] = east.y;
  result[2] = east.z;
  result[3] = 0.0;
  result[4] = north.x;
  result[5] = north.y;
  result[6] = north.z;
  result[7] = 0.0;
  result[8] = up.x;
  result[9] = up.y;
  result[10] = up.z;
  result[11] = 0.0;
  result[12] = origin.x;
  result[13] = origin.y;
  result[14] = origin.z;
  result[15] = 1.0;
  return result;
}

// Quaternion.multiply
function multiplyQuaternions(left, right, result) {
  const leftX = left.x;
  const leftY = left.y;
  const leftZ = left.z;
  const leftW = left.w;

  const rightX = right.x;
  const rightY = right.y;
  const rightZ = right.z;
  const rightW = right.w;

  const x = leftW * rightX + leftX * rightW + leftY * rightZ - leftZ * rightY;
  const y = leftW * rightY - leftX * rightZ + leftY * rightW + leftZ * rightX;
  const z = leftW * rightZ + leftX * rightY - leftY * rightX + leftZ * rightW;
  const w = leftW * rightW - leftX * rightX - leftY * rightY - leftZ * rightZ;

  result.x = x;
  result.y = y;
  result.z = z;
  result.w = w;
  return result;
}

const scratchHPRAxisQuaternion = createQuaternion();

// Quaternion.fromHeadingPitchRoll
function quaternionFromHeadingPitchRoll(headingPitchRoll, result) {
  const rollQuaternion = fromAxisAngle(
    UNIT_X,
    headingPitchRoll.roll,
    scratchHPRAxisQuaternion,
  );
  const pitchQuaternion = fromAxisAngle(
    UNIT_Y,
    -headingPitchRoll.pitch,
    result,
  );
  result = multiplyQuaternions(
    pitchQuaternion,
    rollQuaternion,
    pitchQuaternion,
  );
  const headingQuaternion = fromAxisAngle(
    UNIT_Z,
    -headingPitchRoll.heading,
    scratchHPRAxisQuaternion,
  );
  return multiplyQuaternions(headingQuaternion, result, result);
}

// Matrix4.fromTranslationQuaternionRotationScale with a zero translation and a unit scale.
function rotationFromQuaternion(rotation, result) {
  const scaleX = 1.0;
  const scaleY = 1.0;
  const scaleZ = 1.0;

  const x2 = rotation.x * rotation.x;
  const xy = rotation.x * rotation.y;
  const xz = rotation.x * rotation.z;
  const xw = rotation.x * rotation.w;
  const y2 = rotation.y * rotation.y;
  const yz = rotation.y * rotation.z;
  const yw = rotation.y * rotation.w;
  const z2 = rotation.z * rotation.z;
  const zw = rotation.z * rotation.w;
  const w2 = rotation.w * rotation.w;

  const m00 = x2 - y2 - z2 + w2;
  const m01 = 2.0 * (xy - zw);
  const m02 = 2.0 * (xz + yw);

  const m10 = 2.0 * (xy + zw);
  const m11 = -x2 + y2 - z2 + w2;
  const m12 = 2.0 * (yz - xw);

  const m20 = 2.0 * (xz - yw);
  const m21 = 2.0 * (yz + xw);
  const m22 = -x2 - y2 + z2 + w2;

  result[0] = m00 * scaleX;
  result[1] = m10 * scaleX;
  result[2] = m20 * scaleX;
  result[3] = 0.0;
  result[4] = m01 * scaleY;
  result[5] = m11 * scaleY;
  result[6] = m21 * scaleY;
  result[7] = 0.0;
  result[8] = m02 * scaleZ;
  result[9] = m12 * scaleZ;
  result[10] = m22 * scaleZ;
  result[11] = 0.0;
  result[12] = 0.0;
  result[13] = 0.0;
  result[14] = 0.0;
  result[15] = 1.0;
  return result;
}

const scratchHPRQuaternion = createQuaternion();
const scratchHPRMatrix4 = createMatrix4();

/**
 * The transformation from a frame rotated by `headingPitchRoll` ({heading,
 * pitch, roll} in radians) inside the local frame centred at `origin` to the
 * Earth-fixed frame. Same argument order as Cesium: `fixedFrameTransform`
 * defaults to the east-north-up frame and `result` is the fifth argument.
 */
export function headingPitchRollToFixedFrame(
  origin,
  headingPitchRoll,
  ellipsoid,
  fixedFrameTransform,
  result,
) {
  fixedFrameTransform = fixedFrameTransform ?? eastNorthUpToFixedFrame;
  const hprQuaternion = quaternionFromHeadingPitchRoll(
    headingPitchRoll,
    scratchHPRQuaternion,
  );
  const hprMatrix = rotationFromQuaternion(hprQuaternion, scratchHPRMatrix4);
  result = fixedFrameTransform(origin, ellipsoid, result);
  return multiply(result, hprMatrix, result);
}

const gmstConstant0 = 6 * 3600 + 41 * 60 + 50.54841;
const gmstConstant1 = 8640184.812866;
const gmstConstant2 = 0.093104;
const gmstConstant3 = -6.2e-6;
const rateCoef = 1.1772758384668e-19;
const wgs84WRPrecessing = 7.2921158553e-5;
const twoPiOverSecondsInDay = TWO_PI / 86400.0;
let dateInUtc = { dayNumber: 0, secondsOfDay: 0 };

/**
 * The rotation from the True Equator Mean Equinox (TEME) axes to the
 * pseudo-fixed axes at a geo/julianDate.js date: Cesium's
 * computeTemeToPseudoFixedMatrix, which takes UTC for UT1.
 */
export function computeTemeToPseudoFixedMatrix(date, result) {
  dateInUtc = JulianDate.addSeconds(
    date,
    -JulianDate.computeTaiMinusUtc(date),
    dateInUtc,
  );
  const utcDayNumber = dateInUtc.dayNumber;
  const utcSecondsIntoDay = dateInUtc.secondsOfDay;

  let t;
  const diffDays = utcDayNumber - 2451545;
  if (utcSecondsIntoDay >= 43200.0) {
    t = (diffDays + 0.5) / 36525.0;
  } else {
    t = (diffDays - 0.5) / 36525.0;
  }

  const gmst0 =
    gmstConstant0 +
    t * (gmstConstant1 + t * (gmstConstant2 + t * gmstConstant3));
  const angle = (gmst0 * twoPiOverSecondsInDay) % TWO_PI;
  const ratio = wgs84WRPrecessing + rateCoef * (utcDayNumber - 2451545.5);
  const secondsSinceMidnight = (utcSecondsIntoDay + 86400.0 * 0.5) % 86400.0;
  const gha = angle + ratio * secondsSinceMidnight;
  const cosGha = Math.cos(gha);
  const sinGha = Math.sin(gha);

  if (result == null) result = new Array(9);
  result[0] = cosGha;
  result[1] = -sinGha;
  result[2] = 0.0;
  result[3] = sinGha;
  result[4] = cosGha;
  result[5] = 0.0;
  result[6] = 0.0;
  result[7] = 0.0;
  result[8] = 1.0;
  return result;
}
