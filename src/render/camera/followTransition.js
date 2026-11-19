/**
 * @module render/camera/followTransition
 * @description A follow's `transitionS` (`camera.d.ts`), shared by every
 * renderer and by camera controllers (the package's
 * `./render/camera/followTransition` export): the eye's way from where it
 * stood when the follow began to the follow's first framing.
 *
 * Everything is in the target's frame, which moves with the target, so the
 * eye rides along with it from the first frame. Over the transition the eye's
 * offset turns from the offset it had towards `viewFrom` (its length going
 * from the one to the other), and its view turns from the way it looked to
 * the framing's, which looks at the target with no roll. An offset that
 * equals the eye's own direction and range from the target (the camera's
 * current view, kept) leaves the view direction and the range unchanged
 * throughout: only the eye's place moves, and the target slides to the
 * centre.
 */
import {
  cross,
  dot,
  magnitude,
  normalize,
  scale,
  vec,
} from '../../geo/index.js';

const EPSILON10 = 1e-10;

/**
 * The eased fraction of a transition `elapsedMs` into `durationMs`:
 * smoothstep, 0 before it starts and 1 from its end on.
 * @param {number} elapsedMs
 * @param {number} durationMs
 * @returns {number}
 */
export function followTransitionFraction(elapsedMs, durationMs) {
  if (!(durationMs > 0)) return 1;
  const t = Math.min(1, Math.max(0, elapsedMs / durationMs));
  return t * t * (3 - 2 * t);
}

/** `(1 - s) a + s b`, normalized; `fallback` when that has no length. */
function blendUnit(a, b, s, fallback) {
  const v = vec(
    (1 - s) * a.x + s * b.x,
    (1 - s) * a.y + s * b.y,
    (1 - s) * a.z + s * b.z,
  );
  return dot(v, v) > EPSILON10 ? normalize(v) : fallback;
}

/**
 * The eye a follow's first framing places at `offset` in the target's frame:
 * there, looking at the target, its right level with the frame's x-y plane
 * (east-north for an `enu` follow).
 * @param {{x: number, y: number, z: number}} offset
 */
export function followFramingEye(offset) {
  const direction = normalize(scale(offset, -1));
  let right = cross(direction, vec(0, 0, 1));
  right = dot(right, right) < EPSILON10 ? vec(1, 0, 0) : normalize(right);
  return {
    position: { x: offset.x, y: offset.y, z: offset.z },
    direction,
    up: normalize(cross(right, direction)),
    right,
  };
}

/**
 * The eye at eased fraction `s` of a follow's transition, in the target's
 * frame.
 * @param {{position: object, direction: object, up: object}} start The eye
 *   where the transition began, in the target's frame.
 * @param {{x: number, y: number, z: number}} offset The framing's offset
 *   (`viewFrom`, put out to the least range).
 * @param {number} s Eased fraction, 0 to 1 (`followTransitionFraction`).
 * @returns {{position: object, direction: object, up: object, right: object}}
 */
export function followTransitionEye(start, offset, s) {
  const end = followFramingEye(offset);
  if (s >= 1) return end;
  const startRange = magnitude(start.position);
  const endRange = magnitude(offset);
  const along = blendUnit(
    startRange > 0 ? scale(start.position, 1 / startRange) : end.direction,
    scale(end.direction, -1),
    s,
    scale(end.direction, -1),
  );
  const position = scale(along, (1 - s) * startRange + s * endRange);
  const direction = blendUnit(start.direction, end.direction, s, end.direction);
  // The up blended, then made square to the view.
  const blendedUp = blendUnit(start.up, end.up, s, end.up);
  let up = vec(
    blendedUp.x - direction.x * dot(direction, blendedUp),
    blendedUp.y - direction.y * dot(direction, blendedUp),
    blendedUp.z - direction.z * dot(direction, blendedUp),
  );
  up = dot(up, up) > EPSILON10 ? normalize(up) : end.up;
  const right = normalize(cross(direction, up));
  return { position, direction, up, right };
}
