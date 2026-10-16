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

const { cartesian3, matrix4 } = geo;
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
  return {
    position: options.position,
    viewFrom: viewFromOf,
    minRange,
    native: options.native,
  };
}

const scratchFrame = matrix4.create();
const scratchInverse = matrix4.create();
const scratchOffset = cartesian3.create();
const scratchWorld = cartesian3.create();
const scratchUp = cartesian3.create();

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

/**
 * @param {{
 *   camera: { pose: () => object, commanded: object },
 *   aim: (pose: { position, direction, up }) => void,
 *   frame: { addEventListener: Function },
 *   requestRender: () => void,
 * }} ports `aim` places the camera without camera.commanded; `frame` is
 *   the event the follow steps on (the engine's preRender, after it read
 *   the user's camera).
 */
export function createFollowController({ camera, aim, frame, requestRender }) {
  const followChanged = createEngineEvent();
  let current = null;
  let removeFrame = null;
  let removeCommanded = null;
  let aiming = false;

  const end = (handle) => {
    if (current !== handle) return;
    current = null;
    removeFrame?.();
    removeCommanded?.();
    removeFrame = null;
    removeCommanded = null;
    followChanged.raiseEvent(null);
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
    if (!handle.offset) {
      const from = handle.options.viewFrom();
      if (!isCartesian(from)) return;
      handle.offset = cartesian3.clone(from);
    } else if (handle.previous) {
      // The user may have turned or zoomed the camera since the last step.
      enuOffset(handle.previous, camera.pose().position, handle.offset);
    }
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
    // A moving target needs the next frame.
    requestRender();
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
        offset: null,
        previous: null,
        stop: () => end(handle),
        retarget(next) {
          const updated = normalizeFollowOptions({ ...options, ...next });
          handle.options = updated;
          handle.native = updated.native;
          handle.offset = null;
          handle.previous = null;
          requestRender();
        },
      };
      current = handle;
      removeFrame = frame.addEventListener(step);
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
