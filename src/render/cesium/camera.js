/**
 * @module render/cesium/camera
 * @description The Cesium renderer's camera port over a Cesium camera:
 * poses, views, flights, `lookAt`, events and command hooks, each mapped
 * onto Cesium's own camera call.
 */
import * as Cesium from 'cesium';
import { createCameraEvents } from '../camera/events.js';
import { listenerList, toCartesian, uncaught } from './common.js';
import { cameraFlightActive } from './internals.js';
import { createCesiumFollow } from './follow.js';
import { cameraOf, provideUnboundCamera } from '../rendererOf.js';

/**
 * `cameraOf`, for code that already reaches Cesium: importing it from here
 * loads the factory a viewer with no renderer bound gets its camera from.
 */
export { cameraOf };

/** The contract's easings as Cesium's. */
export const EASINGS = Object.freeze({
  linear: Cesium.EasingFunction.LINEAR_NONE,
  quadraticInOut: Cesium.EasingFunction.QUADRATIC_IN_OUT,
  cubicInOut: Cesium.EasingFunction.CUBIC_IN_OUT,
  cubicOut: Cesium.EasingFunction.CUBIC_OUT,
  quinticInOut: Cesium.EasingFunction.QUINTIC_IN_OUT,
  sineInOut: Cesium.EasingFunction.SINUSOIDAL_IN_OUT,
});

/**
 * The contract's moves and looks as Cesium camera method names, called by
 * name: a consumer's camera may come from another copy of Cesium.
 */
const MOVES = Object.freeze({
  forward: 'moveForward',
  back: 'moveBackward',
  left: 'moveLeft',
  right: 'moveRight',
  up: 'moveUp',
  down: 'moveDown',
});
const LOOKS = Object.freeze({
  left: 'lookLeft',
  right: 'lookRight',
  up: 'lookUp',
  down: 'lookDown',
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

/**
 * @param {{scene: object, camera: object, report: (error: unknown) => void,
 *   widget?: object}} options `scene` gives `requestRender` and the
 *   `postUpdate` tick `changed` is measured on; `widget`, the Viewer or
 *   CesiumWidget, gives the entity tracking `follow` runs on (without it the
 *   camera cannot follow).
 * @returns {{port: import('../contract/camera').CameraPort, dispose: () => void}}
 */
export function createCesiumCamera({ scene, camera, report, widget }) {
  const removers = [];
  // Camera events: Cesium's own moveStart and moveEnd (500 ms after the
  // last change, never while following), and `changed` measured per
  // listener on every tick, where Cesium measures its single threshold.
  const cameraEvents = createCameraEvents({
    pose: () => cameraPort.pose(),
    report,
  });
  removers.push(
    scene.postUpdate.addEventListener(() => cameraEvents.stepChanged()),
    camera.moveStart.addEventListener(() => cameraEvents.emit('moveStart')),
    camera.moveEnd.addEventListener(() => cameraEvents.emit('moveEnd')),
  );

  const following = widget?.trackedEntityChanged
    ? createCesiumFollow({
        widget,
        scene,
        camera,
        onChanged: () => cameraEvents.emit('followChanged'),
      })
    : null;

  // Camera commands: hooks run before each one, so an owner can yield.
  const commandHooks = listenerList(report);
  const command = (kind) => commandHooks.fire({ kind });

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

  const cameraPort = {
    on: (event, cb, options) => cameraEvents.on(event, cb, options),
    onCommand: (cb) => commandHooks.on(cb),
    setView(spec) {
      command('setView');
      const d = spec.destination;
      camera.setView({
        ...(d ? { destination: toDestination(d) } : {}),
        orientation: toOrientation(spec.orientation),
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
    release() {
      command('release');
      camera.lookAtTransform(Cesium.Matrix4.IDENTITY);
      scene.requestRender();
    },
    move(direction, metres) {
      camera[MOVES[direction]](metres);
      scene.requestRender();
    },
    look(direction, radians) {
      camera[LOOKS[direction]](radians);
      scene.requestRender();
    },
    rotateAround(axis, radians) {
      camera.rotate(toCartesian(axis), radians);
      scene.requestRender();
    },
    zoom(metres) {
      // Cesium's zoom, not a move: outside 3D it changes the view's width.
      if (metres < 0) camera.zoomOut(-metres);
      else camera.zoomIn(metres);
      scene.requestRender();
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
    pose() {
      const v = (c) => ({ x: c.x, y: c.y, z: c.z });
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
        heading: camera.heading,
        pitch: camera.pitch,
        roll: camera.roll,
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
    },
  };

  return {
    port: cameraPort,
    dispose() {
      following?.dispose();
      for (const off of removers.splice(0)) off();
      cameraEvents.clear();
      commandHooks.clear();
    },
  };
}

// A Cesium viewer of a consumer's own, with no renderer bound to it, gets a
// camera port over its camera when code first asks `cameraOf` for one.
provideUnboundCamera((viewer) =>
  // By shape, not `instanceof`: a consumer's viewer may come from another
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
