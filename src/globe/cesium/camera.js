// GlobeCamera on a Cesium camera. Geo values in, Cesium values into Cesium
// calls, fresh geo values out.

import * as Cesium from 'cesium';
import * as geo from '../../geo/index.js';
import { createEngineEvent } from '../contract.js';
import { bridgeEvent } from './events.js';
import { toCesium2, toCesium3, toGeo3 } from './convert.js';

const { math } = geo;
const EASINGS = {
  cubicInOut: Cesium.EasingFunction.CUBIC_IN_OUT,
  sinusoidalInOut: Cesium.EasingFunction.SINUSOIDAL_IN_OUT,
  linear: Cesium.EasingFunction.LINEAR_NONE,
};

// Cesium reports heading and roll in [0, 2π]; the contract wants [0, 2π).
function wrapAngle(angle) {
  const value = math.zeroToTwoPi(angle);
  return value < 1e-12 || math.TWO_PI - value < 1e-12 ? 0 : value;
}

function cesiumOrientation(orientation) {
  if (!orientation) return undefined;
  if (orientation.direction)
    return {
      direction: toCesium3(orientation.direction),
      up: toCesium3(orientation.up),
    };
  const { heading, pitch, roll } = orientation;
  return { heading, pitch, roll };
}

// A Cartesian3, or a {west, south, east, north} rectangle in radians.
const cesiumDestination = (destination) =>
  'west' in destination
    ? new Cesium.Rectangle(
        destination.west,
        destination.south,
        destination.east,
        destination.north,
      )
    : toCesium3(destination);

const cesiumEasing = (easing) => (easing ? EASINGS[easing] : undefined);

// A HeadingPitchRange or a Cartesian offset, as Cesium's lookAt takes them.
const cesiumOffset = (offset) =>
  'heading' in offset
    ? new Cesium.HeadingPitchRange(offset.heading, offset.pitch, offset.range)
    : toCesium3(offset);

// The Cesium camera entry points that hand the camera to a new owner. The
// viewer's camera is shared with code that still calls Cesium directly
// (layers, cockpit), so `commanded` hooks these methods themselves.
const COMMANDS = Object.freeze([
  'flyTo',
  'flyToBoundingSphere',
  'setView',
  'lookAt',
  'cancelFlight',
]);

/**
 * camera.commanded: raised before any COMMANDS call on the Cesium camera and
 * when the viewer's tracked entity changes. The hooks exist only while the
 * event has listeners and then restore each method exactly (unless something
 * newer replaced it), so an idle engine leaves the camera untouched.
 */
function commandedEvent(viewer, cesium) {
  const event = createEngineEvent();
  let unhook = null;
  const hook = () => {
    const removers = [];
    for (const name of COMMANDS) {
      const original = cesium[name];
      if (typeof original !== 'function') continue;
      const descriptor = Object.getOwnPropertyDescriptor(cesium, name);
      const wrapped = function (...args) {
        event.raiseEvent();
        return original.apply(this, args);
      };
      cesium[name] = wrapped;
      removers.push(() => {
        if (cesium[name] !== wrapped) return;
        if (descriptor) Object.defineProperty(cesium, name, descriptor);
        else delete cesium[name];
      });
    }
    const removeTracking = viewer.trackedEntityChanged?.addEventListener(() =>
      event.raiseEvent(),
    );
    if (removeTracking) removers.push(removeTracking);
    return () => {
      for (const remove of removers) remove();
    };
  };
  let detached = false;
  const sync = () => {
    const wanted = !detached && event.numberOfListeners > 0;
    if (wanted === (unhook !== null)) return;
    if (wanted) unhook = hook();
    else {
      const remove = unhook;
      unhook = null;
      remove();
    }
  };
  const add = event.addEventListener;
  const remove = event.removeEventListener;
  event.addEventListener = (listener) => {
    const removeListener = add(listener);
    sync();
    return () => {
      removeListener();
      sync();
    };
  };
  event.removeEventListener = (listener) => {
    const removed = remove(listener);
    sync();
    return removed;
  };
  return {
    event,
    detach() {
      detached = true;
      sync();
    },
  };
}

/**
 * @param {Cesium.Viewer} viewer
 * @returns {{ camera: import('../contract.js').GlobeCamera, destroy: () => void }}
 */
export function createCesiumCamera(viewer) {
  // Viewer.camera is scene.camera; the public alias is what shell callers read.
  const cesium = viewer.camera ?? viewer.scene.camera;
  const bridges = {
    changed: bridgeEvent(cesium.changed),
    moveStart: bridgeEvent(cesium.moveStart),
    moveEnd: bridgeEvent(cesium.moveEnd),
    commanded: commandedEvent(viewer, cesium),
  };

  // The engine's own flight, so flightActive is exact even for flights that
  // completed synchronously (Cesium keeps no current flight for those).
  let flight = null;
  function trackFlight(options) {
    const token = {};
    flight = token;
    const end = () => {
      if (flight === token) flight = null;
    };
    return {
      end,
      complete: () => {
        end();
        options.complete?.();
      },
      cancel: () => {
        end();
        options.cancel?.();
      },
    };
  }
  function startFlight(options, start) {
    const tracked = trackFlight(options);
    try {
      start(tracked);
    } catch (error) {
      tracked.end();
      throw error;
    }
  }

  const camera = {
    pose() {
      const position = toGeo3(cesium.positionWC);
      return {
        position,
        cartographic: geo.cartographic.fromCartesian(
          position,
          geo.ellipsoid.WGS84,
        ),
        heading: wrapAngle(cesium.heading),
        pitch: cesium.pitch,
        roll: wrapAngle(cesium.roll),
        direction: toGeo3(cesium.directionWC),
        up: toGeo3(cesium.upWC),
        right: toGeo3(cesium.rightWC),
        fovy: cesium.frustum.fovy,
        aspectRatio: cesium.frustum.aspectRatio,
      };
    },
    // Cesium updates positionWC in place; it is the live object.
    get livePosition() {
      return cesium.positionWC;
    },
    height: () => cesium.positionCartographic.height,
    setView(view) {
      if (!view?.destination)
        throw new TypeError('setView needs a destination');
      cesium.setView({
        destination: cesiumDestination(view.destination),
        orientation: cesiumOrientation(view.orientation),
      });
    },
    flyTo(options) {
      if (!options?.destination)
        throw new TypeError('flyTo needs a destination');
      startFlight(options, ({ complete, cancel }) =>
        cesium.flyTo({
          destination: cesiumDestination(options.destination),
          orientation: cesiumOrientation(options.orientation),
          duration: options.duration,
          easingFunction: cesiumEasing(options.easing),
          endTransform: options.endTransform
            ? Cesium.Matrix4.fromArray(options.endTransform)
            : undefined,
          complete,
          cancel,
        }),
      );
    },
    flyToSphere(sphere, options = {}) {
      // A missing or 0 range is Cesium's own: it fits the sphere in view and
      // clamps to the camera controller's zoom distances.
      startFlight(options, ({ complete, cancel }) =>
        cesium.flyToBoundingSphere(
          new Cesium.BoundingSphere(toCesium3(sphere.center), sphere.radius),
          {
            offset: new Cesium.HeadingPitchRange(
              options.heading ?? 0,
              options.pitch ?? -Math.PI / 4,
              options.range ?? 0,
            ),
            duration: options.duration,
            easingFunction: cesiumEasing(options.easing),
            complete,
            cancel,
          },
        ),
      );
    },
    flightActive: () => flight != null,
    lookAt(target, offset) {
      cesium.lookAt(toCesium3(target), cesiumOffset(offset));
    },
    lookAtTransform(transform, offset) {
      const matrix = Cesium.Matrix4.fromArray(transform);
      if (offset) cesium.lookAtTransform(matrix, cesiumOffset(offset));
      else cesium.lookAtTransform(matrix);
    },
    transform: () => Cesium.Matrix4.toArray(cesium.transform),
    release() {
      cesium.lookAtTransform(Cesium.Matrix4.IDENTITY);
    },
    cancelFlight() {
      cesium.cancelFlight();
      flight = null;
    },
    zoomIn(amount = cesium.defaultZoomAmount) {
      cesium.zoomIn(amount);
    },
    zoomOut(amount = cesium.defaultZoomAmount) {
      cesium.zoomOut(amount);
    },
    viewRectangle() {
      const rectangle = cesium.computeViewRectangle(Cesium.Ellipsoid.WGS84);
      if (!rectangle) return undefined;
      const { west, south, east, north } = rectangle;
      return { west, south, east, north };
    },
    pickEllipsoid(screen) {
      return toGeo3(
        cesium.pickEllipsoid(toCesium2(screen), Cesium.Ellipsoid.WGS84),
      );
    },
    pickRay(screen) {
      const ray = cesium.getPickRay(toCesium2(screen));
      if (!ray) return undefined;
      return { origin: toGeo3(ray.origin), direction: toGeo3(ray.direction) };
    },
    changed: bridges.changed.event,
    moveStart: bridges.moveStart.event,
    moveEnd: bridges.moveEnd.event,
    commanded: bridges.commanded.event,
    get percentageChanged() {
      return cesium.percentageChanged;
    },
    set percentageChanged(value) {
      cesium.percentageChanged = value;
    },
  };

  return {
    camera,
    destroy() {
      if (flight) camera.cancelFlight();
      for (const bridge of Object.values(bridges)) bridge.detach();
    },
  };
}
