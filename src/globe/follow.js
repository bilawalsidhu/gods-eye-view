// camera.follow, the engine-neutral part: a camera that keeps a moving
// target in the centre at an offset in the target's east-north-up frame
// (Cesium's EntityView, trackedEntity's viewFrom), which the user may turn
// and zoom: each frame the offset is re-read from where the camera is
// (the user's gesture moved it) relative to where the target was, carried
// to where the target is now, kept outside the minimum range, and the
// camera aimed at the target. Engines without a native follow (Navara, the
// fake engine) run it on their frames; Cesium follows with trackedEntity.
// A command that takes the camera (setView, flyTo…) ends the follow.

import * as geo from '../geo/index.js';
import { createEngineEvent } from './contract.js';

const { cartesian3, math, matrix4 } = geo;
const WGS84 = geo.ellipsoid.WGS84;

export const MIN_FOLLOW_RANGE_M = 150;

const isCartesian = (value) =>
  value != null &&
  Number.isFinite(value.x) &&
  Number.isFinite(value.y) &&
  Number.isFinite(value.z);

/** follow() options checked: position and viewFrom as functions. */
export function normalizeFollowOptions(options) {
  if (!options || typeof options.position !== 'function')
    throw new TypeError('camera.follow needs position: () => Cartesian3');
  const { viewFrom } = options;
  const viewFromOf =
    typeof viewFrom === 'function'
      ? viewFrom
      : isCartesian(viewFrom)
        ? () => viewFrom
        : null;
  if (!viewFromOf)
    throw new TypeError('camera.follow needs viewFrom (ENU metres)');
  const minRange = options.minRange ?? MIN_FOLLOW_RANGE_M;
  if (!(Number.isFinite(minRange) && minRange >= 0))
    throw new TypeError(`camera.follow minRange must be >= 0: ${minRange}`);
  if (options.frame !== undefined && options.frame !== 'enu')
    throw new TypeError("camera.follow frame must be 'enu'");
  if (
    options.swingTo != null &&
    (!isCartesian(options.swingTo) ||
      cartesian3.magnitude(options.swingTo) === 0)
  )
    throw new TypeError('camera.follow swingTo must be a nonzero ENU offset');
  const { label } = options;
  if (
    label !== undefined &&
    !(
      label &&
      typeof label.id === 'string' &&
      typeof label.position === 'function'
    )
  )
    throw new TypeError(
      'camera.follow label needs { id, model, position: () => Cartesian3 }',
    );
  return {
    position: options.position,
    viewFrom: viewFromOf,
    minRange,
    swingTo: options.swingTo ? cartesian3.clone(options.swingTo) : null,
    native: options.native,
    label,
  };
}

const scratchFrame = matrix4.create();
const scratchInverse = matrix4.create();
const scratchOffset = cartesian3.create();
const scratchWorld = cartesian3.create();
const scratchUp = cartesian3.create();
const scratchBefore = cartesian3.create();

/**
 * One follow step: the camera pose that keeps `target` centred at `offset`
 * (ENU of the target, metres, kept outside `minRange`).
 * @returns {{ position, direction, up }}
 */
export function followPose(target, offset, minRange) {
  const range = cartesian3.magnitude(offset);
  const local =
    range >= minRange || range === 0
      ? cartesian3.clone(offset, scratchOffset)
      : cartesian3.multiplyByScalar(offset, minRange / range, scratchOffset);
  const frame = geo.transforms.eastNorthUpToFixedFrame(
    target,
    WGS84,
    scratchFrame,
  );
  const position = matrix4.multiplyByPoint(frame, local, cartesian3.create());
  const direction = cartesian3.normalize(
    cartesian3.subtract(target, position, cartesian3.create()),
    cartesian3.create(),
  );
  // The target's local up, made perpendicular to the view direction.
  cartesian3.fromElements(frame[8], frame[9], frame[10], scratchUp);
  let right = cartesian3.cross(direction, scratchUp, cartesian3.create());
  if (cartesian3.magnitude(right) < 1e-9)
    right = cartesian3.fromElements(frame[0], frame[1], frame[2]);
  cartesian3.normalize(right, right);
  const up = cartesian3.normalize(
    cartesian3.cross(right, direction, cartesian3.create()),
    cartesian3.create(),
  );
  return { position, direction, up };
}

/**
 * Keep a camera (in a target-centred frame: the target at the origin) on the
 * same side of its target and outside the minimum range. Cesium's tracked
 * camera (cesium/follow.js) runs it after a programmatic zoom.
 *
 * @param {{position: Cartesian3, direction: Cartesian3}} camera Camera-like
 *   object, corrected in place.
 * @param {Cartesian3} previousPosition The previous frame's camera position.
 * @param {number} [minimumRangeM=MIN_FOLLOW_RANGE_M] Minimum target range.
 * @returns {boolean} Whether the camera position was corrected.
 */
export function clampTrackedCameraPosition(
  camera,
  previousPosition,
  minimumRangeM = MIN_FOLLOW_RANGE_M,
) {
  const crossedOrigin = cartesian3.dot(camera.position, previousPosition) <= 0;
  const forwardDistance = -cartesian3.dot(camera.position, camera.direction);
  const rangeSquared = cartesian3.magnitudeSquared(camera.position);
  if (crossedOrigin) {
    cartesian3.normalize(previousPosition, camera.position);
    cartesian3.multiplyByScalar(
      camera.position,
      minimumRangeM,
      camera.position,
    );
    return true;
  }
  if (
    forwardDistance < minimumRangeM ||
    rangeSquared < minimumRangeM * minimumRangeM
  ) {
    cartesian3.multiplyByScalar(
      camera.direction,
      -minimumRangeM,
      camera.position,
    );
    return true;
  }
  return false;
}

/** The camera's offset from `target` in the target's ENU frame. */
export function enuOffset(
  target,
  cameraPosition,
  result = cartesian3.create(),
) {
  const frame = geo.transforms.eastNorthUpToFixedFrame(
    target,
    WGS84,
    scratchFrame,
  );
  const inverse = matrix4.inverseTransformation(frame, scratchInverse);
  return matrix4.multiplyByPoint(
    inverse,
    cartesian3.clone(cameraPosition, scratchWorld),
    result,
  );
}

// Elevation of the camera above the target's horizon: kept between these
// (radians), as Cesium's tracked camera stays above the ground plane.
const MIN_ELEVATION = math.toRadians(2);
const MAX_ELEVATION = math.toRadians(89);

/** The ENU offset turned by `dHeading` and raised by `dPitch` (radians), same range. */
export function orbitOffset(
  offset,
  dHeading,
  dPitch,
  result = cartesian3.create(),
) {
  const range = cartesian3.magnitude(offset);
  if (!(range > 0)) return cartesian3.clone(offset, result);
  const heading = Math.atan2(offset.x, offset.y) + dHeading;
  const elevation = math.clamp(
    Math.asin(math.clamp(offset.z / range, -1, 1)) + dPitch,
    MIN_ELEVATION,
    MAX_ELEVATION,
  );
  const horizontal = range * Math.cos(elevation);
  return cartesian3.fromElements(
    horizontal * Math.sin(heading),
    horizontal * Math.cos(heading),
    range * Math.sin(elevation),
    result,
  );
}

/** The ENU offset scaled by `factor`, never inside `minRange`. */
function zoomOffset(offset, factor, minRange, result = cartesian3.create()) {
  const range = cartesian3.magnitude(offset);
  if (!(range > 0) || !(factor > 0)) return cartesian3.clone(offset, result);
  const next = Math.max(minRange, range * factor);
  return cartesian3.multiplyByScalar(offset, next / range, result);
}

/**
 * The ENU offset dollied as Cesium's zoom3D: `ratio` is the drag over the
 * canvas height (down closes in), at most a tenth per move; the camera moves
 * five times that share of its distance above the floor (closing) or of its
 * range (opening), never inside `minRange`.
 */
export function dollyOffset(
  offset,
  ratio,
  minRange,
  result = cartesian3.create(),
) {
  const range = cartesian3.magnitude(offset);
  if (!(range > 0) || !Number.isFinite(ratio))
    return cartesian3.clone(offset, result);
  const window = Math.min(ratio, 0.1);
  const closing = window > 0;
  const distance = 5 * (range - (closing ? minRange : 0)) * window;
  const next = Math.max(minRange, range - distance);
  return cartesian3.multiplyByScalar(offset, next / range, result);
}

const STILL_M = 1e-6;

/**
 * @param {{
 *   camera: { pose: () => object, commanded: object },
 *   aim: (pose: { position, direction, up }) => void,
 *   frame: { addEventListener: Function },
 *   requestRender: () => void,
 *   gestures?: (handlers: { orbit: (dHeading: number, dPitch: number) => void,
 *     zoom: (factor: number) => void }) => () => void,
 * }} ports `aim` places the camera without camera.commanded; `frame` is
 *   the event the follow steps on (the engine's preRender, after it read
 *   the user's camera). `gestures` (Navara): while following, the engine's
 *   own drag and wheel handling is suspended and its drag and wheel turn
 *   and scale the offset instead (as Cesium's EntityView orbits the
 *   target); it returns the release. Without it the offset is re-read from
 *   the camera each frame (the fake engine).
 */
export function createFollowController({
  camera,
  aim,
  frame,
  requestRender,
  gestures = null,
}) {
  const followChanged = createEngineEvent();
  let current = null;
  let removeFrame = null;
  let removeCommanded = null;
  let releaseGestures = null;
  let aiming = false;

  const end = (handle) => {
    if (current !== handle) return;
    current = null;
    removeFrame?.();
    removeCommanded?.();
    releaseGestures?.();
    removeFrame = null;
    removeCommanded = null;
    releaseGestures = null;
    followChanged.raiseEvent(null);
  };
  // Drag and wheel (gestures port): applied at the next step.
  const gestureHandlers = {
    orbit(dHeading, dPitch) {
      const handle = current;
      if (!handle?.offset) return;
      orbitOffset(handle.offset, dHeading, dPitch, handle.offset);
      handle.moved = true;
      requestRender();
    },
    dolly(ratio) {
      const handle = current;
      if (!handle?.offset) return;
      dollyOffset(handle.offset, ratio, handle.options.minRange, handle.offset);
      handle.moved = true;
      requestRender();
    },
    zoom(factor) {
      const handle = current;
      if (!handle?.offset) return;
      zoomOffset(handle.offset, factor, handle.options.minRange, handle.offset);
      handle.moved = true;
      requestRender();
    },
  };

  const step = () => {
    const handle = current;
    if (!handle) return;
    let target;
    try {
      target = handle.options.position();
    } catch {
      target = null;
    }
    if (!isCartesian(target)) return;
    let changed = handle.moved || !handle.previous;
    handle.moved = false;
    if (!handle.offset) {
      const from = handle.options.viewFrom();
      if (!isCartesian(from)) return;
      handle.offset = cartesian3.clone(from);
      changed = true;
    } else if (handle.previous && !gestures) {
      // The user may have turned or zoomed the camera since the last step.
      const before = cartesian3.clone(handle.offset, scratchBefore);
      enuOffset(handle.previous, camera.pose().position, handle.offset);
      if (cartesian3.distance(before, handle.offset) > STILL_M) changed = true;
    }
    if (
      handle.previous &&
      cartesian3.distance(handle.previous, target) > STILL_M
    )
      changed = true;
    if (handle.swingTo && handle.previous) {
      const angle = cartesian3.angleBetween(handle.offset, handle.swingTo);
      handle.offset =
        angle > MAX_FOLLOW_TURN
          ? turnFollowOffset(handle.offset, handle.swingTo)
          : cartesian3.clone(handle.swingTo);
      if (!(angle > MAX_FOLLOW_TURN)) handle.swingTo = null;
      changed = true;
    }
    if (handle.swingTo) changed = true;
    const pose = followPose(target, handle.offset, handle.options.minRange);
    handle.previous = cartesian3.clone(target, handle.previous ?? undefined);
    // The offset in force (the minimum range applied).
    enuOffset(target, pose.position, handle.offset);
    aiming = true;
    try {
      aim(pose);
    } finally {
      aiming = false;
    }
    // A moving target (or a gesture) needs the next frame; a still one
    // lets the engine idle.
    if (changed) requestRender();
  };

  return {
    followChanged,
    following: () => current,
    follow(input) {
      const options = normalizeFollowOptions(input);
      if (current) end(current);
      const handle = {
        options,
        native: options.native,
        label: options.label,
        swingTo: options.swingTo,
        offset: null,
        previous: null,
        target() {
          try {
            return handle.options.position();
          } catch {
            return undefined;
          }
        },
        stop: () => end(handle),
        retarget(next) {
          if (current !== handle) return;
          const updated = normalizeFollowOptions({
            ...handle.options,
            ...next,
          });
          handle.swingTo = updated.swingTo;
          if (Object.keys(next).every((key) => key === 'swingTo')) {
            handle.options = updated;
            requestRender();
            return;
          }
          handle.options = updated;
          handle.native = updated.native;
          handle.label = updated.label;
          handle.offset = null;
          handle.previous = null;
          followChanged.raiseEvent(handle);
          requestRender();
        },
      };
      current = handle;
      removeFrame = frame.addEventListener(step);
      if (gestures && !releaseGestures)
        releaseGestures = gestures(gestureHandlers);
      removeCommanded = camera.commanded.addEventListener(() => {
        if (!aiming) end(handle);
      });
      followChanged.raiseEvent(handle);
      requestRender();
      return handle;
    },
    destroy() {
      if (current) end(current);
    },
  };
}

export const MAX_FOLLOW_TURN = Math.PI / 3;

/**
 * `from` turned `step` radians toward `to`, with its length moved the same
 * fraction of the way: one frame of the swing round the entity.
 */
export function turnFollowOffset(from, to, step = MAX_FOLLOW_TURN) {
  const angle = cartesian3.angleBetween(from, to);
  const unitFrom = cartesian3.normalize(from, cartesian3.create());
  // The direction perpendicular to `from` in the plane toward `to` (or any
  // perpendicular when they are opposite).
  let toward = cartesian3.subtract(
    cartesian3.normalize(to, cartesian3.create()),
    cartesian3.multiplyByScalar(unitFrom, Math.cos(angle), cartesian3.create()),
    cartesian3.create(),
  );
  if (cartesian3.magnitude(toward) < 1e-9)
    toward = cartesian3.cross(
      unitFrom,
      Math.abs(unitFrom.z) < 0.9 ? cartesian3.UNIT_Z : cartesian3.UNIT_X,
      cartesian3.create(),
    );
  cartesian3.normalize(toward, toward);
  const length =
    cartesian3.magnitude(from) +
    (cartesian3.magnitude(to) - cartesian3.magnitude(from)) * (step / angle);
  const direction = cartesian3.add(
    cartesian3.multiplyByScalar(unitFrom, Math.cos(step), cartesian3.create()),
    cartesian3.multiplyByScalar(toward, Math.sin(step), cartesian3.create()),
    cartesian3.create(),
  );
  return cartesian3.multiplyByScalar(direction, length, direction);
}
