// GlobeCamera on a Cesium camera. Geo values in, Cesium values into Cesium
// calls, fresh geo values out.

import * as Cesium from 'cesium';
import * as geo from '../../geo/index.js';
import { bridgeEvent } from './events.js';
import { toCesium2, toCesium3, toGeo3 } from './convert.js';

const { math } = geo;
const MINIMUM_SPHERE_RANGE = 100; // Cesium's MINIMUM_ZOOM for flyToBoundingSphere
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

// A HeadingPitchRange or a Cartesian offset, as Cesium's lookAt takes them.
const cesiumOffset = (offset) =>
  'heading' in offset
    ? new Cesium.HeadingPitchRange(offset.heading, offset.pitch, offset.range)
    : toCesium3(offset);

/**
 * @param {Cesium.Viewer} viewer
 * @returns {{ camera: import('../contract.js').GlobeCamera, destroy: () => void }}
 */
export function createCesiumCamera(viewer) {
  const cesium = viewer.scene.camera;
  const bridges = {
    changed: bridgeEvent(cesium.changed),
    moveStart: bridgeEvent(cesium.moveStart),
    moveEnd: bridgeEvent(cesium.moveEnd),
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
      };
    },
    setView(view) {
      if (!view?.destination)
        throw new TypeError('setView needs a destination');
      cesium.setView({
        destination: toCesium3(view.destination),
        orientation: cesiumOrientation(view.orientation),
      });
    },
    flyTo(options) {
      if (!options?.destination)
        throw new TypeError('flyTo needs a destination');
      startFlight(options, ({ complete, cancel }) =>
        cesium.flyTo({
          destination: toCesium3(options.destination),
          orientation: cesiumOrientation(options.orientation),
          duration: options.duration,
          easingFunction: options.easing ? EASINGS[options.easing] : undefined,
          complete,
          cancel,
        }),
      );
    },
    flyToSphere(sphere, options = {}) {
      let range = options.range;
      if (!range) {
        const { fovy, aspectRatio } = cesium.frustum;
        const tanPhi = Math.tan(fovy / 2);
        const tanTheta = aspectRatio * tanPhi;
        range = Math.max(
          MINIMUM_SPHERE_RANGE,
          sphere.radius / tanTheta,
          sphere.radius / tanPhi,
        );
      }
      startFlight(options, ({ complete, cancel }) =>
        cesium.flyToBoundingSphere(
          new Cesium.BoundingSphere(toCesium3(sphere.center), sphere.radius),
          {
            offset: new Cesium.HeadingPitchRange(
              options.heading ?? 0,
              options.pitch ?? -Math.PI / 4,
              range,
            ),
            duration: options.duration,
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
