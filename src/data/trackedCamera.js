import {
  distance,
  eastNorthUp,
  inverseFrameVector,
  magnitude,
  normalize,
  scale,
  vec,
} from '../geo/index.js';

/**
 * Closest a follow camera comes to a tracked aircraft, metres: the camera
 * port's `minRange` for the aircraft layers' FollowTargets.
 */
export const FOLLOW_MIN_RANGE_M = 150;

/**
 * Seconds a follow started by a click on a target takes to slide the target
 * to the centre: the FollowTarget's `transitionS`.
 */
export const SELECTION_FOLLOW_TRANSITION_S = 1;

/**
 * A follow offset that keeps the camera's view of a target it starts
 * following: the eye's own view direction, at its own distance from `at`, in
 * `at`'s east-north-up frame (an `enu` FollowTarget's `viewFrom`). Followed
 * from there, the camera neither zooms nor turns; only the eye moves, so the
 * target comes to the centre. Null without an eye, or with the eye at `at`.
 * @param {{position: object, direction: object}|null|undefined} pose The
 *   camera port's pose.
 * @param {{x: number, y: number, z: number}|null|undefined} at The target.
 * @returns {{x: number, y: number, z: number}|null}
 */
export function keptViewFrom(pose, at) {
  if (!pose?.position || !pose?.direction || !at) return null;
  const range = distance(pose.position, at);
  if (!(range > 0) || !Number.isFinite(range)) return null;
  const look = normalize(inverseFrameVector(eastNorthUp(at), pose.direction));
  return scale(look, -range);
}

/**
 * The least level share of a followed view: a view straight down keeps its
 * heading only through a level part of its own, since a follow's framing
 * turns the eye's right out of it (render/camera/followTransition.js).
 */
const MIN_LEVEL = 1e-4;

/**
 * `keptViewFrom` for a follow: the same range and the same tilt to the
 * target's horizon, turned to the camera's own heading. A follow frames the
 * eye from its offset alone, its heading the way the offset leans. Seen from
 * straight down, the eye's view leans at a target off the centre only as far
 * as the Earth curves between them, and towards the eye: kept as it is, the
 * camera would turn to face the target's bearing. Null as `keptViewFrom`.
 * @param {{position: object, direction: object, heading?: number}|null|undefined} pose
 *   The camera port's pose; `heading` in radians, clockwise from north.
 * @param {{x: number, y: number, z: number}|null|undefined} at The target.
 * @returns {{x: number, y: number, z: number}|null}
 */
export function followViewFrom(pose, at) {
  const kept = keptViewFrom(pose, at);
  if (!kept || !Number.isFinite(pose.heading)) return kept;
  const range = magnitude(kept);
  const lookUp = -kept.z / range;
  const level = Math.max(
    Math.sqrt(Math.max(0, 1 - lookUp * lookUp)),
    MIN_LEVEL,
  );
  const up = Math.sign(lookUp) * Math.sqrt(Math.max(0, 1 - level * level));
  const look = vec(
    level * Math.sin(pose.heading),
    level * Math.cos(pose.heading),
    up,
  );
  return scale(look, -range);
}
