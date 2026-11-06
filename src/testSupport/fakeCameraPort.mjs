/**
 * A camera port for tests of code that reads the camera: a settable pose,
 * a settable view rectangle, and events the test raises itself.
 */
import { createCameraEvents } from '../render/camera/events.js';
import { toDegrees } from '../geo/index.js';
import { bindRenderer, rendererOf } from '../render/rendererOf.js';
import { createCesiumCamera } from '../render/cesium/camera.js';

const DEFAULT_POSE = Object.freeze({
  lon: 0,
  lat: 0,
  height: 1000,
  heading: 0,
  pitch: -Math.PI / 2,
  roll: 0,
  position: { x: 0, y: 0, z: 0 },
  direction: { x: 0, y: 0, z: -1 },
  up: { x: 0, y: 1, z: 0 },
  right: { x: 1, y: 0, z: 0 },
  fovy: Math.PI / 3,
  aspectRatio: 1,
  near: 1,
  far: 5e8,
  frameIsIdentity: true,
});

/**
 * @param {{pose?: object, viewRectangle?: object|null}} [initial]
 */
export function fakeCameraPort({ pose = {}, viewRectangle = null } = {}) {
  let current = { ...DEFAULT_POSE, ...pose };
  let rect = viewRectangle;
  const events = createCameraEvents({
    pose: () => ({ ...current }),
    report: (error) => {
      throw error;
    },
  });
  const counts = {};
  const port = {
    pose: () => ({ ...current }),
    viewRectangle: () => (rect ? { ...rect } : null),
    on(event, cb, options) {
      const off = events.on(event, cb, options);
      counts[event] = (counts[event] ?? 0) + 1;
      let live = true;
      return () => {
        if (live) counts[event] -= 1;
        live = false;
        off();
      };
    },
  };
  return {
    port,
    /** Change the pose the port reports. */
    setPose: (fields) => (current = { ...current, ...fields }),
    setViewRectangle: (next) => (rect = next),
    emit: (event) => events.emit(event),
    /** Run the contract's `changed` measure, as a frame would. */
    stepChanged: () => events.stepChanged(),
    listenerCount: (event) => counts[event] ?? 0,
  };
}

/**
 * Bind to a fake viewer the Cesium renderer's own camera port over its
 * Cesium-shaped fake camera, for tests whose code is half on the port: the
 * port's commands reach the fake camera as the renderer maps them
 * (`flyTo({destination: Cartesian3, ...})`), while poses are read leniently
 * from what the fake has (`positionCartographic`, `heading`, `pitch`,
 * `roll`) and events come from the fake's own `changed`, `moveStart` and
 * `moveEnd`. Binding a viewer twice keeps the first. Returns the viewer.
 * @template {{camera: object}} V
 * @param {V} viewer
 * @returns {V}
 */
export function bindFakeCesiumCamera(viewer) {
  if (rendererOf(viewer)) return viewer;
  const fake = viewer.camera;
  const noEvent = { addEventListener: () => () => {} };
  // A fake that does not keep Cesium's current flight gets one kept for it,
  // as Cesium does: from a flight's start until it completes or cancels.
  let current = null;
  const flown = (fly) =>
    function (...args) {
      const options = args.at(-1) ?? {};
      const flight = {};
      current = flight;
      const settle = (cb) => () => {
        if (current === flight) current = null;
        cb?.();
      };
      args[args.length - 1] = {
        ...options,
        complete: settle(options.complete),
        cancel: settle(options.cancel),
      };
      return fly.apply(this, args);
    };
  const keepsFlight = '_currentFlight' in fake;
  const camera = new Proxy(fake, {
    get(target, key, receiver) {
      if ((key === 'moveStart' || key === 'moveEnd') && !target[key])
        return noEvent;
      if (!keepsFlight) {
        if (key === '_currentFlight') return current ?? undefined;
        if ((key === 'flyTo' || key === 'flyToBoundingSphere') && target[key])
          return flown(target[key]);
        if (key === 'cancelFlight' && target[key])
          return function (...args) {
            current = null;
            return target[key].apply(this, args);
          };
      }
      return Reflect.get(target, key, receiver);
    },
  });
  const scene = {
    postUpdate: noEvent,
    requestRender: () => viewer.scene?.requestRender?.(),
  };
  const real = createCesiumCamera({
    scene,
    camera,
    report: (error) => {
      throw error;
    },
  }).port;
  const port = Object.create(real, {
    pose: {
      value() {
        const c = fake.positionCartographic;
        return {
          ...DEFAULT_POSE,
          lon: c ? toDegrees(c.longitude) : NaN,
          lat: c ? toDegrees(c.latitude) : NaN,
          height: c ? c.height : NaN,
          heading: fake.heading ?? 0,
          pitch: fake.pitch ?? -Math.PI / 2,
          roll: fake.roll ?? 0,
        };
      },
    },
    viewRectangle: { value: () => null },
    on: {
      value(event, cb) {
        const source = fake[event];
        const off = source?.addEventListener?.(cb);
        if (typeof off === 'function') return off;
        return () => source?.removeEventListener?.(cb);
      },
    },
  });
  bindRenderer(viewer, { camera: port });
  return viewer;
}
