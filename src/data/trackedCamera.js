import {
  distance,
  eastNorthUp,
  inverseFrameVector,
  normalize,
  scale,
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
