/** Shared Street Level test stand-ins: Mapillary source, photo viewer, ray-casting camera. */
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
