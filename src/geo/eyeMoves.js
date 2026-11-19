/**
 * @module geo/eyeMoves
 * @description Moving and turning the eye from its pose, as `setView` takes
 * the result: the app's step-by-step camera motions (pans, in-place turns, the
 * globe turned under the eye, zooms) are these sums over the camera port's
 * pose, so the renderer moves this way without a verb of its own.
 * Each keeps the eye's world pose otherwise; a renderer keeps a `lookAt`
 * frame across `setView`.
 */
import { add, cross, negate, normalize, scale } from './vector.js';
import { rotate } from './frames.js';

/**
 * A `setView` view: the eye at `position`, looking along `direction` with
 * `up` up.
 * @typedef {{destination: {x: number, y: number, z: number},
 *   orientation: {direction: {x: number, y: number, z: number},
 *   up: {x: number, y: number, z: number}}}} EyeView
 */

const view = (position, direction, up) => ({
  destination: position,
  orientation: { direction, up },
});

/**
 * The eye moved `metres` along one of its own axes.
 * @param {{position: object, direction: object, up: object, right: object}} pose
 * @param {'forward'|'back'|'left'|'right'|'up'|'down'} direction
 * @param {number} metres
 * @returns {EyeView}
 */
export function eyeMoved(pose, direction, metres) {
  const axes = {
    forward: pose.direction,
    back: negate(pose.direction),
    right: pose.right,
    left: negate(pose.right),
    up: pose.up,
    down: negate(pose.up),
  };
  if (!Object.hasOwn(axes, direction))
    throw new RangeError(`no move direction '${direction}'`);
  return view(
    add(pose.position, scale(axes[direction], metres)),
    pose.direction,
    pose.up,
  );
}

/**
 * The eye turned in place by `radians`: left and right about its own up,
 * up and down about its own right.
 * @param {{position: object, direction: object, up: object, right: object}} pose
 * @param {'left'|'right'|'up'|'down'} direction
 * @param {number} radians
 * @returns {EyeView}
 */
export function eyeTurned(pose, direction, radians) {
  const turns = {
    left: [pose.up, radians],
    right: [pose.up, -radians],
    up: [pose.right, radians],
    down: [pose.right, -radians],
  };
  if (!Object.hasOwn(turns, direction))
    throw new RangeError(`no look direction '${direction}'`);
  const [axis, angle] = turns[direction];
  const a = normalize(axis);
  return view(
    pose.position,
    rotate(pose.direction, a, angle),
    rotate(pose.up, a, angle),
  );
}

/**
 * The eye carried about `axis` through the Earth's centre by `radians`,
 * position and view together: a positive angle turns it clockwise seen
 * from the axis's tip (the globe seems to turn the other way).
 * @param {{position: object, direction: object, up: object}} pose
 * @param {{x: number, y: number, z: number}} axis
 * @param {number} radians
 * @returns {EyeView}
 */
export function eyeRotatedAbout(pose, axis, radians) {
  const a = normalize(axis);
  const direction = rotate(pose.direction, a, -radians);
  const turnedUp = rotate(pose.up, a, -radians);
  const right = cross(direction, turnedUp);
  return view(
    rotate(pose.position, a, -radians),
    normalize(direction),
    normalize(cross(right, direction)),
  );
}

/**
 * The eye moved `metres` along its view direction; negative backs away.
 * @param {{position: object, direction: object, up: object, right: object}} pose
 * @param {number} metres
 * @returns {EyeView}
 */
export const eyeZoomed = (pose, metres) => eyeMoved(pose, 'forward', metres);
