// The GlobeCamera of the Navara engine. The engine keeps the camera pose
// itself, in src/geo values, and Navara's camera follows it:
//
// - programmatic moves (setView, lookAt, zoom, a landed flight) change the
//   pose at once, as Cesium does, and push it to Navara's setCamera in
//   degrees; Navara draws it from its next update. Navara clamps pitch to
//   ±89.99°, so its redraw of a pushed pose is not read back;
// - whatever Navara moves by itself (user input, its own flyTo arc) is read
//   back from the drawn camera every frame (sync) and becomes the pose;
// - camera events come from frame-to-frame changes of the pose: moveStart on
//   the first moving frame, moveEnd once it has been still for 500 ms of
//   wall time (Cesium's cameraEventWaitTime), changed past percentageChanged.
//
// The port is the engine's thin layer over the Navara view (apply, read, fly,
// stop, size, requestFrame, suspendCameraInputs); see createNavaraEngine.js.
// A flight suspends the camera inputs until it ends, as Cesium's
// CameraFlightPath turns them off: a gesture cannot cut it short.

import * as geo from '../../geo/index.js';
import { createEngineEvent } from '../contract.js';
import {
  headingPitchRoll,
  horizonVisible,
  lookAtFrame,
  navaraPose,
  orientationVectors,
  pickEllipsoid,
  pickRay,
  projectToWindow,
  rectangleViewPosition,
  sphereRange,
  viewProjection,
  viewRectangle,
} from '../cameraMath.js';

const { cartesian3, cartographic, math, matrix4 } = geo;
const WGS84 = geo.ellipsoid.WGS84;
const CESIUM_DEFAULTS = Object.freeze({
  heading: 0,
  pitch: -math.PI_OVER_TWO,
  roll: 0,
});
const DEFAULT_ZOOM_AMOUNT = 100000; // Cesium's camera.defaultZoomAmount
const MOVE_END_WAIT_MS = 500; // Cesium's scene.cameraEventWaitTime
const DEFAULT_PERCENTAGE_CHANGED = 0.5; // Cesium's camera.percentageChanged
// How far Navara's drawing of a pushed pose may be from it and still count as
// that pose: its ±89.99° pitch clamp is 1.7e-4 rad; positions land exactly.
const PUSHED_ANGLE_TOLERANCE = 1e-3;
const PUSHED_POSITION_TOLERANCE = 0.05;
// Navara 0.2.1 flyTo presets for the contract easings. Navara has no sine
// preset; quadInOut is the closest curve.
const NAVARA_EASINGS = Object.freeze({
  linear: 'linear',
  cubicInOut: 'cubicInOut',
  sinusoidalInOut: 'quadInOut',
});

const copy3 = (value) => cartesian3.create(value.x, value.y, value.z);
const copyPose = (pose) => ({
  position: copy3(pose.position),
  direction: copy3(pose.direction),
  up: copy3(pose.up),
});
const angleBetween = (a, b) =>
  Math.acos(math.clamp(cartesian3.dot(a, b), -1, 1));
// Unit vectors are compared by chord length (≈ the angle when small), which,
// unlike acos of the dot product, does not turn last-bit noise into 1e-7 rad.
function posesNear(a, b, distance, angle) {
  return (
    cartesian3.distance(a.position, b.position) <= distance &&
    cartesian3.distance(a.direction, b.direction) <= angle &&
    cartesian3.distance(a.up, b.up) <= angle
  );
}

/**
 * @param {{
 *   port: {
 *     apply: (pose: object) => void,
 *     read: () => ({ position: object, direction: object, up: object } | null | undefined),
 *     fly: (pose: object, options: { duration?: number, easing?: string }) => Promise<boolean>,
 *     stop: () => void,
 *     size: () => { width: number, height: number },
 *     requestFrame: () => void,
 *     setFovy?: (radians: number) => void,
 *     suspendCameraInputs?: () => () => void,
 *   },
 *   clock?: { now: () => number, setTimeout: Function, clearTimeout: Function },
 * }} options
 */
export function createCameraModel({
  port,
  clock = {
    now: () => performance.now(),
    setTimeout: (fn, ms) => setTimeout(fn, ms),
    clearTimeout: (timer) => clearTimeout(timer),
  },
}) {
  const events = {
    changed: createEngineEvent(),
    moveStart: createEngineEvent(),
    moveEnd: createEngineEvent(),
    commanded: createEngineEvent(),
  };
  // A camera command takes the camera from whoever held it; say so first.
  const announce = () => events.commanded.raiseEvent();
  // Navara's camera sits at the Earth's centre until it is first placed: no
  // pose yet (Cesium's camera always has one).
  const read = () => {
    const pose = port.read();
    return pose && cartesian3.magnitude(pose.position) > 1 ? pose : null;
  };
  const initial = read();
  let state = initial
    ? copyPose(initial)
    : (() => {
        const position = cartesian3.fromDegrees(0, 0, 1e7);
        return {
          position,
          ...orientationVectors(position, 0, -math.PI_OVER_TWO, 0),
        };
      })();
  let fov = Math.PI / 3;
  const fovy = () => {
    const { width, height } = port.size();
    return width > height
      ? 2 * Math.atan((Math.tan(fov / 2) * height) / width)
      : fov;
  };
  let transform = [...matrix4.IDENTITY];
  let percentageChanged = DEFAULT_PERCENTAGE_CHANGED;
  let flight = null;
  let pushed = null;
  let lastSeen = initial ? copyPose(initial) : null;
  let lastFramePose = copyPose(state);
  let lastChangedPose = copyPose(state);
  let changedAngles = headingPitchRoll(
    state.position,
    state.direction,
    state.up,
  );
  let moving = false;
  let lastMoveAt = 0;
  let moveEndTimer = null;
  let destroyed = false;

  const view = () => {
    const { width, height } = port.size();
    return { ...state, fovy: fovy(), width, height };
  };

  // A programmatic pose: exact here, pushed to Navara for drawing.
  function place(pose) {
    state = copyPose(pose);
    pushed = copyPose(pose);
    port.apply(navaraPose(state.position, state.direction, state.up));
    port.requestFrame();
  }

  function viewFor(destination, orientation) {
    const { width, height } = port.size();
    const position =
      'west' in destination
        ? rectangleViewPosition(destination, fovy(), width / height)
        : copy3(destination);
    if (orientation && 'direction' in orientation)
      return {
        position,
        direction: cartesian3.normalize(
          orientation.direction,
          cartesian3.create(),
        ),
        up: cartesian3.normalize(orientation.up, cartesian3.create()),
      };
    return {
      position,
      ...orientationVectors(
        position,
        orientation?.heading ?? CESIUM_DEFAULTS.heading,
        orientation?.pitch ?? CESIUM_DEFAULTS.pitch,
        orientation?.roll ?? CESIUM_DEFAULTS.roll,
      ),
    };
  }

  function endFlight(current, outcome) {
    if (flight !== current) return;
    flight = null;
    current.resume?.();
    if (outcome === 'cancel') current.options.cancel?.();
  }

  function cancelCurrentFlight() {
    const current = flight;
    if (!current) return;
    endFlight(current, 'cancel');
    port.stop();
  }

  function land(options, target) {
    if (options.endTransform) transform = [...options.endTransform];
    place(target);
  }

  function startFlight(options, target) {
    cancelCurrentFlight();
    if (options.duration !== undefined && options.duration <= 0) {
      land(options, target);
      options.complete?.();
      return;
    }
    const pose = navaraPose(target.position, target.direction, target.up);
    const flyOptions = {};
    if (options.duration !== undefined)
      flyOptions.duration = options.duration * 1000;
    if (options.easing !== undefined)
      flyOptions.easing = NAVARA_EASINGS[options.easing];
    const current = { options, target, resume: port.suspendCameraInputs?.() };
    flight = current;
    let pending;
    try {
      pending = port.fly(pose, flyOptions);
    } catch (error) {
      // As in Cesium, a flight that cannot start reports only the exception.
      endFlight(current, 'fail');
      throw error;
    }
    // Navara moves the camera from here on; read it back every frame.
    pushed = null;
    pending.then(
      (arrived) => {
        if (flight !== current || destroyed) return;
        if (!arrived) return endFlight(current, 'cancel');
        endFlight(current, 'complete');
        land(options, target);
        options.complete?.();
      },
      () => endFlight(current, 'cancel'),
    );
  }

  /** Reads Navara's drawn camera; called once per frame before preRender. */
  function sync() {
    const seen = read();
    if (!seen) return;
    const moved = !lastSeen || !posesNear(seen, lastSeen, 1e-6, 1e-10);
    lastSeen = copyPose(seen);
    if (!moved) return;
    if (
      pushed &&
      posesNear(seen, pushed, PUSHED_POSITION_TOLERANCE, PUSHED_ANGLE_TOLERANCE)
    )
      return;
    pushed = null;
    state = copyPose(seen);
  }

  function finishMove() {
    moveEndTimer = null;
    const still = clock.now() - lastMoveAt;
    if (still < MOVE_END_WAIT_MS) {
      moveEndTimer = clock.setTimeout(finishMove, MOVE_END_WAIT_MS - still);
      return;
    }
    moving = false;
    events.moveEnd.raiseEvent();
  }

  /** Raises camera events for this frame's pose; called after rendering. */
  function afterFrame() {
    const pose = copyPose(state);
    if (!posesNear(pose, lastFramePose, 1e-6, 1e-10)) {
      lastMoveAt = clock.now();
      if (!moving) {
        moving = true;
        events.moveStart.raiseEvent();
      }
      if (moveEndTimer) clock.clearTimeout(moveEndTimer);
      moveEndTimer = clock.setTimeout(finishMove, MOVE_END_WAIT_MS);
    }
    lastFramePose = pose;
    const turn =
      angleBetween(pose.direction, lastChangedPose.direction) /
      (view().fovy / 2);
    const altitude = Math.max(
      1,
      cartographic.fromCartesian(pose.position, WGS84).height,
    );
    const shift =
      cartesian3.distance(pose.position, lastChangedPose.position) / altitude;
    const angles = headingPitchRoll(pose.position, pose.direction, pose.up);
    const delta = (a, b) => {
      const angle = Math.abs(a - b) % (2 * Math.PI);
      return Math.min(angle, 2 * Math.PI - angle) / Math.PI;
    };
    // Heading and roll are raised on their own, as Camera._updateCameraChanged
    // does: a turn about the line of sight (heading at nadir, roll) moves
    // neither the direction nor the position.
    for (const angle of ['heading', 'roll']) {
      const amount = delta(angles[angle], changedAngles[angle]);
      if (amount <= percentageChanged) continue;
      changedAngles[angle] = angles[angle];
      events.changed.raiseEvent(amount);
    }
    const amount = Math.max(turn, shift);
    if (amount > percentageChanged) {
      lastChangedPose = pose;
      events.changed.raiseEvent(amount);
    }
  }

  // camera.livePosition: one owned object, refreshed on read (place() and
  // sync() replace `state`, so it is copied rather than aliased).
  const livePosition = cartesian3.create();

  const camera = {
    setFovy(radians) {
      if (!Number.isFinite(radians) || radians <= 0 || radians >= Math.PI)
        throw new RangeError('Field of view must be between 0 and PI');
      const { width, height } = port.size();
      fov =
        width > height
          ? 2 * Math.atan((Math.tan(radians / 2) * width) / height)
          : radians;
      port.setFovy?.(radians);
      port.requestFrame();
    },
    get livePosition() {
      return cartesian3.clone(state.position, livePosition);
    },
    height: () => cartographic.fromCartesian(state.position, WGS84).height,
    pose() {
      const current = view();
      const angles = headingPitchRoll(
        current.position,
        current.direction,
        current.up,
      );
      return {
        position: copy3(current.position),
        cartographic: cartographic.fromCartesian(current.position, WGS84),
        heading: angles.heading,
        pitch: angles.pitch,
        roll: angles.roll,
        direction: copy3(current.direction),
        up: copy3(current.up),
        right: cartesian3.normalize(
          cartesian3.cross(current.direction, current.up, cartesian3.create()),
          cartesian3.create(),
        ),
        fovy: current.fovy,
        aspectRatio: current.width / current.height,
      };
    },
    setView(options) {
      if (!options?.destination)
        throw new TypeError('setView needs a destination');
      announce();
      cancelCurrentFlight();
      place(viewFor(options.destination, options.orientation));
    },
    flyTo(options) {
      if (!options?.destination)
        throw new TypeError('flyTo needs a destination');
      announce();
      startFlight(options, viewFor(options.destination, options.orientation));
    },
    flyToSphere(sphere, options = {}) {
      announce();
      transform = [...matrix4.IDENTITY];
      const { width, height } = port.size();
      const range =
        options.range || sphereRange(sphere.radius, fovy(), width / height);
      const frame = geo.transforms.eastNorthUpToFixedFrame(
        sphere.center,
        WGS84,
      );
      startFlight(
        options,
        lookAtFrame(frame, {
          heading: options.heading ?? 0,
          pitch: options.pitch ?? -Math.PI / 4,
          range,
        }),
      );
    },
    flightActive: () => flight != null,
    lookAt(target, offset) {
      announce();
      camera.lookAtTransform(
        geo.transforms.eastNorthUpToFixedFrame(target, WGS84),
        offset,
      );
    },
    lookAtTransform(frame, offset) {
      transform = [...frame];
      if (offset) place(lookAtFrame(frame, offset));
    },
    transform: () => [...transform],
    release() {
      transform = [...matrix4.IDENTITY];
    },
    cancelFlight() {
      announce();
      cancelCurrentFlight();
    },
    completeFlight() {
      const current = flight;
      if (!current) return;
      endFlight(current, 'complete');
      // Cesium lands it through setView, a command.
      announce();
      port.stop();
      land(current.options, current.target);
      current.options.complete?.();
    },
    zoomIn(amount = DEFAULT_ZOOM_AMOUNT) {
      place({
        ...state,
        position: cartesian3.add(
          state.position,
          cartesian3.multiplyByScalar(
            state.direction,
            amount,
            cartesian3.create(),
          ),
          cartesian3.create(),
        ),
      });
    },
    zoomOut(amount = DEFAULT_ZOOM_AMOUNT) {
      camera.zoomIn(-amount);
    },
    viewRectangle: () => viewRectangle(view()),
    pickEllipsoid: (screen) => pickEllipsoid(view(), screen),
    pickRay: (screen) => pickRay(view(), screen),
    changed: events.changed,
    moveStart: events.moveStart,
    moveEnd: events.moveEnd,
    commanded: events.commanded,
    get percentageChanged() {
      return percentageChanged;
    },
    set percentageChanged(value) {
      percentageChanged = value;
    },
  };

  return {
    camera,
    sync,
    afterFrame,
    /**
     * Whether nothing else drives the camera: no flight and no lookAt target
     * (identity transform). The engine's ground floor acts only then.
     */
    isFree: () =>
      flight == null &&
      transform.every((value, index) => value === matrix4.IDENTITY[index]),
    /**
     * Moves the camera to `position`, keeping its direction and up, without
     * camera.commanded: a correction (the ground floor), not a new owner.
     */
    lift(position) {
      place({ ...state, position: copy3(position) });
    },
    /**
     * Places the camera at `pose` ({ position, direction, up }) without
     * camera.commanded: the follow camera's own step, not a new owner.
     */
    aim(pose) {
      place(pose);
    },
    /** The current camera for projections: pose, vertical fov and CSS size. */
    view,
    worldToWindow: (position, result) =>
      projectToWindow(view(), position, result),
    viewProjection: (result) => viewProjection(view(), result),
    horizonVisible: (position, options) =>
      horizonVisible(state.position, position, options),
    destroy() {
      if (destroyed) return;
      cancelCurrentFlight();
      destroyed = true;
      if (moveEndTimer) clock.clearTimeout(moveEndTimer);
      moveEndTimer = null;
    },
  };
}
