/**
 * @module render/cesium/cameraGoldens
 * @description Records the reference camera traces: every conformance camera
 * script run on Cesium's own `Camera`, headless, on a virtual clock that
 * advances exactly 1/60 s per frame and restarts per script. No globe and no
 * tiles, so the traces depend on the camera alone and are bit-identical run
 * to run. `scripts/record-camera-goldens.mjs` writes them to
 * `src/render/conformance/goldens/camera.json`.
 *
 * Cesium has one `changed` threshold per camera, where the contract has one
 * per listener, so a script that listens at several thresholds is run once
 * per threshold and each count is taken from its own run.
 */
import * as Cesium from 'cesium';
import {
  CAMERA_SCRIPTS,
  SCRIPT_VIEWPORT,
} from '../conformance/cameraScripts.js';
import { runCameraScript } from '../conformance/cameraRunner.js';
import { updateCameraChanged } from './internals.js';

/**
 * The contract's easings as Cesium's, kept here rather than taken from the
 * port: the traces are the reference the port is checked against.
 */
const EASINGS = {
  linear: Cesium.EasingFunction.LINEAR_NONE,
  quadraticInOut: Cesium.EasingFunction.QUADRATIC_IN_OUT,
  cubicInOut: Cesium.EasingFunction.CUBIC_IN_OUT,
  cubicOut: Cesium.EasingFunction.CUBIC_OUT,
  quinticInOut: Cesium.EasingFunction.QUINTIC_IN_OUT,
};

/** One frame of the virtual clock, ms. */
export const FRAME_MS = 1000 / 60;

/** Run `fn` with `performance.now()` reading the virtual clock. */
export async function withVirtualClock(fn) {
  const real = Object.getOwnPropertyDescriptor(globalThis, 'performance');
  const clock = { now: 0 };
  Object.defineProperty(globalThis, 'performance', {
    configurable: true,
    value: { now: () => clock.now, mark() {}, measure() {} },
  });
  try {
    return await fn(clock);
  } finally {
    if (real) Object.defineProperty(globalThis, 'performance', real);
  }
}

/** A Cesium camera on a scene with no globe, sized as the scripts' viewport. */
export function headlessCamera() {
  const scene = {
    canvas: {
      clientWidth: SCRIPT_VIEWPORT.width,
      clientHeight: SCRIPT_VIEWPORT.height,
    },
    drawingBufferWidth: SCRIPT_VIEWPORT.width,
    drawingBufferHeight: SCRIPT_VIEWPORT.height,
    pixelRatio: 1,
    mapProjection: new Cesium.GeographicProjection(),
    mode: Cesium.SceneMode.SCENE3D,
    tweens: new Cesium.TweenCollection(),
    globe: undefined,
    ellipsoid: Cesium.Ellipsoid.WGS84,
    screenSpaceCameraController: {
      minimumZoomDistance: 1,
      maximumZoomDistance: Number.POSITIVE_INFINITY,
      enableInputs: true,
    },
    frameState: { mode: Cesium.SceneMode.SCENE3D },
  };
  const camera = new Cesium.Camera(scene);
  scene.camera = camera;
  camera.frustum.aspectRatio = SCRIPT_VIEWPORT.width / SCRIPT_VIEWPORT.height;
  return { scene, camera };
}

const cart = (p) => new Cesium.Cartesian3(p.x, p.y, p.z);
const toEcef = (p) =>
  'lon' in p
    ? Cesium.Cartesian3.fromDegrees(p.lon, p.lat, p.height ?? 0)
    : cart(p);

function destinationOf(destination) {
  if (!destination) return undefined;
  if ('rect' in destination) {
    const r = destination.rect;
    return Cesium.Rectangle.fromDegrees(r.west, r.south, r.east, r.north);
  }
  return toEcef(destination);
}

function orientationOf(orientation) {
  if (!orientation) return undefined;
  if ('direction' in orientation)
    return { direction: cart(orientation.direction), up: cart(orientation.up) };
  return { ...orientation };
}

/** A driver for {@link runCameraScript} over a headless Cesium camera. */
function cesiumDriver(clock, threshold) {
  const { scene, camera } = headlessCamera();
  let flying = false;
  let changedCount = 0;
  camera.percentageChanged = threshold ?? 0.5;
  if (threshold !== undefined)
    camera.changed.addEventListener(() => (changedCount += 1));

  function flight(start) {
    let resolve;
    const done = new Promise((r) => (resolve = r));
    flying = true;
    start(
      () => {
        flying = false;
        resolve('complete');
      },
      () => {
        flying = false;
        resolve('cancelled');
      },
    );
    return { done, cancel: () => camera.cancelFlight() };
  }

  const commands = {
    setView({ destination, orientation } = {}) {
      camera.setView({
        destination: destinationOf(destination),
        orientation: orientationOf(orientation),
      });
    },
    lookAt(target, offset) {
      camera.lookAt(
        cart(target),
        new Cesium.HeadingPitchRange(
          offset.heading,
          offset.pitch,
          offset.range,
        ),
      );
    },
    release() {
      camera.lookAtTransform(Cesium.Matrix4.IDENTITY);
    },
    move(direction, metres) {
      const name = {
        forward: 'moveForward',
        back: 'moveBackward',
        left: 'moveLeft',
        right: 'moveRight',
        up: 'moveUp',
        down: 'moveDown',
      }[direction];
      camera[name](metres);
    },
    look(direction, radians) {
      const name = {
        left: 'lookLeft',
        right: 'lookRight',
        up: 'lookUp',
        down: 'lookDown',
      }[direction];
      camera[name](radians);
    },
    rotateAround(axis, radians) {
      camera.rotate(cart(axis), radians);
    },
    zoom(metres) {
      camera.zoomIn(metres);
    },
    flyTo(destination, options = {}) {
      return flight((complete, cancel) =>
        camera.flyTo({
          destination: destinationOf(destination),
          orientation: orientationOf(options.orientation),
          duration: options.durationS,
          maximumHeight: options.maxHeight,
          pitchAdjustHeight: options.pitchAdjustHeight,
          easingFunction: EASINGS[options.easing],
          complete,
          cancel,
        }),
      );
    },
    flyToBounds(sphere, options = {}) {
      return flight((complete, cancel) =>
        camera.flyToBoundingSphere(
          new Cesium.BoundingSphere(cart(sphere.center), sphere.radius),
          {
            offset: options.offset
              ? new Cesium.HeadingPitchRange(
                  options.offset.heading,
                  options.offset.pitch,
                  options.offset.range,
                )
              : undefined,
            duration: options.durationS,
            complete,
            cancel,
          },
        ),
      );
    },
    cancelFlight() {
      camera.cancelFlight();
    },
  };

  const viewProjection = () =>
    Cesium.Matrix4.multiply(
      camera.frustum.projectionMatrix,
      camera.viewMatrix,
      new Cesium.Matrix4(),
    );

  return {
    command: (name, args) => commands[name](...args),
    frame() {
      clock.now += FRAME_MS;
      scene.tweens.update();
      updateCameraChanged(camera);
    },
    listen: () => () => changedCount,
    pose() {
      const c = camera.positionCartographic;
      return {
        position: camera.positionWC,
        direction: camera.directionWC,
        up: camera.upWC,
        right: camera.rightWC,
        heading: camera.heading,
        pitch: camera.pitch,
        roll: camera.roll,
        height: c.height,
        near: camera.frustum.near,
        far: camera.frustum.far,
        frameIsIdentity: Cesium.Matrix4.equals(
          camera.transform,
          Cesium.Matrix4.IDENTITY,
        ),
      };
    },
    viewRectangle() {
      const rect = camera.computeViewRectangle(Cesium.Ellipsoid.WGS84);
      if (!rect) return null;
      const deg = Cesium.Math.toDegrees;
      return {
        west: deg(rect.west),
        south: deg(rect.south),
        east: deg(rect.east),
        north: deg(rect.north),
      };
    },
    matrices: () => ({
      view: Float64Array.from(Cesium.Matrix4.toArray(camera.viewMatrix)),
      projection: Float64Array.from(
        Cesium.Matrix4.toArray(camera.frustum.projectionMatrix),
      ),
    }),
    project(position) {
      const clip = Cesium.Matrix4.multiplyByVector(
        viewProjection(),
        new Cesium.Cartesian4(position.x, position.y, position.z, 1),
        new Cesium.Cartesian4(),
      );
      if (clip.w <= 0) return null;
      return {
        x: ((clip.x / clip.w + 1) / 2) * SCRIPT_VIEWPORT.width,
        y: ((1 - clip.y / clip.w) / 2) * SCRIPT_VIEWPORT.height,
      };
    },
    pickEllipsoid: (s) =>
      camera.pickEllipsoid(new Cesium.Cartesian2(s.x, s.y)) ?? null,
    pickRay: (s) => camera.getPickRay(new Cesium.Cartesian2(s.x, s.y)),
    occluded: (p) =>
      !new Cesium.EllipsoidalOccluder(
        Cesium.Ellipsoid.WGS84,
        camera.positionWC,
      ).isPointVisible(p),
    flying: () => flying,
    toEcef: (p) => {
      const e = toEcef(p);
      return { x: e.x, y: e.y, z: e.z };
    },
  };
}

/** Run one script on Cesium, once per `changed` threshold it listens at. */
async function recordScript(script) {
  const thresholds = script.steps
    .filter((step) => step.do === 'listen')
    .map((step) => step.threshold);
  const base = await withVirtualClock((clock) =>
    runCameraScript(cesiumDriver(clock, undefined), script),
  );
  if (!thresholds.length) return base;
  const counts = [];
  for (const threshold of thresholds) {
    const run = await withVirtualClock((clock) =>
      runCameraScript(cesiumDriver(clock, threshold), script),
    );
    const changed = run.records.find((r) => r.kind === 'changed');
    counts.push({ threshold, count: changed.value[0].count });
  }
  for (const r of base.records) if (r.kind === 'changed') r.value = counts;
  return base;
}

/**
 * Every script's trace on the installed Cesium.
 * @returns {Promise<{cesium: string, viewport: object, scripts: Record<string, object>}>}
 */
export async function recordCameraGoldens() {
  const scripts = {};
  for (const script of CAMERA_SCRIPTS)
    scripts[script.name] = await recordScript(script);
  return { cesium: Cesium.VERSION, viewport: SCRIPT_VIEWPORT, scripts };
}
