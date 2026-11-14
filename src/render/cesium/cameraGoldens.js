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
 *
 * A script with `input` steps runs a real `ScreenSpaceCameraController`
 * over a stand-in canvas: its pointer and wheel events go to the
 * controller's own event handler as the DOM would give them (mouse events,
 * Cesium's choice where there are no pointer events), and the controller
 * updates each frame where Cesium's scene updates it, after the tweens.
 * `Date`, which the controller's inertia reads, runs on the virtual clock
 * too.
 */
import * as Cesium from 'cesium';
import {
  CAMERA_SCRIPTS,
  SCRIPT_VIEWPORT,
  usesInput,
} from '../conformance/cameraScripts.js';
import { runCameraScript } from '../conformance/cameraRunner.js';
import { updateCameraChanged } from './internals.js';
import { controllerDefaults } from './cameraControls.js';

/**
 * The contract's easings as Cesium's, kept here rather than taken from the
 * port: the traces are the reference the port is checked against.
 */
const EASINGS = {
  linear: Cesium.EasingFunction.LINEAR_NONE,
  quadraticInOut: Cesium.EasingFunction.QUADRATIC_IN_OUT,
  cubicInOut: Cesium.EasingFunction.CUBIC_IN_OUT,
  cubicOut: Cesium.EasingFunction.CUBIC_OUT,
  quadraticOut: Cesium.EasingFunction.QUADRATIC_OUT,
  quinticInOut: Cesium.EasingFunction.QUINTIC_IN_OUT,
  sineInOut: Cesium.EasingFunction.SINUSOIDAL_IN_OUT,
};

/** One frame of the virtual clock, ms. */
export const FRAME_MS = 1000 / 60;

/** The epoch `Date` reads at virtual time 0. */
const VIRTUAL_EPOCH_MS = Date.UTC(2026, 0, 1);

/** Run `fn` with `performance.now()` and `Date` reading the virtual clock. */
export async function withVirtualClock(fn) {
  const real = Object.getOwnPropertyDescriptor(globalThis, 'performance');
  const RealDate = globalThis.Date;
  const clock = { now: 0 };
  Object.defineProperty(globalThis, 'performance', {
    configurable: true,
    value: { now: () => clock.now, mark() {}, measure() {} },
  });
  // A function, not a subclass: `Date()` called plainly still gives a
  // string, and dates made before stay `instanceof Date`.
  function VirtualDate(...args) {
    if (!new.target)
      return new RealDate(VIRTUAL_EPOCH_MS + clock.now).toString();
    return args.length
      ? new RealDate(...args)
      : new RealDate(VIRTUAL_EPOCH_MS + clock.now);
  }
  Object.setPrototypeOf(VirtualDate, RealDate);
  VirtualDate.prototype = RealDate.prototype;
  VirtualDate.now = () => VIRTUAL_EPOCH_MS + clock.now;
  globalThis.Date = VirtualDate;
  try {
    return await fn(clock);
  } finally {
    globalThis.Date = RealDate;
    if (real) Object.defineProperty(globalThis, 'performance', real);
  }
}

/**
 * A canvas for a controller's event handler: it keeps the listeners the
 * handler adds, and `dispatch` calls them as the DOM would. Its root
 * events stay on it (`disableRootEvents`), as there is no document; the
 * handler still compares its element with one, so a `document` stands in
 * while an event is handled, where there is none.
 */
function standInCanvas() {
  const listeners = new Map();
  return {
    clientWidth: SCRIPT_VIEWPORT.width,
    clientHeight: SCRIPT_VIEWPORT.height,
    disableRootEvents: true,
    onwheel: null,
    getBoundingClientRect: () => ({ left: 0, top: 0 }),
    addEventListener(type, fn) {
      if (!listeners.has(type)) listeners.set(type, new Set());
      listeners.get(type).add(fn);
    },
    removeEventListener(type, fn) {
      listeners.get(type)?.delete(fn);
    },
    dispatch(type, event) {
      const own = typeof globalThis.document === 'undefined';
      if (own) globalThis.document = {};
      try {
        for (const fn of [...(listeners.get(type) ?? [])]) fn(event);
      } finally {
        if (own) delete globalThis.document;
      }
    },
  };
}

/**
 * A Cesium camera on a scene with no globe, sized as the scripts' viewport.
 * With `input`, the scene has a real controller over a stand-in canvas.
 * @param {{input?: boolean}} [options]
 */
export function headlessCamera({ input = false } = {}) {
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
      ...controllerDefaults(),
      enableInputs: true,
    },
    frameState: { mode: Cesium.SceneMode.SCENE3D },
  };
  const camera = new Cesium.Camera(scene);
  scene.camera = camera;
  camera.frustum.aspectRatio = SCRIPT_VIEWPORT.width / SCRIPT_VIEWPORT.height;
  if (input) {
    scene.canvas = standInCanvas();
    // What the controller's update reads off a real scene.
    scene.verticalExaggeration = 1;
    scene.verticalExaggerationRelativeHeight = 0;
    scene.screenSpaceCameraController = new Cesium.ScreenSpaceCameraController(
      scene,
    );
  }
  return { scene, camera };
}

/**
 * Send a script pointer event (`ScriptPointer`, `cameraRunner.js`) to a
 * scene made by `headlessCamera({ input: true })`, as the DOM mouse or
 * wheel event Cesium reads.
 */
export function dispatchPointer(scene, ev) {
  scene.canvas.dispatch(DOM_TYPES[ev.type], domEvent(ev));
}

function domEvent(ev) {
  const at = ev.endPosition ?? ev.position;
  return {
    button: ev.button,
    clientX: at.x,
    clientY: at.y,
    shiftKey: ev.modifiers.shift,
    ctrlKey: ev.modifiers.ctrl,
    altKey: ev.modifiers.alt,
    metaKey: ev.modifiers.meta,
    ...(ev.wheel
      ? {
          deltaX: 0,
          deltaY: ev.wheel.deltaY,
          deltaMode: ev.wheel.deltaMode,
          DOM_DELTA_PIXEL: 0,
          DOM_DELTA_LINE: 1,
          DOM_DELTA_PAGE: 2,
        }
      : {}),
    preventDefault() {},
  };
}

const DOM_TYPES = {
  down: 'mousedown',
  move: 'mousemove',
  up: 'mouseup',
  wheel: 'wheel',
};

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
function cesiumDriver(clock, threshold, input = false) {
  const { scene, camera } = headlessCamera({ input });
  const controller = input ? scene.screenSpaceCameraController : null;
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
            easingFunction: EASINGS[options.easing],
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
      controller?.update();
      updateCameraChanged(camera);
    },
    ...(input
      ? {
          pointer: (ev) => dispatchPointer(scene, ev),
        }
      : {}),
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
  const input = usesInput(script);
  const base = await withVirtualClock((clock) =>
    runCameraScript(cesiumDriver(clock, undefined, input), script),
  );
  if (!thresholds.length) return base;
  const counts = [];
  for (const threshold of thresholds) {
    const run = await withVirtualClock((clock) =>
      runCameraScript(cesiumDriver(clock, threshold, input), script),
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
