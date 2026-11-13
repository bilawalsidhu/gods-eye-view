// A Rail layer on a stub viewer, a scripted proxy and fake camera services
// that record what the layer asks of the camera. Shared by the Rail layer's
// tests that run a whole layer (camera follow, live-only feeds, ground
// height, layer stats, selected route lines).
import * as Cesium from 'cesium';
import { createRailLayer } from '../layers/rail/index.js';
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
 *   paths?: Record<string, object>|null}} [options]
 *   `ground`: a floor service in place of the always-cold stub; `catalog`:
 *   the server's feed catalog (it may list fewer feeds than are bundled; a
 *   promise answers when it settles, a function is called per request and
 *   answers so); without it, a server with every pack built (all enabled
 *   feeds); `false` for a source with no catalog at all;
 *   `stops`: a stops provider (none by default); `scheduleStops`: the
 *   layer's own provider, its schedule tier, in its place;
 *   `paths`: feed id → the path pack the proxy serves, or a
 *   failure status it answers with (404 for any other feed; without it the
 *   source has no path route at all).
 */
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

  const view = { lat: at.lat, lon: at.lon, altitude };
  const cameraChanged = new Cesium.Event();
  const trackedEntityChanged = new Cesium.Event();
  const preRender = new Cesium.Event();
  const primitives = [];
  const primitiveCollection = {
    add(primitive) {
      primitives.push(primitive);
      return primitive;
    },
    remove(primitive) {
      const index = primitives.indexOf(primitive);
      if (index >= 0) primitives.splice(index, 1);
      return index >= 0;
    },
    contains: (primitive) => primitives.includes(primitive),
    raiseToTop() {},
    get length() {
      return primitives.length;
    },
    get: (index) => primitives[index],
  };
  let trackedEntity;
  const viewer = {
    entities: new Cesium.EntityCollection(),
    get trackedEntity() {
      return trackedEntity;
    },
    // Cesium's own setter raises the event on every change, as here.
    set trackedEntity(value) {
      if (trackedEntity === value) return;
      trackedEntity = value;
      trackedEntityChanged.raiseEvent(value);
    },
    trackedEntityChanged,
    isDestroyed: () => false,
    camera: {
      changed: cameraChanged,
      percentageChanged: 0.5,
      heading: 0,
      flightsCancelled: 0,
      positionWC: Cesium.Cartesian3.fromDegrees(at.lon, at.lat, altitude),
      get positionCartographic() {
        return {
          height: view.altitude,
          latitude: Cesium.Math.toRadians(view.lat),
          longitude: Cesium.Math.toRadians(view.lon),
        };
      },
      computeViewRectangle() {
        return Cesium.Rectangle.fromDegrees(
          view.lon - 0.1,
          view.lat - 0.1,
          view.lon + 0.1,
          view.lat + 0.1,
        );
      },
      cancelFlight() {
        this.flightsCancelled += 1;
      },
    },
    scene: {
      canvas: { addEventListener() {}, removeEventListener() {} },
      globe: { ellipsoid: Cesium.Ellipsoid.WGS84 },
      pick: () => undefined,
      requestRender() {},
      preRender,
      primitives: primitiveCollection,
      groundPrimitives: primitiveCollection,
    },
  };

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
  const frames = [];
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
      sprites: {
        registerSpriteCollection() {},
        unregisterSpriteCollection() {},
        restoreSpriteOrder() {},
      },
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
      camera: {
        framing: WORLD_FOCUS_FRAMING.train,
        requestWorldFocus(detail) {
          focusRequests.push(detail);
          return true;
        },
        applyTrackedCameraFrame(_viewer, entity, viewFrom) {
          const frame = { entity, viewFrom, stopped: false };
          frames.push(frame);
          return () => {
            frame.stopped = true;
          };
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
    primitives,
    overlayEntries,
    focusRequests,
    frames,
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
        preRender.raiseEvent();
      }
    },
    /** Move the camera and let the debounced feed check run. */
    async moveCamera(next) {
      Object.assign(view, next);
      cameraChanged.raiseEvent();
      t.mock.timers.tick(CAMERA_DEBOUNCE_MS);
      await settle();
    },
    /** Let a deferred feed check (after a selection change) run. */
    async recheck() {
      t.mock.timers.tick(0);
      await settle();
    },
    trackedPosition() {
      return viewer.trackedEntity?.position?.getValue(
        Cesium.JulianDate.now(),
        new Cesium.Cartesian3(),
      );
    },
  };
}
