/** Shared Street Level test stand-ins: provider snapshot, minimal provider, ray-casting camera. */
import * as Cesium from 'cesium';
import { MAPILLARY_CREDIT_HTML } from '../layers/streetLevel/providers/mapillary/policy.js';

const RAD = Math.PI / 180;

/** One provider as `getUIState().providers` lists it. */
export function providerSnapshot(overrides = {}) {
  return {
    id: 'mapillary',
    name: 'Mapillary',
    label: 'MAPILLARY',
    on: true,
    configured: true,
    keyRequired: false,
    requiresKeyId: 'mapillary',
    loading: false,
    count: 0,
    hint: '',
    error: null,
    color: '#05cb63',
    ...overrides,
  };
}

/**
 * The smallest provider the core accepts. Mutate `stats` to change what
 * coverageStats() answers; `calls`, `filters` and `context()` record use.
 */
export function fakeStreetLevelProvider({
  id = 'mapillary',
  pickPrefix = 'mly:',
  html = MAPILLARY_CREDIT_HTML,
  nearestImage = async () => null,
} = {}) {
  const calls = { activate: 0, deactivate: 0, mount: 0, open: [], unmount: 0 };
  const filters = [];
  const stats = {
    count: 0,
    zoom: null,
    kind: null,
    loading: false,
    hint: '',
    error: null,
    keyRequired: false,
  };
  let context = null;
  return {
    calls,
    filters,
    stats,
    context: () => context,
    id,
    name: 'Mapillary',
    label: 'MAPILLARY',
    requiresKeyId: null,
    pickPrefix,
    colors: { coverage: '#05cb63' },
    credit: { html },
    create: (providerContext) => {
      context = providerContext;
      return {
        status: async () => ({ configured: true }),
        init() {},
        activate: () => calls.activate++,
        deactivate: () => calls.deactivate++,
        destroy() {},
        refreshCoverage() {},
        setFilter: (filter) => filters.push(filter),
        coverageStats: () => ({ ...stats }),
        handlePick: () => false,
        nearestImage,
        viewer: {
          mount: async () => calls.mount++,
          open: async (imageId) => calls.open.push(imageId),
          close() {},
          unmount: () => calls.unmount++,
          resize() {},
          onPose: () => () => {},
        },
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
    computeViewRectangle: () => undefined,
  };
}
