/**
 * @module render/stub/math
 * @description The maths the stub renderer poses its camera with: the shared
 * geodesy (`src/geo`) and the camera angle conventions of the contract
 * (heading clockwise from north, pitch negative looking down).
 *
 * The formulas follow the default renderer's, step for step, so the stub's
 * poses match its reference traces to floating-point noise.
 */
import {
  PI_OVER_TWO,
  TWO_PI,
  acosClamped,
  clamp,
  equalsEpsilon,
  negate,
  clone,
  fromDegrees,
  rotate,
  scale,
  vec,
  zeroToTwoPi,
} from '../../geo/index.js';

export * from '../../geo/index.js';

/** A contract `Position` (`Ecef` or `LonLatH`, degrees), as ECEF. */
export function toEcef(position) {
  if ('lon' in position && 'lat' in position)
    return fromDegrees(position.lon, position.lat, position.height ?? 0);
  return clone(position);
}

const EPSILON3 = 1e-3;
const EPSILON10 = 1e-10;

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
