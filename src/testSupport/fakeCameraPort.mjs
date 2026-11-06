/**
 * A camera port for tests of code that reads the camera: a settable pose,
 * a settable view rectangle, and events the test raises itself.
 */
import { createCameraEvents } from '../render/camera/events.js';
import { toDegrees } from '../geo/index.js';
import { bindRenderer, rendererOf } from '../render/rendererOf.js';

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
 * Bind to a fake viewer a camera port that reads its Cesium-shaped fake
 * camera live (`positionCartographic`, `heading`, `pitch`, `roll`, and the
 * `changed`/`moveStart`/`moveEnd` events it has), for tests whose code
 * still moves that camera directly. Returns the viewer.
 * @template {{camera: object}} V
 * @param {V} viewer
 * @returns {V}
 */
export function bindFakeCesiumCamera(viewer) {
  if (rendererOf(viewer)) return viewer;
  const camera = viewer.camera;
  const port = {
    pose() {
      const c = camera.positionCartographic;
      return {
        ...DEFAULT_POSE,
        lon: c ? toDegrees(c.longitude) : NaN,
        lat: c ? toDegrees(c.latitude) : NaN,
        height: c ? c.height : NaN,
        heading: camera.heading ?? 0,
        pitch: camera.pitch ?? -Math.PI / 2,
        roll: camera.roll ?? 0,
      };
    },
    viewRectangle: () => null,
    on(event, cb) {
      const source = camera[event];
      const off = source?.addEventListener?.(cb);
      if (typeof off === 'function') return off;
      return () => source?.removeEventListener?.(cb);
    },
  };
  bindRenderer(viewer, { camera: port });
  return viewer;
}
