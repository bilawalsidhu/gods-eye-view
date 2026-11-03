import * as Cesium from 'cesium';
import { governorRequestRender } from '../renderGovernor.js';

/** Whole-Earth input limit; explicit camera destinations can go farther. */
export const MAXIMUM_ZOOM_DISTANCE_M = 40_000_000;
/** Below this, oblique browsing is left alone. */
export const PITCH_CLAMP_MIN_HEIGHT_M = 300_000;
/** Look this far below the Earth's limb, so the globe stays on screen. */
export const LIMB_MARGIN_RAD = Cesium.Math.toRadians(8);
const PITCH_EASE = 0.35;
const PITCH_SNAP_RAD = Cesium.Math.toRadians(0.1);
const HEIGHT_EPSILON_M = 0.0001;
const EARTH_RADIUS_M = 6_371_000;
const INPUT_BINDINGS = Object.values(Cesium.CameraEventType).flatMap((type) =>
  [undefined, ...Object.values(Cesium.KeyboardEventModifier)].map(
    (modifier) => ({
      type,
      modifier,
    }),
  ),
);

/**
 * The shallowest pitch (radians, negative is down) that still keeps the Earth
 * framed from height `h`, or null where tilted views are left alone.
 * The limb sits acos(R / (R + h)) below the local horizontal.
 */
export function maxPitchForHeight(h) {
  if (!(h >= PITCH_CLAMP_MIN_HEIGHT_M)) return null;
  const limb = Math.acos(EARTH_RADIUS_M / (EARTH_RADIUS_M + h));
  return -Math.min(limb + LIMB_MARGIN_RAD, Cesium.Math.PI_OVER_TWO);
}

function matchesZoomBinding(bindings, type, modifier) {
  if (Array.isArray(bindings))
    return bindings.some((binding) =>
      matchesZoomBinding(binding, type, modifier),
    );
  return typeof bindings === 'number'
    ? bindings === type && modifier === undefined
    : bindings?.eventType === type && bindings?.modifier === modifier;
}

function readInput(aggregator, bindings) {
  let outward = false;
  let cancel = false;
  for (const { type, modifier } of INPUT_BINDINGS) {
    if (!aggregator.isMoving(type, modifier)) continue;
    const movement = aggregator.getMovement(type, modifier);
    const pinch = type === Cesium.CameraEventType.PINCH;
    const distance = pinch ? movement.distance : movement;
    const delta = distance.endPosition.y - distance.startPosition.y;
    // Cesium tilts by the fingers' midpoint while zooming by their spacing,
    // both in the same quarter-pixel units. Fingers rarely keep a perfectly
    // even spacing, so the larger of the two movements decides the gesture.
    const tilt = pinch
      ? movement.angleAndHeight.endPosition.y -
        movement.angleAndHeight.startPosition.y
      : 0;
    if (
      matchesZoomBinding(bindings, type, modifier) &&
      Math.abs(delta) > Math.abs(tilt)
    ) {
      outward ||= delta < 0;
      cancel ||= delta > 0;
    } else {
      // Includes modifier-specific tilts and parallel two-finger movement.
      cancel = true;
    }
  }
  aggregator.reset();
  return { outward, cancel };
}

/**
 * Keep outward user zooms bounded and framed, without taking camera ownership
 * from tilts, tracked entities or flights. Returns an idempotent disposer.
 */
export function installZoomOutGuard(
  viewer,
  {
    requestRender = governorRequestRender,
    subscribeCameraHandoff,
    createAggregator = (canvas) => new Cesium.CameraEventAggregator(canvas),
  } = {},
) {
  const scene = viewer?.scene;
  const controller = scene?.screenSpaceCameraController;
  const camera = viewer?.camera;
  const canvas = viewer?.canvas;
  if (
    !controller ||
    !camera ||
    !canvas ||
    !scene.preRender ||
    !scene.postUpdate
  )
    throw new TypeError('A complete Cesium viewer is required');

  const aggregator = createAggregator(canvas);
  const originalMaximumZoomDistance = controller.maximumZoomDistance;
  const ownsCeiling = originalMaximumZoomDistance > MAXIMUM_ZOOM_DISTANCE_M;
  let maximumZoomDistance = Math.min(
    originalMaximumZoomDistance,
    MAXIMUM_ZOOM_DISTANCE_M,
  );
  controller.maximumZoomDistance = maximumZoomDistance;
  // Cesium clamps any zoom that starts above the limit to the limit, in either
  // direction. A camera placed higher by a flight or share link keeps its own
  // height as the limit, so it zooms in gradually and can't climb further.
  const followCeiling = () => {
    if (!ownsCeiling || controller.maximumZoomDistance !== maximumZoomDistance)
      return;
    // While tracking, Cesium measures zoom from the target, not the Earth, so
    // the camera's altitude would lift the ceiling with every outward step.
    const untracked =
      scene.mode === Cesium.SceneMode.SCENE3D &&
      Cesium.Matrix4.equals(camera.transform, Cesium.Matrix4.IDENTITY);
    const height = untracked ? camera.positionCartographic?.height : undefined;
    maximumZoomDistance =
      height > MAXIMUM_ZOOM_DISTANCE_M ? height : MAXIMUM_ZOOM_DISTANCE_M;
    controller.maximumZoomDistance = maximumZoomDistance;
  };
  followCeiling();

  let lastHeight = camera.positionCartographic?.height;
  let lastPosition = Cesium.Cartesian3.clone(camera.position);
  let lastHeading = camera.heading;
  let lastPitch = camera.pitch;
  let lastRoll = camera.roll;
  let zoomingOut = false;
  let settling = false;
  const cancel = () => {
    zoomingOut = false;
    settling = false;
  };
  const guard = () => {
    const input = readInput(aggregator, controller.zoomEventTypes);
    const height = camera.positionCartographic?.height;
    const climbing = height > lastHeight + HEIGHT_EPSILON_M;
    const descending = height < lastHeight - HEIGHT_EPSILON_M;
    try {
      if (
        scene.mode !== Cesium.SceneMode.SCENE3D ||
        controller.enableInputs === false ||
        controller.enableZoom === false ||
        !Cesium.Matrix4.equals(camera.transform, Cesium.Matrix4.IDENTITY) ||
        // Cesium has no public running-flight flag.
        camera._currentFlight ||
        input.cancel ||
        (descending && !settling)
      ) {
        cancel();
        return;
      }
      if (input.outward) {
        zoomingOut = true;
        // A genuine outward gesture can be blocked by the controller's ceiling.
        settling = true;
      }
      if (climbing) {
        if (!zoomingOut) return;
        settling = true;
      } else {
        zoomingOut = false;
        // Outward inertia can lower altitude when Cesium clamps slant range at
        // the ceiling. Finish that correction; fresh inward input cancels above.
        // A stationary correction owns only the pose it last produced.
        if (
          !input.outward &&
          ((!descending &&
            !Cesium.Cartesian3.equals(camera.position, lastPosition)) ||
            Math.abs(Cesium.Math.negativePiToPi(camera.heading - lastHeading)) >
              1e-10 ||
            Math.abs(camera.pitch - lastPitch) > 1e-10 ||
            Math.abs(Cesium.Math.negativePiToPi(camera.roll - lastRoll)) >
              1e-10)
        )
          settling = false;
        if (!settling) return;
      }
      const maxPitch = maxPitchForHeight(height);
      if (maxPitch === null || !(camera.pitch > maxPitch)) {
        settling = false;
      } else {
        const error = maxPitch - camera.pitch;
        const easedPitch =
          Math.abs(error) <= PITCH_SNAP_RAD
            ? maxPitch
            : camera.pitch + error * PITCH_EASE;
        // A large wheel step must not leave the view above the limb while easing.
        const limbPitch = -Math.acos(
          EARTH_RADIUS_M / (EARTH_RADIUS_M + height),
        );
        const pitch = Math.min(easedPitch, limbPitch);
        camera.setView({
          orientation: { heading: camera.heading, pitch, roll: camera.roll },
        });
        settling = pitch > maxPitch;
      }
      // Observe the end of inertia too; no arbitrary timeout cuts off a long zoom.
      if (zoomingOut || settling) requestRender('zoom-out-guard');
    } finally {
      lastHeight = camera.positionCartographic?.height;
      lastPosition = Cesium.Cartesian3.clone(camera.position, lastPosition);
      lastHeading = camera.heading;
      lastPitch = camera.pitch;
      lastRoll = camera.roll;
    }
  };
  const removePreRender = scene.preRender.addEventListener(guard);
  // Fires every frame, after Cesium has applied this frame's input, while
  // preRender fires only on frames that draw. Input that didn't move the camera
  // (such as wheel at the ceiling) would otherwise wait for an unrelated frame.
  const removePostUpdate = scene.postUpdate.addEventListener(() => {
    followCeiling();
    if (
      INPUT_BINDINGS.some(({ type, modifier }) =>
        aggregator.isMoving(type, modifier),
      )
    )
      requestRender('zoom-out-guard');
  });
  const removeCameraHandoff = subscribeCameraHandoff?.(() => {
    cancel();
    // Discard input queued before an explicit navigation action took ownership.
    aggregator.reset();
  });

  let active = true;
  return () => {
    if (!active) return;
    active = false;
    removeCameraHandoff?.();
    removePreRender?.();
    removePostUpdate?.();
    aggregator.destroy();
    if (controller.maximumZoomDistance === maximumZoomDistance)
      controller.maximumZoomDistance = originalMaximumZoomDistance;
  };
}
