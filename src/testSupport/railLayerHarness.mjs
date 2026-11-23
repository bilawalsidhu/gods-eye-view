// A Rail layer on a scene host bound to fake renderer ports (draw, camera,
// frame, globe, query, input), a scripted proxy and fake camera services
// that record what the layer asks of the camera. Shared by the Rail layer's
// tests that run a whole layer (camera follow, live-only feeds, ground
// height, layer stats, selected route lines).
import { createRailLayer } from '../layers/rail/index.js';
import { fromDegrees } from '../geo/ellipsoid.js';
import { eastNorthUp } from '../geo/frames.js';
import { scale } from '../geo/vector.js';
import { bindRenderer } from '../render/rendererOf.js';
import { fakeDrawPort } from './fakeDrawPort.mjs';
import { layerPlacement } from '../data/placementProvider.js';
import { CAMERA_DEBOUNCE_MS } from '../layers/rail/policy.js';
import { WORLD_FOCUS_FRAMING } from '../worldFocus.js';
import { publicRailCatalog } from '../data/railFeeds.js';

/** The tests' wall clock at the start: 2026-09-10T00:26:40Z. */
export const RAIL_HARNESS_T0 = 1_789_000_000_000;
export const BOSTON = Object.freeze({ lat: 42.3601, lon: -71.0589 });

/** A train as the rail proxy sends it. */
export function railTrain(id, lat, lon, extra = {}) {
  return {
    id,
    lat,
    lon,
    bearing: null,
    speedMps: null,
    timestamp: Math.floor(Date.now() / 1000),
    timestampSource: 'vehicle',
    routeId: 'R1',
    tripId: `trip-${id}`,
    label: id,
    category: 'regional',
    mode: 'rail',
    positionSource: 'gps',
    ...extra,
  };
}

/** A canvas good enough for the sprite drawing: every 2D call is a no-op. */
function fakeCanvas() {
  const context = new Proxy(
    {},
    {
      get: (target, key) => (key in target ? target[key] : () => {}),
      set: (target, key, value) => {
        target[key] = value;
        return true;
      },
    },
  );
  return { width: 0, height: 0, getContext: () => context };
}

const headersOf = (values = {}) => ({
  get: (name) => values[String(name).toLowerCase()] ?? null,
});

/**
 * The harness. `feeds` scripts each feed's live answer, one call per poll:
 * an array of trains (200), `{positions: 'schedule'}` (a 200 answer with
 * no live positions, which the layer must not draw), `{status, backoff?, retryInSec?}` (a failure as the proxy
 * answers it), or nothing (502). `schedules` holds the schedule packs the
 * proxy serves for stop labels (404 otherwise).
 * `requested`, `requestedSchedules` and `requestedPaths` list the feed ids
 * asked for, in order.
 * @param {import('node:test').TestContext} t
 * @param {{at?: {lat: number, lon: number}, altitude?: number,
 *   catalog?: object[]|Promise<object[]>|Function|false,
 *   ground?: object,
 *   stops?: object|null, scheduleStops?: boolean,
 *   paths?: Record<string, object>|null, fleet?: object|null,
 *   placement?: object|null}} [options]
 *   `ground`: a floor service in place of the always-cold stub; `catalog`:
 *   the server's feed catalog (it may list fewer feeds than are bundled; a
 *   promise answers when it settles, a function is called per request and
 *   answers so); without it, a server with every pack built (all enabled
 *   feeds); `false` for a source with no catalog at all;
 *   `stops`: a stops provider (none by default); `scheduleStops`: the
 *   layer's own provider, its schedule tier, in its place;
 *   `paths`: feed id → the path pack the proxy serves, or a
 *   failure status it answers with (404 for any other feed; without it the
 *   source has no path route at all); `fleet`: the fleet-model services
 *   (testSupport/fleetModelFakes.mjs), with a camera that looks straight
 *   down for them (none by default: trains stay icons); `placement`: a
 *   host-supplied placement provider (../data/placementProvider.js).
 */
/** The frame of an eye over `view`'s place looking straight down. */
function lookingDown(view) {
  const enu = eastNorthUp(fromDegrees(view.lon, view.lat, 0));
  return { direction: scale(enu.z, -1), up: enu.y, right: enu.x };
}

export function railLayerHarness(
  t,
  {
    at = BOSTON,
    altitude = 20_000,
    catalog = undefined,
    ground = null,
    stops = null,
    scheduleStops = false,
    paths = null,
    fleet = null,
    placement = null,
  } = {},
) {
  const T0 = RAIL_HARNESS_T0;
  t.mock.timers.enable({
    apis: ['Date', 'setTimeout', 'setInterval'],
    now: T0,
  });
  t.mock.method(performance, 'now', () => Date.now() - T0);
  for (const name of [
    'HTMLCanvasElement',
    'HTMLImageElement',
    'ImageBitmap',
    'OffscreenCanvas',
  ]) {
    const prior = globalThis[name];
    globalThis[name] = class {};
    t.after(() => {
      if (prior === undefined) delete globalThis[name];
      else globalThis[name] = prior;
    });
  }
  const originalDocument = globalThis.document;
  const originalWindow = globalThis.window;
  globalThis.document = Object.assign(new EventTarget(), {
    visibilityState: 'visible',
    documentElement: { dataset: {} },
    createElement: () => fakeCanvas(),
  });
  globalThis.window = new EventTarget();
  // The layer logs its feeds and catalog.
  t.mock.method(console, 'info', () => {});
  t.mock.method(console, 'log', () => {});

  // `position` (ECEF), when set, is where the eye stands in place of the
  // point `altitude` metres over `lat`, `lon`.
  const view = { lat: at.lat, lon: at.lon, altitude, heading: 0 };
  const listeners = (names) =>
    Object.fromEntries(names.map((name) => [name, new Set()]));
  const cameraEvents = listeners(['changed', 'followChanged']);
  const frameEvents = listeners(['preUpdate', 'preRender', 'postRender']);
  const raise = (set, arg) => {
    for (const cb of [...set]) cb(arg);
  };
  let followed = null;
  /** Every target the camera was told to follow, in order. */
  const follows = [];
  const camera = {
    flightsCancelled: 0,
    pose: () => ({
      lon: view.lon,
      lat: view.lat,
      height: view.altitude,
      heading: view.heading,
      pitch: -Math.PI / 2,
      roll: 0,
      position: view.position
        ? { ...view.position }
        : fromDegrees(view.lon, view.lat, view.altitude),
      ...(fleet
        ? lookingDown(view)
        : {
            direction: { x: 0, y: 0, z: -1 },
            up: { x: 0, y: 1, z: 0 },
            right: { x: 1, y: 0, z: 0 },
          }),
      fovy: Math.PI / 3,
      aspectRatio: 1,
      near: 1,
      far: 5e8,
      frameIsIdentity: true,
    }),
    viewRectangle: () => ({
      west: view.lon - 0.1,
      south: view.lat - 0.1,
      east: view.lon + 0.1,
      north: view.lat + 0.1,
    }),
    on(event, cb) {
      const set = cameraEvents[event];
      if (!set) return () => {};
      set.add(cb);
      return () => set.delete(cb);
    },
    get followed() {
      return followed;
    },
    // The port raises `followChanged` whenever `followed` changes, and only
    // then, as the renderer's does.
    follow(target) {
      if (target === followed) return;
      followed = target;
      if (target) follows.push(target);
      raise(cameraEvents.followChanged);
    },
    cancelFlight() {
      this.flightsCancelled += 1;
    },
    flying: false,
  };
  /** The tiles drawn in place of the globe, once a test puts some there. */
  const surface = { globeShown: false, tiles: null, mesh: null };
  const globe = {
    isGlobeVisible: () => surface.globeShown,
    surfaceVersion: () => 0,
    isSettled: (kind) =>
      kind === 'surface' || kind === 'tiles'
        ? surface.tiles?.tilesLoaded === true
        : true,
  };
  /** What the next pick names (`click`), else nothing. */
  let pickAnswer = null;
  const query = {
    pick: () => pickAnswer,
    drillPick: () => [],
    pickPosition: () => null,
    pickEllipsoid: () => null,
    project: () => null,
    isOccluded: () => false,
    // The tiles' mesh, as a test sets it; terrain is never loaded here.
    sampleHeightNow(point, options = {}) {
      if (options.against === 'terrain' || !surface.mesh) return null;
      surface.mesh.probes.push({ lat: point.lat, lon: point.lon, options });
      return surface.mesh.height;
    },
  };
  const frame = {
    on(phase, cb) {
      const set = frameEvents[phase];
      if (!set) return () => {};
      set.add(cb);
      return () => set.delete(cb);
    },
    requestRender() {},
    time: () => Date.now(),
  };
  // Pointer input as the renderer reports it: a test clicks through `click`.
  const inputEvents = listeners(['down', 'move', 'up', 'click', 'dblclick']);
  const stock = () => ({ enabled: true, suppress: () => () => {} });
  const input = {
    on(type, cb) {
      const set = inputEvents[type];
      if (!set) return () => {};
      set.add(cb);
      return () => set.delete(cb);
    },
    isPointerFree: () => true,
    suspendCameraControls: () => () => {},
    behaviours: { select: stock(), dblclickFollow: stock() },
  };
  const viewer = {
    isDestroyed: () => false,
    canvas: {
      clientWidth: 1000,
      clientHeight: 1000,
      width: 1000,
      height: 1000,
      addEventListener() {},
      removeEventListener() {},
    },
  };
  const draw = fakeDrawPort();
  const unbind = bindRenderer(viewer, {
    get canvas() {
      return viewer.canvas;
    },
    draw,
    camera,
    frame,
    globe,
    query,
    input,
  });

  const feeds = new Map();
  const schedules = new Map();
  const requested = [];
  const requestedSchedules = [];
  const requestedPaths = [];
  /** When each catalog request was made. */
  const catalogRequests = [];
  /**
   * A pack as the proxy serves it: 200 with its body, a number as that
   * failure status, else 404.
   */
  const packAnswer = (raw) =>
    raw && typeof raw === 'object'
      ? { ok: true, status: 200, headers: headersOf(), json: async () => raw }
      : {
          ok: false,
          status: typeof raw === 'number' ? raw : 404,
          headers: headersOf(),
          json: async () => ({}),
        };
  const source = {
    async requestSnapshot(feedId) {
      requested.push(feedId);
      const answer = feeds.get(feedId)?.() ?? null;
      if (Array.isArray(answer))
        return {
          ok: true,
          status: 200,
          headers: headersOf(),
          json: async () => ({ fetchedAt: Date.now(), trains: answer }),
        };
      if (answer?.positions === 'schedule')
        return {
          ok: true,
          status: 200,
          headers: headersOf({ 'x-gev-cache': 'SCHEDULE' }),
          json: async () => ({
            fetchedAt: Date.now(),
            positions: 'schedule',
            trains: [],
          }),
        };
      const status = answer?.status ?? 502;
      return {
        ok: false,
        status,
        headers: headersOf(
          answer?.backoff ? { 'x-rail-backoff': answer.backoff } : {},
        ),
        json: async () => ({
          error: 'Rail feed unavailable',
          ...(Number.isFinite(answer?.retryInSec)
            ? { retryInSec: answer.retryInSec }
            : {}),
        }),
      };
    },
    async requestSchedule(feedId) {
      requestedSchedules.push(feedId);
      return packAnswer(schedules.get(feedId));
    },
    ...(paths
      ? {
          async requestPaths(feedId) {
            requestedPaths.push(feedId);
            return packAnswer(paths[feedId]);
          },
        }
      : {}),
    ...(catalog === false
      ? {}
      : {
          async getFeeds() {
            catalogRequests.push(Date.now());
            if (catalog === undefined) return publicRailCatalog();
            return typeof catalog === 'function' ? catalog() : catalog;
          },
        }),
  };

  const focusRequests = [];
  /** Overlay source id → the entries last published to it. */
  const overlayEntries = new Map();
  let cockpit = false;
  const layer = createRailLayer({
    source,
    // Left out, the layer reads stops from its own schedule tier.
    ...(scheduleStops ? {} : { stops }),
    services: {
      render: {
        governorRequestRender() {},
        holdContinuousRender() {},
        releaseContinuousRender() {},
      },
      sprites: { spriteDrawOrder: () => -5 },
      picking: { registerPickOwner() {}, unregisterPickOwner() {} },
      overlays: {
        setOverlayEntries(sourceId, entries) {
          overlayEntries.set(sourceId, entries);
        },
        setOverlaySourceVisible() {},
        clearOverlaySource() {},
      },
      credits: {
        registerDynamicCredit() {},
        railFeedCredit: (feed) => ({ key: `rail-${feed.id}`, html: feed.id }),
      },
      ground: ground ?? {
        GROUND_FLOOR_LIFT_M: 1.5,
        cachedGroundFloor: () => null,
        warmGroundFloor() {},
      },
      ...(fleet ? { fleet } : {}),
      ...(placement ? { placement: layerPlacement(placement, 'rail') } : {}),
      camera: {
        framing: WORLD_FOCUS_FRAMING.train,
        requestWorldFocus(detail) {
          focusRequests.push(detail);
          return true;
        },
        isCockpitActive: () => cockpit,
      },
    },
  });
  layer.init(viewer);

  t.after(() => {
    try {
      layer.destroy(viewer);
    } catch {
      /* a test may already have destroyed it */
    }
    unbind();
    if (originalDocument === undefined) delete globalThis.document;
    else globalThis.document = originalDocument;
    if (originalWindow === undefined) delete globalThis.window;
    else globalThis.window = originalWindow;
  });

  const state = () => layer._railStateForTest();
  const parts = () => layer._railPartsForTest();
  /** Let pending promises (a poll's fetch, JSON and packs) settle. */
  const settle = async () => {
    for (let i = 0; i < 24; i += 1) await Promise.resolve();
  };

  return {
    layer,
    viewer,
    state,
    parts,
    feeds,
    schedules,
    requested,
    requestedSchedules,
    requestedPaths,
    catalogRequests,
    draw,
    camera,
    follows,
    overlayEntries,
    focusRequests,
    settle,
    setCockpit(value) {
      cockpit = value;
    },
    entry: (key) => state()._trains.get(key),
    async enable() {
      layer.enable(viewer);
      await settle();
      t.mock.timers.tick(0);
      await settle();
    },
    async poll() {
      await layer.update();
      await settle();
      // The duplicate filter runs off the poll's stack.
      t.mock.timers.tick(0);
      await settle();
    },
    /** Wall time with frames along the way, as in the app. */
    run(ms, step = 250) {
      const until = Date.now() + ms;
      while (Date.now() < until) {
        t.mock.timers.tick(Math.min(step, until - Date.now()));
        raise(frameEvents.preUpdate, { frame: 0 });
        raise(frameEvents.preRender, { frame: 0 });
      }
    },
    /** Move the camera without the camera reporting the move. */
    moveCameraQuietly(next) {
      Object.assign(view, next);
    },
    /** Move the camera and let the debounced feed check run. */
    async moveCamera(next) {
      Object.assign(view, next);
      raise(cameraEvents.changed);
      t.mock.timers.tick(CAMERA_DEBOUNCE_MS);
      await settle();
    },
    /** Let a deferred feed check (after a selection change) run. */
    async recheck() {
      t.mock.timers.tick(0);
      await settle();
    },
    /** A left click at `position` whose pick names `hit` (null: the map). */
    click(hit, position = { x: 10, y: 10 }) {
      pickAnswer = hit;
      const modifiers = { shift: false, ctrl: false, alt: false, meta: false };
      raise(inputEvents.click, {
        type: 'click',
        position,
        button: 0,
        modifiers,
        timestamp: Date.now(),
        pointerType: 'mouse',
      });
      pickAnswer = null;
    },
    /** Where the followed target is now, or undefined. */
    trackedPosition() {
      return followed?.position(Date.now()) ?? undefined;
    },
    /**
     * Draw the photorealistic tiles in place of the globe: whether they have
     * loaded what is in view, and the mesh height every probe reads (each
     * probe recorded). Returns both, for the test to change.
     */
    photoreal({ loaded = true, height = 158 } = {}) {
      surface.tiles = { tilesLoaded: loaded };
      surface.mesh = { height, probes: [] };
      return {
        tileset: surface.tiles,
        mesh: surface.mesh,
      };
    },
    /** The live draw set of `kind` whose id ends with `suffix`. */
    drawn(kind, suffix = '') {
      return [...draw.sets.values()].find(
        (set) =>
          !set.disposed && set.kind === kind && set.spec.id.endsWith(suffix),
      );
    },
  };
}
