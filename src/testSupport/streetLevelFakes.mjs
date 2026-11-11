/**
 * Shared Street Level test stand-ins: provider snapshot and provider,
 * Mapillary source, photo viewer, and the layer's display on the fake
 * engine or on the Cesium engine over a stub scene, with what each drew.
 */
import * as Cesium from 'cesium';
import * as geo from '../geo/index.js';
import { normalizeGroundSetOptions } from '../globe/ground.js';
import { createFakeEngine } from '../globe/testing/fakeEngine.js';
import { createFakeEventHandlers } from '../globe/cesium/testing/fakeViewer.mjs';
import { createCesiumMoversEngine } from './cesiumMoversEngine.mjs';
import { createStreetLevelDisplay } from '../layers/streetLevel/render/display.js';
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
 * What an engine's ground sets and mover sets were given, by id: the
 * options (with the contract's defaults), a ground set's committed items, a
 * mover set's committed instances (the fields of every set() before its
 * last commit), and whether each is still live.
 */
export function watchDrawing(engine) {
  const ground = new Map();
  const createGround = engine.ground.createSet.bind(engine.ground);
  engine.ground.createSet = (options) => {
    const set = createGround(options);
    const record = {
      id: options.id,
      options: normalizeGroundSetOptions(options),
      pending: [],
      items: [],
      commits: 0,
      live: true,
    };
    const { replace, commit, destroy } = set;
    set.replace = (items) => {
      replace(items);
      record.pending = items;
    };
    set.commit = () => {
      commit();
      record.items = record.pending;
      record.commits++;
    };
    set.destroy = () => {
      destroy();
      record.live = false;
    };
    ground.set(options.id, record);
    return set;
  };
  const movers = new Map();
  const createMovers = engine.movers.createSet.bind(engine.movers);
  engine.movers.createSet = (options) => {
    const set = createMovers(options);
    const record = {
      id: options.id,
      options,
      pending: [],
      count: 0,
      instances: [],
      commits: 0,
      live: true,
    };
    const { commit, destroy } = set;
    const write = set.set;
    const setCount = set.setCount;
    set.set = (index, fields) => {
      write(index, fields);
      record.pending[index] = { ...record.pending[index], ...fields };
    };
    set.setCount = (count) => {
      setCount(count);
      record.count = count;
    };
    set.commit = () => {
      commit();
      record.instances = record.pending.slice(0, record.count);
      record.commits++;
    };
    set.destroy = () => {
      destroy();
      record.live = false;
    };
    movers.set(options.id, record);
    return set;
  };
  const live = (records, prefix) =>
    [...records.values()].filter(
      (record) => record.live && record.id.startsWith(prefix),
    );
  return {
    /** Live ground sets whose id starts with `prefix`, in creation order. */
    groundSets: (prefix = '') => live(ground, prefix),
    /** Live mover sets whose id starts with `prefix`, in creation order. */
    moverSets: (prefix = '') => live(movers, prefix),
    /** Every corridor item drawn by live sets under `prefix`. */
    corridors: (prefix = '') =>
      live(ground, prefix).flatMap((record) => record.items),
    /** Every shown sprite instance drawn by live sets under `prefix`. */
    spritesShown: (prefix = '') =>
      live(movers, prefix).flatMap((record) =>
        record.instances.filter((instance) => instance.show !== false),
      ),
  };
}

/**
 * The fake engine as a pinhole camera `altitude` m above WGS84 at
 * `lon`/`lat`, turned to `heading` and `pitch` (degrees, negative down),
 * with a vertical field of view of `fovY` degrees.
 */
export function cameraEngine({
  lon,
  lat,
  altitude,
  heading = 0,
  pitch = -90,
  width = 1600,
  height = 900,
  fovY = 60,
}) {
  const engine = createFakeEngine({ width, height, fovy: fovY * RAD });
  engine.fake.setPose({
    longitude: lon * RAD,
    latitude: lat * RAD,
    height: altitude,
    heading: heading * RAD,
    pitch: pitch * RAD,
    roll: 0,
  });
  return engine;
}

/** Sacramento from 900 m, looking straight down, on a 100 px canvas. */
export const SACRAMENTO_VIEW = Object.freeze({
  lon: -121.4944,
  lat: 38.5816,
  altitude: 900,
  width: 100,
  height: 100,
});

/**
 * Cesium's flight bookkeeping on an engine: `started` counts framing
 * flights, `cancelled` the cancelFlight calls that stopped one, `list`
 * holds every flight asked for (`{ sphere, options }`), `land()` completes
 * the current one.
 */
function watchFlights(engine) {
  let flight = null;
  const flights = {
    started: 0,
    cancelled: 0,
    list: [],
    land() {
      const current = flight;
      flight = null;
      current?.options.complete?.();
    },
  };
  const stop = () => {
    const current = flight;
    flight = null;
    current?.options.cancel?.();
    return Boolean(current);
  };
  engine.camera.flyToSphere = (sphere, options = {}) => {
    stop();
    flight = { sphere, options };
    flights.list.push(flight);
    flights.started++;
  };
  engine.camera.cancelFlight = () => {
    if (stop()) flights.cancelled++;
  };
  return flights;
}

/**
 * The Street Level display on the fake engine (`view`: over Sacramento, so
 * coverage asks for tiles), with what it drew (watchDrawing), its credits'
 * HTML, flight bookkeeping and `frame()` (one engine frame: sprites paint
 * on preRender). `engine` replaces the fake one.
 */
export function streetLevelMap({ view = false, engine = null } = {}) {
  const globe =
    engine ?? (view ? cameraEngine(SACRAMENTO_VIEW) : createFakeEngine());
  const drawing = watchDrawing(globe);
  const flights = watchFlights(globe);
  const map = createStreetLevelDisplay(globe);
  return {
    engine: globe,
    map,
    flights,
    ...drawing,
    credits: () => (globe.fake?.credits ?? []).map((credit) => credit.html),
    frame: () => globe.fake.frame(),
    /** A click at `position`, with `picked` under it (undefined: the map). */
    click(picked, position = { x: 50, y: 50 }) {
      globe.fake.script('pick', picked);
      globe.fake.input('click', { position });
      globe.fake.unscript('pick');
    },
  };
}

/**
 * The Cesium engine over a real Cesium camera on a stub scene, with fake
 * ground primitives (they draw nothing) and fake billboards' atlas crops:
 * `frame()` runs a turn of Cesium's loop, `click(picked)` a left click with
 * `scene.pick` answering `picked` (a Cesium pick result or undefined).
 */
export function cesiumStreetLevelEngine({ width = 100, height = 100 } = {}) {
  const handlers = createFakeEventHandlers();
  const primitive = (type) => (options) => {
    const value = {
      type,
      options,
      ready: false,
      show: true,
      destroyed: false,
      destroy() {
        value.destroyed = true;
      },
      isDestroyed: () => value.destroyed,
    };
    return value;
  };
  const { engine, viewer, frame } = createCesiumMoversEngine({
    engineOptions: {
      createEventHandler: handlers.create,
      scheduleFrame: (run) => run(),
      groundFactories: { fills: primitive('fills'), lines: primitive('lines') },
    },
  });
  viewer.scene.groundPrimitives = new Cesium.PrimitiveCollection();
  viewer.scene.canvas.clientWidth = width;
  viewer.scene.canvas.clientHeight = height;
  let native;
  viewer.scene.pick = () => native;
  viewer.scene.drillPick = () => (native ? [native] : []);
  return {
    engine,
    viewer,
    frame,
    /** Poses the camera over `lon`/`lat` (degrees), looking straight down. */
    lookDown({ lon, lat, altitude }) {
      engine.camera.setView({
        destination: geo.cartesian3.fromDegrees(lon, lat, altitude),
      });
    },
    click(picked, position = { x: 50, y: 50 }) {
      native = picked;
      for (const handler of handlers.handlers)
        handler.fire(Cesium.ScreenSpaceEventType.LEFT_CLICK, {
          position: new Cesium.Cartesian2(position.x, position.y),
        });
      native = undefined;
    },
  };
}

/**
 * The Street Level display on the Cesium engine over a stub scene
 * (cesiumStreetLevelEngine), shaped as streetLevelMap's: over Sacramento
 * when `view`, the terrain at `terrain` m.
 */
export function cesiumStreetLevelMap({ view = true, terrain = 0 } = {}) {
  const cesium = cesiumStreetLevelEngine();
  cesium.viewer.scene.globe.getHeight = () => terrain;
  if (view) cesium.lookDown(SACRAMENTO_VIEW);
  const drawing = watchDrawing(cesium.engine);
  const flights = watchFlights(cesium.engine);
  const map = createStreetLevelDisplay(cesium.engine);
  return {
    name: 'the Cesium engine',
    engine: cesium.engine,
    viewer: cesium.viewer,
    map,
    flights,
    ...drawing,
    credits: () => [],
    frame: cesium.frame,
    click: cesium.click,
  };
}

/** The display on the fake engine over Sacramento. */
export const STREET_LEVEL_MAPS = Object.freeze([
  () => ({ name: 'the fake engine', ...streetLevelMap({ view: true }) }),
]);

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
 * The display on a fake engine looking straight down on a 0.004° square
 * around `view` (`{lon, lat, height}`, mutable: a change moves the camera),
 * enough for line coverage to attach, refresh and draw: its screen rays
 * land on that square at any height, as the old stand-in camera's did.
 * `moveEnd()` ends a camera move.
 */
export function coverageMap(start) {
  const engine = createFakeEngine({ width: 100, height: 100 });
  const at = { ...start };
  const pose = () =>
    engine.fake.setPose({
      longitude: at.lon * RAD,
      latitude: at.lat * RAD,
      height: at.height,
      heading: 0,
      pitch: -Math.PI / 2,
      roll: 0,
    });
  const view = new Proxy(at, {
    set(target, key, value) {
      target[key] = value;
      pose();
      return true;
    },
  });
  pose();
  engine.camera.pickRay = (point) => {
    const origin = geo.cartesian3.fromDegrees(at.lon, at.lat, at.height);
    const target = geo.cartesian3.fromDegrees(
      at.lon - 0.002 + (point.x / 100) * 0.004,
      at.lat + 0.002 - (point.y / 100) * 0.004,
    );
    const direction = geo.cartesian3.normalize(
      geo.cartesian3.subtract(target, origin, geo.cartesian3.create()),
      geo.cartesian3.create(),
    );
    return { origin, direction };
  };
  const harness = streetLevelMap({ engine });
  return {
    ...harness,
    view,
    moveEnd: () => engine.fake.emit('camera.moveEnd'),
  };
}
