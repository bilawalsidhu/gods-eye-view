/** Shared Street Level test stand-ins: Mapillary source, photo viewer, Cesium viewer, ray-casting camera. */
import * as Cesium from 'cesium';

const RAD = Math.PI / 180;

/**
 * A Mapillary source for the layer: a configured key, empty tiles, and the
 * given lookups; `calls` records tile requests.
 */
export function fakeMapillarySource(overrides = {}) {
  const calls = { tiles: [] };
  return {
    calls,
    hasToken: () => true,
    getStatus: async () => ({ configured: true }),
    getTile: async (...args) => {
      calls.tiles.push(args);
      return new Uint8Array(0);
    },
    getSequenceImages: async () => [],
    ...overrides,
  };
}

/**
 * A photo viewer in place of MapillaryJS: `calls` records use, and `open`
 * reports a pose for the image (when `pose` is given) as the real one does.
 */
export function fakePhotoViewer({ pose = null } = {}) {
  const calls = { mount: 0, open: [], unmount: 0 };
  let emit = null;
  return {
    calls,
    mount: async () => calls.mount++,
    async open(imageId) {
      calls.open.push(imageId);
      if (pose) emit?.({ imageId, ...pose });
    },
    close() {},
    unmount: () => calls.unmount++,
    resize() {},
    onPose(listener) {
      emit = listener;
      return () => {
        emit = null;
      };
    },
  };
}

/**
 * A stand-in Cesium viewer a layer can be enabled on: a canvas for the click
 * handler, camera events with Cesium's flight bookkeeping (`flights` counts
 * them, lists them and can `land` the current one), primitive lists and a
 * credit display. With `view`, the camera looks straight down on Sacramento
 * from 900 m, so coverage asks for tiles.
 */
export function fakeCesiumViewer({ view = false } = {}) {
  const credits = [];
  let flight = null;
  const flights = {
    started: 0,
    cancelled: 0,
    /** Every flight asked for, oldest first: `{ sphere, options }`. */
    list: [],
    land() {
      const current = flight;
      flight = null;
      current?.options.complete?.();
    },
  };
  const stopFlight = () => {
    const current = flight;
    flight = null;
    current?.options.cancel?.();
    return Boolean(current);
  };
  const canvas = Object.assign(new EventTarget(), {
    style: {},
    // Keep Cesium's handler on the canvas; there is no real document here.
    disableRootEvents: true,
    onwheel: null,
    ...(view ? { clientWidth: 100, clientHeight: 100 } : {}),
  });
  const camera = Object.assign(
    view
      ? rayCamera({
          lon: -121.4944,
          lat: 38.5816,
          altitude: 900,
          pitch: -90,
          width: 100,
          height: 100,
        })
      : {},
    {
      changed: new Cesium.Event(),
      moveStart: new Cesium.Event(),
      moveEnd: new Cesium.Event(),
      flyToBoundingSphere(sphere, options = {}) {
        stopFlight();
        flight = { sphere, options };
        flights.list.push(flight);
        flights.started++;
      },
      cancelFlight() {
        if (stopFlight()) flights.cancelled++;
      },
    },
  );
  return {
    credits,
    flights,
    scene: {
      canvas,
      primitives: { add: (p) => p, remove() {} },
      groundPrimitives: { add: (p) => p, remove() {} },
      // Enough of a scene for the position marker to clamp to the ground.
      frameState: { mode: Cesium.SceneMode.SCENE3D },
      updateHeight: () => () => {},
      getHeight: () => undefined,
    },
    camera,
    creditDisplay: {
      addStaticCredit: (credit) => credits.push(credit),
      removeStaticCredit: (credit) =>
        credits.splice(credits.indexOf(credit), 1),
    },
  };
}

/**
 * A pinhole camera `altitude` m above WGS84, at `heading` (deg from north) and
 * `pitch` (deg, negative down); `pickEllipsoid` hits whatever ellipsoid it gets.
 */
export function rayCamera({
  lon,
  lat,
  altitude,
  heading = 0,
  pitch,
  width = 1600,
  height = 900,
  fovY = 60,
  fovX = null,
}) {
  const position = Cesium.Cartesian3.fromDegrees(lon, lat, altitude);
  const frame = Cesium.Transforms.eastNorthUpToFixedFrame(position);
  const h = heading * RAD;
  const p = pitch * RAD;
  // East-north-up axes of the view: forward, right and up.
  const forward = [
    Math.sin(h) * Math.cos(p),
    Math.cos(h) * Math.cos(p),
    Math.sin(p),
  ];
  const right = [Math.cos(h), -Math.sin(h), 0];
  const up = [
    -Math.sin(h) * Math.sin(p),
    -Math.cos(h) * Math.sin(p),
    Math.cos(p),
  ];
  const halfY = Math.tan((fovY / 2) * RAD);
  const halfX =
    fovX == null ? halfY * (width / height) : Math.tan((fovX / 2) * RAD);
  return {
    positionWC: position,
    positionCartographic: Cesium.Cartographic.fromDegrees(lon, lat, altitude),
    pickEllipsoid(point, ellipsoid = Cesium.Ellipsoid.WGS84) {
      const sx = ((2 * point.x) / width - 1) * halfX;
      const sy = (1 - (2 * point.y) / height) * halfY;
      const local = [0, 1, 2].map(
        (i) => forward[i] + sx * right[i] + sy * up[i],
      );
      const direction = Cesium.Cartesian3.normalize(
        Cesium.Matrix4.multiplyByPointAsVector(
          frame,
          new Cesium.Cartesian3(...local),
          new Cesium.Cartesian3(),
        ),
        new Cesium.Cartesian3(),
      );
      const ray = new Cesium.Ray(position, direction);
      const hit = Cesium.IntersectionTests.rayEllipsoid(ray, ellipsoid);
      return hit ? Cesium.Ray.getPoint(ray, hit.start) : undefined;
    },
  };
}
