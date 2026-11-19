/**
 * @module render/cesium/camera
 * @description The Cesium renderer's camera port over a Cesium camera:
 * poses, views, flights, `lookAt`, events and command hooks, each mapped
 * onto Cesium's own camera call, and the user's camera controls
 * (`cameraControls.js`) on the scene's camera controller.
 */
import * as Cesium from 'cesium';
import { createCameraEvents } from '../camera/events.js';
import {
  listenerList,
  pickEllipsoidAt,
  sameEye,
  toCartesian,
  uncaught,
} from './common.js';
import { computeViewRectangle } from '../stub/viewRectangle.js';
import { cameraFlightActive } from './internals.js';
import { createCesiumFollow } from './follow.js';
import { createCesiumControls } from './cameraControls.js';
import { cameraOf, findCamera, provideUnboundCamera } from '../rendererOf.js';
// Loads the factories an unbound viewer gets its credits, draw, frame,
// input and query ports from, and a click's own Cesium picks.
import './credits.js';
import './draw.js';
import './frame.js';
import './input.js';
import './nativeClick.js';
import './query.js';

/**
 * `cameraOf` and `findCamera`, for code that already reaches Cesium:
 * importing them from here loads the factory a viewer with no renderer
 * bound gets its camera from.
 */
export { cameraOf, findCamera };

/** The contract's easings as Cesium's. */
export const EASINGS = Object.freeze({
  linear: Cesium.EasingFunction.LINEAR_NONE,
  quadraticInOut: Cesium.EasingFunction.QUADRATIC_IN_OUT,
  cubicInOut: Cesium.EasingFunction.CUBIC_IN_OUT,
  cubicOut: Cesium.EasingFunction.CUBIC_OUT,
  quadraticOut: Cesium.EasingFunction.QUADRATIC_OUT,
  quinticInOut: Cesium.EasingFunction.QUINTIC_IN_OUT,
  sineInOut: Cesium.EasingFunction.SINUSOIDAL_IN_OUT,
});

/** A contract destination as Cesium's: a Cartesian3, or a Rectangle. */
export function toDestination(d) {
  if ('rect' in d) {
    const r = d.rect;
    return Cesium.Rectangle.fromDegrees(r.west, r.south, r.east, r.north);
  }
  return toCartesian(d);
}

/**
 * A contract orientation as Cesium's; omitted angles are heading 0, pitch
 * straight down and roll 0, as the contract says.
 */
export function toOrientation(o = {}) {
  if ('direction' in o)
    return { direction: toCartesian(o.direction), up: toCartesian(o.up) };
  return {
    heading: o.heading ?? 0,
    pitch: o.pitch ?? -Math.PI / 2,
    roll: o.roll ?? 0,
  };
}

/** The follow offset of a camera that cannot follow. */
const NO_FOLLOW_OFFSET = Object.freeze({ get: () => null, set() {} });

/** A Cesium matrix's 16 values, column by column, as `Matrix4.toArray` lists them. */
function matrixArray(matrix) {
  const out = new Float64Array(16);
  for (let i = 0; i < 16; i++) out[i] = matrix[i];
  return out;
}

/** Whether `array` holds a Cesium matrix's 16 values, each the same. */
function sameMatrix(array, matrix) {
  for (let i = 0; i < 16; i++)
    if (!Object.is(array[i], matrix[i])) return false;
  return true;
}

const finiteVector = (v) =>
  !!v && Number.isFinite(v.x) && Number.isFinite(v.y) && Number.isFinite(v.z);

/** Conservative globe/frustum visibility; null means unknown. */
export function createPointsVisibility(scene, camera) {
  const visibilitySphere = new Cesium.BoundingSphere();
  let visibilityMargin = null;
  let visibilityEllipsoid = null;
  let visibilityOccluder = null;
  return function visiblePoints(points, marginM) {
    const eye = camera.positionWC;
    const direction = camera.directionWC;
    const up = camera.upWC;
    if (
      scene.mode !== Cesium.SceneMode.SCENE3D ||
      !points?.length ||
      !finiteVector(eye) ||
      !finiteVector(direction) ||
      !finiteVector(up) ||
      !points.every(finiteVector)
    )
      return null;
    if (visibilityMargin !== marginM) {
      const radii = Cesium.Ellipsoid.WGS84.radii;
      visibilityMargin = marginM;
      visibilityEllipsoid = new Cesium.Ellipsoid(
        radii.x - marginM,
        radii.y - marginM,
        radii.z - marginM,
      );
      visibilityOccluder = new Cesium.EllipsoidalOccluder(visibilityEllipsoid);
    }
    const inverse = visibilityEllipsoid.oneOverRadii;
    // Inside the ellipsoid Cesium's occluder hides nearby points; judge by the frustum alone.
    const outside =
      Math.hypot(eye.x * inverse.x, eye.y * inverse.y, eye.z * inverse.z) >= 1;
    if (outside) {
      visibilityOccluder.cameraPosition = eye;
      let visible = false;
      for (const p of points) {
        if (visibilityOccluder.isPointVisible(p)) {
          visible = true;
          break;
        }
      }
      if (!visible) return false;
    }
    const culling = camera.frustum.computeCullingVolume(eye, direction, up);
    return (
      culling.computeVisibility(
        Cesium.BoundingSphere.fromPoints(points, visibilitySphere),
      ) !== Cesium.Intersect.OUTSIDE
    );
  };
}

/**
 * @param {{scene: object, camera: object, report: (error: unknown) => void,
 *   widget?: object, capabilities?: ReadonlySet<string>,
 *   now?: () => number, itemPosition?: Function}} options `scene`
 *   gives `requestRender`, the `preUpdate` a frame drawn without the
 *   clock's tick measures `changed` at, and the `postUpdate` move detection
 *   runs on; `widget`, the Viewer or CesiumWidget, gives the entity tracking
 *   `follow` runs on (without it the camera cannot follow);
 *   `capabilities`, the renderer's, gates the optional members (a camera
 *   with none given has them all); `now`, the clock moveEnd waits by,
 *   ms (`performance.now` by default); `itemPosition`, where the draw port
 *   draws an item at a scene time, which a follow of a drawn item tracks.
 * @returns {{port: import('../contract/camera').CameraPort,
 *   measureChanged: () => void, emit: (event: string) => void,
 *   dispose: () => void}} `measureChanged` measures this frame's `changed`
 *   if nothing has yet, for a frame loop to run before its own `preUpdate`
 *   listeners; `emit` raises one of the port's events (a test's fake camera
 *   that raises its own).
 */
export function createCesiumCamera({
  scene,
  camera,
  report,
  widget,
  capabilities,
  now = () => performance.now(),
  itemPosition,
}) {
  const removers = [];
  let lastWorld = null;
  let lastMatrices = null;
  let lastFollowFrame = null;
  // Camera events, measured on every tick: moveStart and moveEnd (500 ms
  // after the last change of the eye or its field of view, by `now`,
  // following or not, as Cesium's own), and `changed` per listener, where Cesium measures its
  // single threshold (`camera.percentageChanged`, which this leaves as it
  // is for everyone else listening to Cesium's own event). Cesium's own
  // moveStart and moveEnd are left out: it times them by the system clock.
  // What the events read Cesium's camera through while it stands: the
  // camera's own vectors, compared in place.
  const eye = { position: null, direction: null, up: null };
  const cameraEvents = createCameraEvents({
    // The memoised pose itself: the events only read it.
    pose: () => sharedPose(),
    world: () => {
      // The last view again while Cesium's vectors stand within rounding of
      // it; copies once they move (Cesium updates its own in place).
      const f = camera.frustum;
      eye.position = camera.positionWC;
      eye.direction = camera.directionWC;
      eye.up = camera.upWC;
      if (
        lastWorld &&
        // A new field of view or aspect (a resize) is a move too, as
        // Cesium's own camera events count it.
        Object.is(lastWorld.fovy, f.fovy) &&
        Object.is(lastWorld.aspectRatio, f.aspectRatio) &&
        sameEye(eye, lastWorld)
      )
        return lastWorld;
      lastWorld = {
        position: Cesium.Cartesian3.clone(eye.position),
        direction: Cesium.Cartesian3.clone(eye.direction),
        up: Cesium.Cartesian3.clone(eye.up),
        fovy: f.fovy,
        aspectRatio: f.aspectRatio,
        lens: `${f.fovy} ${f.aspectRatio}`,
      };
      return lastWorld;
    },
    report,
    thresholds: capabilities?.has('cameraChangeThreshold') ?? true,
  });
  // `changed` is measured once a frame where the contract's frame order
  // puts it: after the flight and input (Cesium's `initializeFrame`), before
  // follow and `preUpdate` move the camera. Cesium moves a followed target's
  // camera in its clock's tick, so a frame of the loop is measured as that
  // tick starts; a frame drawn with no tick (a forced render), as
  // `preUpdate` starts. Move detection runs after `preUpdate`.
  let measured = false;
  const measureChanged = () => {
    if (measured) return;
    measured = true;
    applyFov();
    cameraEvents.stepChanged();
  };
  const clock = widget?.clock;
  if (typeof clock?.tick === 'function') {
    const ownTick = clock.tick;
    let wrapping = true;
    const tick = function (...args) {
      if (wrapping) {
        measured = false;
        measureChanged();
      }
      return ownTick.apply(this, args);
    };
    clock.tick = tick;
    // Disposed, the clock gets its own tick back; if something has wrapped
    // it since, that wrapper stays and this part of it only passes through.
    removers.push(() => {
      wrapping = false;
      if (clock.tick !== tick) return;
      if (Object.getPrototypeOf(clock)?.tick === ownTick) delete clock.tick;
      else clock.tick = ownTick;
    });
  }
  const offPreUpdate = scene.preUpdate?.addEventListener(measureChanged);
  if (offPreUpdate) removers.push(offPreUpdate);
  removers.push(
    scene.postUpdate.addEventListener(() => {
      applyFov();
      // Measured already, unless the scene has no `preUpdate`.
      measureChanged();
      cameraEvents.stepMoveDetection(now());
      measured = false;
    }),
  );

  const following = widget?.trackedEntityChanged
    ? createCesiumFollow({
        widget,
        scene,
        camera,
        onChanged: () => cameraEvents.emit('followChanged'),
        itemPosition,
        now,
      })
    : null;

  // Camera commands: hooks run before each one, so an owner can yield.
  const commandHooks = listenerList(report);
  const command = (kind) => commandHooks.fire({ kind });

  const controlsPart = createCesiumControls({
    scene,
    widget,
    onCommand: (cb) => commandHooks.on(cb),
  });

  // The flight this port started, while it is in progress. Cesium cancels
  // a flight in progress when another starts, including one started on
  // its camera directly, and runs the callbacks inside the call or frame
  // that ends it. `flying` sees every Cesium flight; `flightEnd` comes for
  // the flights this port started (the application's flights all move onto
  // the port with the camera family).
  let flight = null;

  // A flight's end that Cesium raises inside one of this port's own calls
  // waits until Cesium's call returns, still inside the port's call: Cesium
  // runs a cancelled flight's callback before it lets go of that flight, so
  // the callback would read `flying` wrong, and a flight it started would
  // be let go of with the old one.
  let inCesiumCall = 0;
  const pendingEnds = [];
  function cesiumCall(fn) {
    inCesiumCall += 1;
    try {
      return fn();
    } finally {
      inCesiumCall -= 1;
      if (inCesiumCall === 0)
        for (const deliver of pendingEnds.splice(0)) deliver();
    }
  }

  function startFlight(start, options) {
    let resolve;
    const done = new Promise((r) => (resolve = r));
    let ended = false;
    const handle = {
      done,
      cancel() {
        if (flight === handle) cesiumCall(() => camera.cancelFlight());
      },
    };
    const end = (outcome) => {
      if (ended) return;
      ended = true;
      if (flight === handle) flight = null;
      const deliver = () => {
        const cb =
          outcome === 'complete' ? options.onComplete : options.onCancel;
        try {
          cb?.();
        } catch (error) {
          report(error);
        }
        resolve(outcome);
        cameraEvents.emit('flightEnd');
      };
      if (inCesiumCall) pendingEnds.push(deliver);
      else deliver();
    };
    flight = handle;
    cesiumCall(() =>
      start({
        complete: () => end('complete'),
        cancel: () => end('cancelled'),
      }),
    );
    // Cesium starts nothing mid scene-mode morph, and calls neither back.
    if (!ended && !cameraFlightActive(camera)) end('cancelled');
    scene.requestRender();
    return handle;
  }

  /**
   * The vertical field of view `setFov` asked for, held across resizes:
   * Cesium's `fov` is the wider of the two angles (the horizontal one when
   * the view is wider than tall), and it keeps that one when the aspect
   * changes. Before the first resize, and on a frustum without a field of
   * view, it waits.
   */
  let heldFovy = null;
  /** Cesium's own `fov` before the first hold, put back on release. */
  let ownFov = null;
  function applyFov() {
    const frustum = camera.frustum;
    const aspect = frustum?.aspectRatio;
    if (heldFovy === null || !('fov' in frustum) || !(aspect > 0)) return;
    const fov =
      aspect > 1 ? 2 * Math.atan(Math.tan(heldFovy / 2) * aspect) : heldFovy;
    if (frustum.fov !== fov) frustum.fov = fov;
  }

  /**
   * Put the eye at world point `destination` looking along `direction` with
   * `up` up (made square to it), in the camera's frame: a `lookAt` frame
   * stays, as Cesium's setView keeps it.
   */
  function placeEye(destination, { direction, up }) {
    const at = toCartesian(destination);
    const dir = Cesium.Cartesian3.normalize(
      toCartesian(direction),
      new Cesium.Cartesian3(),
    );
    const right = Cesium.Cartesian3.normalize(
      Cesium.Cartesian3.cross(dir, toCartesian(up), new Cesium.Cartesian3()),
      new Cesium.Cartesian3(),
    );
    const square = Cesium.Cartesian3.cross(right, dir, new Cesium.Cartesian3());
    const transform = camera.transform;
    if (
      transform &&
      !Cesium.Matrix4.equals(transform, Cesium.Matrix4.IDENTITY)
    ) {
      const inverse = Cesium.Matrix4.inverseTransformation(
        transform,
        new Cesium.Matrix4(),
      );
      Cesium.Matrix4.multiplyByPoint(inverse, at, camera.position);
      Cesium.Matrix4.multiplyByPointAsVector(inverse, dir, camera.direction);
      Cesium.Matrix4.multiplyByPointAsVector(inverse, square, camera.up);
      Cesium.Matrix4.multiplyByPointAsVector(inverse, right, camera.right);
      return;
    }
    Cesium.Cartesian3.clone(at, camera.position);
    Cesium.Cartesian3.clone(dir, camera.direction);
    Cesium.Cartesian3.clone(square, camera.up);
    Cesium.Cartesian3.clone(right, camera.right);
  }

  const cameraPort = {
    on: (event, cb, options) => cameraEvents.on(event, cb, options),
    onCommand: (cb) => commandHooks.on(cb),
    setView(spec) {
      command('setView');
      const d = spec.destination;
      const o = spec.orientation;
      // A view by direction and up at a point is placed as given: Cesium's
      // own setView would round it through heading, pitch and roll, which
      // drifts looking straight down, where steps add up (the app's pans,
      // turns and globe turns are setViews).
      if (d && !('rect' in d) && o && 'direction' in o) placeEye(d, o);
      else
        camera.setView({
          ...(d ? { destination: toDestination(d) } : {}),
          orientation: toOrientation(o),
        });
      scene.requestRender();
    },
    flyTo(destination, options = {}) {
      command('flyTo');
      return startFlight(
        (callbacks) =>
          camera.flyTo({
            destination: toDestination(destination),
            orientation: toOrientation(options.orientation),
            duration: options.durationS,
            easingFunction: options.easing && EASINGS[options.easing],
            maximumHeight: options.maxHeight,
            pitchAdjustHeight: options.pitchAdjustHeight,
            endTransform:
              options.endFrame === 'world'
                ? Cesium.Matrix4.IDENTITY
                : undefined,
            ...callbacks,
          }),
        options,
      );
    },
    flyToBounds(sphere, options = {}) {
      command('flyToBounds');
      const o = options.offset ?? {};
      return startFlight(
        (callbacks) =>
          camera.flyToBoundingSphere(
            new Cesium.BoundingSphere(
              toCartesian(sphere.center),
              sphere.radius,
            ),
            {
              offset: new Cesium.HeadingPitchRange(
                o.heading ?? 0,
                o.pitch ?? -Math.PI / 4,
                o.range ?? 0,
              ),
              duration: options.durationS,
              easingFunction: options.easing && EASINGS[options.easing],
              ...callbacks,
            },
          ),
        options,
      );
    },
    cancelFlight() {
      command('cancelFlight');
      cesiumCall(() => camera.cancelFlight());
    },
    get flying() {
      return cameraFlightActive(camera);
    },
    lookAt(target, offset) {
      command('lookAt');
      camera.lookAt(
        toCartesian(target),
        new Cesium.HeadingPitchRange(
          offset.heading,
          offset.pitch,
          offset.range,
        ),
      );
      scene.requestRender();
    },
    follow(target) {
      if (!following)
        throw new Error('This camera cannot follow: it has no entity tracking');
      command('follow');
      following.follow(target);
      scene.requestRender();
    },
    get followed() {
      return following?.followed ?? null;
    },
    get followFramed() {
      return following?.followFramed ?? false;
    },
    followOffset: following?.followOffset ?? NO_FOLLOW_OFFSET,
    controls: controlsPart.controls,
    release() {
      command('release');
      camera.lookAtTransform(Cesium.Matrix4.IDENTITY);
      scene.requestRender();
    },
    setFov(fov) {
      const frustum = camera.frustum;
      if (fov === null) {
        // Given back: Cesium's own angle again, kept as it keeps it.
        if (heldFovy !== null && ownFov !== null && 'fov' in frustum)
          frustum.fov = ownFov;
        heldFovy = null;
        ownFov = null;
        scene.requestRender();
        return;
      }
      const { vertical } = fov;
      // Cesium would take a bad angle and draw a garbage projection.
      if (!(vertical > 0 && vertical < Math.PI))
        throw new RangeError(`no vertical field of view of ${vertical}`);
      if (heldFovy === null && 'fov' in frustum) ownFov = frustum.fov;
      heldFovy = vertical;
      applyFov();
      scene.requestRender();
    },
    // The scene's own frame: ECEF in 3D, the only mode the app runs (Cesium's
    // 2D and Columbus view frames are projected map coordinates).
    matrices() {
      // The last ones again while Cesium's stand, new ones once they move.
      const view = camera.viewMatrix;
      const projection = camera.frustum.projectionMatrix;
      if (
        !lastMatrices ||
        !sameMatrix(lastMatrices.view, view) ||
        !sameMatrix(lastMatrices.projection, projection)
      )
        lastMatrices = {
          view: matrixArray(view),
          projection: matrixArray(projection),
        };
      return lastMatrices;
    },
    // Cesium's own corner picks (`computeViewRectangle`), on rays that
    // keep their precision (`pickRayAt`).
    viewRectangle() {
      if (scene.mode !== Cesium.SceneMode.SCENE3D) {
        const rect = camera.computeViewRectangle(Cesium.Ellipsoid.WGS84);
        if (!rect) return null;
        const deg = Cesium.Math.toDegrees;
        return {
          west: deg(rect.west),
          south: deg(rect.south),
          east: deg(rect.east),
          north: deg(rect.north),
        };
      }
      return computeViewRectangle(
        cameraPort.pose(),
        {
          width: scene.canvas.clientWidth,
          height: scene.canvas.clientHeight,
        },
        (x, y) => pickEllipsoidAt(scene, camera, x, y) ?? null,
      );
    },
    pose() {
      // Each caller gets objects of its own.
      return copyPose(sharedPose());
    },
  };
  /**
   * The pose, read again only when the camera has moved: a frame reads the
   * pose many times over. Shared: never changed once read.
   */
  function sharedPose() {
    if (!poseKeyHolds() || !poseMemo) {
      poseMemo = readPose();
      // Outside 3D, Cesium measures heading, pitch and roll by moving the
      // camera into the eye's frame and back, which can change its last
      // bits: keyed as it is left.
      if (scene.mode !== Cesium.SceneMode.SCENE3D) poseKeyHolds();
    }
    return poseMemo;
  }
  // The camera as the memoised pose was read: eye, axes, transform,
  // frustum and mode, compared value for value.
  const poseKey = new Float64Array(37);
  let poseMemo = null;
  /**
   * Whether the camera is as `poseKey` holds, writing it as the camera now
   * is: everything a pose is read from.
   */
  function poseKeyHolds() {
    const p = camera.positionWC;
    const d = camera.directionWC;
    const u = camera.upWC;
    const r = camera.rightWC;
    const f = camera.frustum;
    const t = camera.transform;
    keySame = true;
    keyAt = 0;
    put(p.x);
    put(p.y);
    put(p.z);
    put(d.x);
    put(d.y);
    put(d.z);
    put(u.x);
    put(u.y);
    put(u.z);
    // Cesium lets right drift a little from direction × up.
    put(r.x);
    put(r.y);
    put(r.z);
    put(f.fovy ?? NaN);
    put(f.aspectRatio ?? NaN);
    put(f.near ?? NaN);
    put(f.far ?? NaN);
    // A 2D camera's height is its off-centre frustum's width.
    put(f.left ?? NaN);
    put(f.right ?? NaN);
    put(f.top ?? NaN);
    put(f.bottom ?? NaN);
    put(scene.mode ?? NaN);
    for (let i = 0; i < 16; i++) put(t[i]);
    return keySame;
  }
  // Where `poseKeyHolds` writes next, and whether all it wrote held.
  let keyAt = 0;
  let keySame = true;
  function put(value) {
    if (!Object.is(poseKey[keyAt], value)) {
      keySame = false;
      poseKey[keyAt] = value;
    }
    keyAt += 1;
  }
  const enuScratch = new Cesium.Matrix4();
  /**
   * Heading, pitch and roll as Cesium's camera measures them: the eye's
   * direction and up in its east-north-up frame, put through Cesium's own
   * formulas. Cesium moves the camera into that frame and back for each of
   * the three; in 3D this reads the frame once and leaves the camera be
   * (the same heading, and pitch and roll to the last bit or so). In other
   * modes Cesium's frames differ, and it is asked.
   */
  function headingPitchRoll() {
    if (scene.mode !== Cesium.SceneMode.SCENE3D)
      return {
        heading: camera.heading,
        pitch: camera.pitch,
        roll: camera.roll,
      };
    const m = Cesium.Transforms.eastNorthUpToFixedFrame(
      camera.positionWC,
      scene.mapProjection?.ellipsoid ?? Cesium.Ellipsoid.default,
      enuScratch,
    );
    // Into the frame as Cesium's inverse transformation takes them.
    const d = camera.directionWC;
    const u = camera.upWC;
    const dx = m[0] * d.x + m[1] * d.y + m[2] * d.z;
    const dy = m[4] * d.x + m[5] * d.y + m[6] * d.z;
    const dz = m[8] * d.x + m[9] * d.y + m[10] * d.z;
    const ux = m[0] * u.x + m[1] * u.y + m[2] * u.z;
    const uy = m[4] * u.x + m[5] * u.y + m[6] * u.z;
    const uz = m[8] * u.x + m[9] * u.y + m[10] * u.z;
    // Right as Cesium crosses it there: direction × up.
    const rz = dx * uy - dy * ux;
    const M = Cesium.Math;
    const level = !M.equalsEpsilon(Math.abs(dz), 1.0, M.EPSILON3);
    const heading =
      M.TWO_PI -
      M.zeroToTwoPi(
        (level ? Math.atan2(dy, dx) : Math.atan2(uy, ux)) - M.PI_OVER_TWO,
      );
    const pitch = M.PI_OVER_TWO - M.acosClamped(dz);
    const roll = level ? M.zeroToTwoPi(Math.atan2(-rz, uz) + M.TWO_PI) : 0.0;
    return { heading, pitch, roll };
  }

  /** A pose read from Cesium's camera (after `poseKeyHolds` keyed it). */
  function readPose() {
    const v = (c) => ({ x: c.x, y: c.y, z: c.z });
    const { heading, pitch, roll } = headingPitchRoll();
    // Cesium has no cartographic position for an eye at the earth's
    // centre; the pose then says so with NaN.
    const carto = camera.positionCartographic ?? {
      longitude: NaN,
      latitude: NaN,
      height: NaN,
    };
    return {
      lon: Cesium.Math.toDegrees(carto.longitude),
      lat: Cesium.Math.toDegrees(carto.latitude),
      position: v(camera.positionWC),
      direction: v(camera.directionWC),
      up: v(camera.upWC),
      right: v(camera.rightWC),
      heading,
      pitch,
      roll,
      height: carto.height,
      fovy: camera.frustum.fovy,
      aspectRatio: camera.frustum.aspectRatio,
      near: camera.frustum.near,
      far: camera.frustum.far,
      frameIsIdentity: Cesium.Matrix4.equals(
        camera.transform,
        Cesium.Matrix4.IDENTITY,
      ),
    };
  }
  /** A pose of the caller's own, its vectors too. */
  const copyPose = (pose) => ({
    ...pose,
    position: { ...pose.position },
    direction: { ...pose.direction },
    up: { ...pose.up },
    right: { ...pose.right },
  });
  // Cesium keeps the eye in `camera.transform`: a tracked entity's frame, a
  // `lookAt` target's, or the identity.
  if (!capabilities || capabilities.has('followFrame'))
    cameraPort.followFrame = () => {
      if (!lastFollowFrame || !sameMatrix(lastFollowFrame, camera.transform))
        lastFollowFrame = matrixArray(camera.transform);
      return lastFollowFrame;
    };

  return {
    port: cameraPort,
    measureChanged,
    emit: (event) => cameraEvents.emit(event),
    dispose() {
      following?.dispose();
      controlsPart.dispose();
      for (const off of removers.splice(0)) off();
      cameraEvents.clear();
      commandHooks.clear();
    },
  };
}

// A Cesium viewer with no renderer bound to it gets a
// camera port over its camera when code first asks `cameraOf` for one. The
// port wraps the viewer's `clock.tick` to measure `changed`, and gives it
// back when a renderer is bound to the viewer.
provideUnboundCamera((viewer) =>
  // By shape, not `instanceof`: the viewer may come from another
  // copy of Cesium.
  typeof viewer.camera?.flyTo === 'function' &&
  typeof viewer.camera.moveStart?.addEventListener === 'function' &&
  typeof viewer.scene?.postUpdate?.addEventListener === 'function'
    ? createCesiumCamera({
        scene: viewer.scene,
        camera: viewer.camera,
        report: uncaught,
        widget: viewer,
      })
    : null,
);
