/**
 * A camera port for tests of code that reads the camera: a settable pose,
 * a settable view rectangle, and events the test raises itself.
 */
import { createCameraEvents } from '../render/camera/events.js';
import { toDegrees } from '../geo/index.js';
import { bindRenderer, rendererOf } from '../render/rendererOf.js';
import { createCesiumCamera } from '../render/cesium/camera.js';
import { fakeCesiumCredits } from './fakeCreditsPort.mjs';
import { entityFollowTarget, followedOf } from '../data/followed.js';
import * as Cesium from 'cesium';

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
 * Cesium's entity tracking for a fake viewer without entities of its own:
 * the follow's helper entity is tracked here, at the fake clock's time.
 * @param {object} viewer
 */
function trackingWidget(viewer) {
  const entities = new Cesium.EntityCollection();
  const trackedEntityChanged = new Cesium.Event();
  let tracked;
  return {
    entities,
    clock: {
      get currentTime() {
        return viewer.clock?.currentTime ?? Cesium.JulianDate.now();
      },
    },
    get trackedEntity() {
      return tracked;
    },
    set trackedEntity(entity) {
      if (entity === tracked) return;
      tracked = entity;
      trackedEntityChanged.raiseEvent(entity);
    },
    trackedEntityChanged,
    isDestroyed: () => false,
  };
}

/**
 * Follow `entity` through `viewer`'s camera port as a layer does
 * (`entityFollowTarget`), at its own position; null stops following.
 * Returns the target followed.
 * @param {object} viewer
 * @param {object|null} entity
 */
export function followEntity(viewer, entity) {
  const camera = rendererOf(viewer).camera;
  if (!entity) {
    camera.follow(null);
    return null;
  }
  const target = entityFollowTarget(entity, {
    position: () => entity.position?.getValue?.() ?? null,
    frame: 'enu',
    viewFrom: { x: 0, y: -1000, z: 500 },
  });
  camera.follow(target);
  return target;
}

/** The entity `viewer`'s camera follows (`followEntity`), if any. */
export function followedEntity(viewer) {
  return followedOf(viewer)?.entity;
}

/**
 * Bind to a fake viewer the Cesium renderer's own camera port over its
 * Cesium-shaped fake camera, for tests whose code is half on the port: the
 * port's commands reach the fake camera as the renderer maps them
 * (`flyTo({destination: Cartesian3, ...})`), while poses are read leniently
 * from what the fake has (`positionCartographic`, `heading`, `pitch`,
 * `roll`, the frustum's `fovy`, `aspectRatio`, `near` and `far`) and events come from the fake's own `changed`, `moveStart` and
 * `moveEnd`. A fake with `trackedEntityChanged` and `entities` follows
 * through the port, as the renderer does. Its credits are the renderer's
 * credits port over the fake's `creditDisplay`, if it has one; `ports`
 * adds other ports (a fake draw port, say). The renderer's `canvas` is the
 * fake viewer's (`canvas`, else `scene.canvas`). Binding a viewer twice keeps the
 * first. Returns the viewer.
 * @template {{camera: object}} V
 * @param {V} viewer
 * @param {object} [ports]
 * @returns {V}
 */
export function bindFakeCesiumCamera(viewer, ports = {}) {
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
  // The port places a view by direction and up on the camera's own vectors;
  // a fake without them gets scratch ones, and the view is handed to its
  // `setView` as Cesium's setView would have had it.
  const placesOnSetView = !('position' in fake) && Boolean(fake.setView);
  const placed = placesOnSetView
    ? { position: {}, direction: {}, up: {}, right: {} }
    : null;
  const camera = new Proxy(fake, {
    get(target, key, receiver) {
      if (placed && Object.hasOwn(placed, key)) return placed[key];
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
    preUpdate: viewer.scene?.preUpdate ?? noEvent,
    get screenSpaceCameraController() {
      return viewer.scene?.screenSpaceCameraController ?? undefined;
    },
    requestRender: () => viewer.scene?.requestRender?.(),
  };
  // A fake with Cesium's entity tracking follows as the renderer does: on
  // its own entities, or, where it only answers `contains`, on a tracking
  // widget of its own over the fake's clock.
  const tracks = Boolean(viewer.trackedEntityChanged && viewer.entities);
  const widget =
    tracks && typeof viewer.entities.add !== 'function'
      ? trackingWidget(viewer)
      : viewer;
  const made = createCesiumCamera({
    scene,
    camera,
    ...(tracks ? { widget } : {}),
    report: (error) => {
      throw error;
    },
  });
  const real = made.port;
  // The fake's own moveStart and moveEnd, which a test raises, are the
  // port's: with no ticks, the port measures no moves of its own.
  for (const event of ['moveStart', 'moveEnd'])
    fake[event]?.addEventListener?.(() => made.emit(event));
  const port = Object.create(real, {
    pose: {
      value() {
        const c = fake.positionCartographic;
        const p = fake.positionWC;
        const v = (w) => ({ x: w.x, y: w.y, z: w.z });
        return {
          ...DEFAULT_POSE,
          ...(p ? { position: v(p) } : {}),
          ...(fake.directionWC ? { direction: v(fake.directionWC) } : {}),
          ...(fake.upWC ? { up: v(fake.upWC) } : {}),
          ...(fake.rightWC ? { right: v(fake.rightWC) } : {}),
          ...(Number.isFinite(fake.frustum?.fovy)
            ? { fovy: fake.frustum.fovy }
            : {}),
          ...(Number.isFinite(fake.frustum?.aspectRatio)
            ? { aspectRatio: fake.frustum.aspectRatio }
            : {}),
          ...(typeof fake.frustum?.near === 'number'
            ? { near: fake.frustum.near }
            : {}),
          ...(typeof fake.frustum?.far === 'number'
            ? { far: fake.frustum.far }
            : {}),
          lon: c ? toDegrees(c.longitude) : NaN,
          lat: c ? toDegrees(c.latitude) : NaN,
          height: c ? c.height : NaN,
          heading: fake.heading ?? 0,
          pitch: fake.pitch ?? -Math.PI / 2,
          roll: fake.roll ?? 0,
        };
      },
    },
    setView: {
      value(spec) {
        real.setView(spec);
        const o = spec?.orientation;
        if (placed && spec?.destination && o && 'direction' in o)
          fake.setView({
            destination: { ...placed.position },
            orientation: {
              direction: { ...placed.direction },
              up: { ...placed.up },
            },
          });
      },
    },
    // A fake that computes a view rectangle answers with it, as the
    // renderer does; one that does not has none.
    viewRectangle: {
      value: () => (fake.computeViewRectangle ? real.viewRectangle() : null),
    },
    on: {
      value(event, cb, options) {
        // What the port itself raises (a follow's change) comes from it.
        if (event === 'followChanged') return real.on(event, cb, options);
        const source = fake[event];
        const off = source?.addEventListener?.(cb);
        if (typeof off === 'function') return off;
        return () => source?.removeEventListener?.(cb);
      },
    },
  });
  bindRenderer(viewer, {
    // The renderer's canvas is the fake's, as the Cesium renderer's is the
    // viewer's: read when asked, so a fake that swaps its canvas is seen.
    get canvas() {
      return viewer.canvas ?? viewer.scene?.canvas;
    },
    ...ports,
    camera: port,
    credits: fakeCesiumCredits(viewer),
  });
  return viewer;
}
