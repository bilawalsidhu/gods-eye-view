/** Shared Street Level test stand-ins: provider snapshot and provider, Mapillary source, photo viewer, Cesium viewer, ray-casting camera. */
import * as Cesium from 'cesium';
import { bindFakeCesiumCamera } from './fakeCameraPort.mjs';
import { fakeDrawPort } from './fakeDrawPort.mjs';
import { bindRenderer } from '../render/rendererOf.js';
import { MAPILLARY_CREDIT_HTML } from '../layers/streetLevel/providers/mapillary/policy.js';
import {
  latToTileY,
  lonToTileX,
  tileBounds,
} from '../layers/streetLevel/tileMath.js';

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
 * A Mapillary source for the provider: a configured key, empty tiles, and the
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
    nearestImages: async () => [],
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
  const viewer = {
    credits,
    flights,
    scene: {
      canvas,
    },
    camera,
    creditDisplay: {
      // The renderer's own CesiumJS credit aside.
      addStaticCredit: (credit) =>
        credit.html.includes('CesiumJS') || credits.push(credit),
      removeStaticCredit: (credit) => {
        // Cesium ignores a credit it does not hold.
        const at = credits.indexOf(credit);
        if (at !== -1) credits.splice(at, 1);
      },
    },
  };
  return bindFakeCesiumCamera(viewer, streetPorts(viewer));
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
  /** The ray through a screen point, as the query port's `pickRay`. */
  function pickRay(x, y) {
    const sx = ((2 * x) / width - 1) * halfX;
    const sy = (1 - (2 * y) / height) * halfY;
    const local = [0, 1, 2].map((i) => forward[i] + sx * right[i] + sy * up[i]);
    const direction = Cesium.Cartesian3.normalize(
      Cesium.Matrix4.multiplyByPointAsVector(
        frame,
        new Cesium.Cartesian3(...local),
        new Cesium.Cartesian3(),
      ),
      new Cesium.Cartesian3(),
    );
    return { origin: position, direction };
  }
  return {
    positionWC: position,
    positionCartographic: Cesium.Cartographic.fromDegrees(lon, lat, altitude),
    pickRay,
    pickEllipsoid(point, ellipsoid = Cesium.Ellipsoid.WGS84) {
      const { direction } = pickRay(point.x, point.y);
      const ray = new Cesium.Ray(position, direction);
      const hit = Cesium.IntersectionTests.rayEllipsoid(ray, ellipsoid);
      return hit ? Cesium.Ray.getPoint(ray, hit.start) : undefined;
    },
  };
}

/**
 * The query, frame and canvas a Street Level layer reads, answered from a
 * Cesium-shaped viewer double: rays from its camera's `pickRay` (else
 * through what its `pickEllipsoid` hits), heights from its scene's
 * `sampleHeight` (3D tiles: only while its globe is hidden) and its
 * globe's `getHeight` (terrain), and pre-render from its scene's
 * `preRender`; positions under a screen point from its scene's
 * `pickPosition` (when `pickPositionSupported`) and its camera's
 * `pickEllipsoid`; drawing goes to `draw` (a fake draw port by default), and
 * with `camera` the camera is `liveCamera`'s. For `bindFakeCesiumCamera`'s
 * `ports`, or `bindRenderer`.
 * @param {object} viewer
 * @param {{draw?: object}} [options]
 */
export function streetPorts(
  viewer,
  { draw = fakeDrawPort(), camera = false } = {},
) {
  const finite = (height) => (Number.isFinite(height) ? height : null);
  const cartographic = ({ lon, lat }) => ({
    longitude: lon * RAD,
    latitude: lat * RAD,
    height: 0,
  });
  return {
    get canvas() {
      return viewer.scene?.canvas;
    },
    query: {
      pickRay(x, y) {
        const camera = viewer.camera ?? {};
        if (camera.pickRay) return camera.pickRay(x, y);
        const hit = camera.pickEllipsoid?.({ x, y });
        const origin = camera.positionWC;
        if (!hit || !origin) return null;
        const direction = Cesium.Cartesian3.normalize(
          Cesium.Cartesian3.subtract(hit, origin, new Cesium.Cartesian3()),
          new Cesium.Cartesian3(),
        );
        return { origin, direction };
      },
      pickPosition(x, y) {
        const scene = viewer.scene ?? {};
        if (!scene.pickPositionSupported) return null;
        return scene.pickPosition?.({ x, y }) ?? null;
      },
      pickEllipsoid(x, y) {
        return viewer.camera?.pickEllipsoid?.({ x, y }) ?? null;
      },
      sampleHeightNow(point, { against = 'surface' } = {}) {
        const scene = viewer.scene ?? {};
        if (against === 'terrain')
          return finite(scene.globe?.getHeight?.(cartographic(point)));
        if (!scene.sampleHeightSupported) return null;
        if (against === 'tiles' && scene.globe?.show !== false) return null;
        return finite(scene.sampleHeight?.(cartographic(point)));
      },
    },
    frame: {
      on(phase, cb) {
        const event = viewer.scene?.[phase];
        return event?.addEventListener?.(cb) ?? (() => {});
      },
    },
    draw,
    ...(camera ? { camera: liveCamera(viewer) } : {}),
  };
}

/**
 * Bind `viewer` (a Cesium-shaped double) to `streetPorts` with its live
 * camera, as the app binds its renderer; `draw` is the draw port it draws
 * through (a fake one by default). Returns the viewer.
 * @template V
 * @param {V} viewer
 * @param {{draw?: object}} [options]
 * @returns {V}
 */
export function bindStreetViewer(viewer, { draw } = {}) {
  bindRenderer(
    viewer,
    streetPorts(viewer, { camera: true, ...(draw ? { draw } : {}) }),
  );
  return viewer;
}

/**
 * A camera port over whatever camera double `viewer.camera` is when asked
 * (tests swap it): its pose from `positionCartographic` and `positionWC`,
 * its events from the double's own `changed` and `moveEnd`.
 */
export function liveCamera(viewer) {
  return {
    pose() {
      const camera = viewer.camera ?? {};
      const p = camera.positionWC;
      const c =
        camera.positionCartographic ??
        (p && Cesium.Cartographic.fromCartesian(p));
      return {
        lon: c ? c.longitude / RAD : NaN,
        lat: c ? c.latitude / RAD : NaN,
        height: c ? c.height : NaN,
        position: p ? { x: p.x, y: p.y, z: p.z } : null,
      };
    },
    on(event, cb) {
      return viewer.camera?.[event]?.addEventListener?.(cb) ?? (() => {});
    },
  };
}

/** The centre of the tile holding a point at zoom `z`, so a small view is one tile. */
export function tileCentre(lon, lat, z = 14) {
  const x = lonToTileX(lon, z);
  const y = latToTileY(lat, z);
  const { west, east, south, north } = tileBounds(x, y, z);
  return {
    tile: { x, y, z },
    lon: (west + east) / 2,
    lat: (south + north) / 2,
  };
}

/**
 * A viewer looking straight down on a 0.004° square around `view`
 * (`{lon, lat, height}`, mutable), enough for line coverage to attach,
 * refresh and draw, on a fake draw port (`viewer.draw`; `drawnLineSets`
 * lists what it draws).
 */
export function coverageViewer(view) {
  const listeners = () => {
    const set = new Set();
    return {
      set,
      addEventListener(listener) {
        set.add(listener);
        return () => set.delete(listener);
      },
    };
  };
  const viewer = {
    view,
    scene: {
      canvas: { clientWidth: 100, clientHeight: 100 },
      globe: { show: false, ellipsoid: Cesium.Ellipsoid.WGS84 },
      postRender: listeners(),
      preRender: listeners(),
    },
    camera: {
      changed: new Cesium.Event(),
      moveEnd: new Cesium.Event(),
      get positionWC() {
        return Cesium.Cartesian3.fromDegrees(view.lon, view.lat, view.height);
      },
      get positionCartographic() {
        return {
          longitude: view.lon * RAD,
          latitude: view.lat * RAD,
          height: view.height,
        };
      },
      pickEllipsoid(point) {
        return Cesium.Cartesian3.fromDegrees(
          view.lon - 0.002 + (point.x / 100) * 0.004,
          view.lat + 0.002 - (point.y / 100) * 0.004,
        );
      },
      computeViewRectangle: () => undefined,
    },
  };
  viewer.draw = fakeDrawPort();
  return bindFakeCesiumCamera(
    viewer,
    streetPorts(viewer, { draw: viewer.draw }),
  );
}

/**
 * The live Street Level line sets on `viewer.draw`, oldest (drawn lowest)
 * first: those with lines in them, or with `empty` every one.
 */
export function drawnLineSets(viewer, { empty = false } = {}) {
  return [...viewer.draw.sets.values()].filter(
    (set) =>
      !set.disposed &&
      set.kind === 'lines' &&
      set.spec.id.startsWith('street-level:') &&
      (empty || set.items.size > 0),
  );
}
