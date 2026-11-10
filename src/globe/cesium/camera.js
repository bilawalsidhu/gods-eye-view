// GlobeCamera on a Cesium camera. Geo values in, Cesium values into Cesium
// calls, fresh geo values out.

import * as Cesium from 'cesium';
import * as geo from '../../geo/index.js';
import { wrapAngle } from '../cameraMath.js';
import { bridgeEvent } from './events.js';
import { toCesium2, toCesium3, toGeo3 } from './convert.js';
import { createCesiumFollow } from './follow.js';

const easings = () => ({
  cubicInOut: Cesium.EasingFunction.CUBIC_IN_OUT,
  sinusoidalInOut: Cesium.EasingFunction.SINUSOIDAL_IN_OUT,
  linear: Cesium.EasingFunction.LINEAR_NONE,
});

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

const cesiumEasing = (easing) => (easing ? easings()[easing] : undefined);

let scratchBasis;

/**
 * Write a world direction and up (right = direction × up, up made
 * perpendicular) as the camera's basis, in its current reference frame.
 * Cesium's setView turns direction/up into heading/pitch/roll, which is
 * singular looking straight down: within about 2.6° of nadir it drops the
 * roll and reads the heading off `up`. The exact basis is what Cesium's own
 * rotate/look/move leave. A degenerate pair (up along direction) keeps
 * Cesium's result.
 */
function setBasis(cesium, direction, up) {
  scratchBasis ??= {
    direction: new Cesium.Cartesian3(),
    up: new Cesium.Cartesian3(),
    right: new Cesium.Cartesian3(),
  };
  const right = Cesium.Cartesian3.cross(direction, up, scratchBasis.right);
  const rightLength = Cesium.Cartesian3.magnitude(right);
  const directionLength = Cesium.Cartesian3.magnitude(direction);
  if (!(rightLength > 1e-12 * directionLength) || !Number.isFinite(rightLength))
    return;
  Cesium.Cartesian3.divideByScalar(right, rightLength, right);
  const forward = Cesium.Cartesian3.divideByScalar(
    direction,
    directionLength,
    scratchBasis.direction,
  );
  const upright = Cesium.Cartesian3.cross(right, forward, scratchBasis.up);
  const inverse = cesium.inverseTransform;
  Cesium.Matrix4.multiplyByPointAsVector(inverse, forward, cesium.direction);
  Cesium.Matrix4.multiplyByPointAsVector(inverse, upright, cesium.up);
  Cesium.Matrix4.multiplyByPointAsVector(inverse, right, cesium.right);
}

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
 * event has listeners (bridgeEvent) and then restore each method exactly
 * (unless something newer replaced it), so an idle engine leaves the camera
 * untouched.
 */
function commandedEvent(viewer, cesium) {
  return bridgeEvent({
    addEventListener(raise) {
      const removers = [];
      for (const name of COMMANDS) {
        const original = cesium[name];
        if (typeof original !== 'function') continue;
        const descriptor = Object.getOwnPropertyDescriptor(cesium, name);
        const wrapped = function (...args) {
          raise();
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
        raise(),
      );
      if (removeTracking) removers.push(removeTracking);
      return () => {
        for (const remove of removers) remove();
      };
    },
  });
}

/**
 * @param {Cesium.Viewer} viewer
 * @returns {{ camera: import('../contract.js').GlobeCamera, destroy: () => void }}
 */
export function createCesiumCamera(viewer) {
  const cesium = viewer.camera;
  const bridges = {
    changed: bridgeEvent(cesium.changed),
    moveStart: bridgeEvent(cesium.moveStart),
    moveEnd: bridgeEvent(cesium.moveEnd),
    commanded: commandedEvent(viewer, cesium),
  };
  // camera.follow: the viewer's trackedEntity (follow.js).
  const follow = createCesiumFollow(viewer, {
    commanded: bridges.commanded.event,
  });

  // The engine's own flight, so flightActive is exact even for flights that
  // completed synchronously (Cesium keeps no current flight for those).
  let flight = null;
  let completing = false;
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
        // Cesium's completeFlight removes the tween (its cancel) before it
        // lands the flight (its complete).
        if (!completing) options.cancel?.();
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
    setFovy(radians) {
      if (!Number.isFinite(radians) || radians <= 0 || radians >= Math.PI)
        throw new RangeError('Field of view must be between 0 and PI');
      const aspect = cesium.frustum.aspectRatio;
      cesium.frustum.fov =
        aspect > 1 ? 2 * Math.atan(Math.tan(radians / 2) * aspect) : radians;
      viewer.scene.requestRender();
    },
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
      const orientation = cesiumOrientation(view.orientation);
      // A view replaces a running flight, as on Navara (Cesium's own tween
      // would otherwise overwrite it on the next frame).
      if (flight || viewer.scene.tweens?.length > 0) {
        cesium.cancelFlight();
        flight = null;
      }
      cesium.setView({
        destination: cesiumDestination(view.destination),
        orientation,
      });
      if (orientation?.direction)
        setBasis(cesium, orientation.direction, orientation.up);
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
    // Also a flight started straight on viewer.camera (layers' flyTo and
    // flyToBoundingSphere): Cesium runs every camera flight as a scene tween.
    flightActive: () => flight != null || viewer.scene.tweens?.length > 0,
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
    completeFlight() {
      completing = true;
      try {
        cesium.completeFlight();
      } finally {
        completing = false;
      }
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
    ...follow.camera,
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
      follow.destroy();
      if (flight) camera.cancelFlight();
      for (const bridge of Object.values(bridges)) bridge.detach();
    },
  };
}
