import test from 'node:test';
import assert from 'node:assert/strict';
import * as Cesium from 'cesium';
import { createTransitLayer } from './index.js';
import {
  FEED_EVICT_AFTER_MS,
  FEED_STALE_AFTER_MS,
  MISSED_POLLS_TO_DROP,
  SELECTED_CARD_REFRESH_MS,
  TRANSIT_POLL_MS,
  VEHICLE_MAX_FIX_AGE_MS,
} from './policy.js';
import { FLOOR_WARM_PER_POLL } from './policy.js';
import {
  FUTURE_STAMP_TOLERANCE_MS,
  ORDER_REJECTS_BEFORE_RESET,
} from './ingestion.js';

/**
 * Fixes in these tests are AGE_MS old when they arrive, which makes the lag
 * the feed earns equal to the lag a fifteen-second reporter earns on its own
 * — one number, `LAG_MS`, and no slew — so the timelines below are exact.
 */
const AGE_MS = 15_000;
const LAG_MS = AGE_MS + TRANSIT_POLL_MS + 5_000;
/** A fix stamped AGE_MS before now, the way a live feed delivers them. */
const reported = () => (Date.now() - AGE_MS) / 1000;
const lat = (entry) =>
  Cesium.Math.toDegrees(
    Cesium.Cartographic.fromCartesian(entry.marker.position).latitude,
  );
import {
  cameraSensitivityClaims,
  claimCameraSensitivity,
  releaseCameraSensitivity,
} from '../../data/cameraSensitivity.js';
import {
  _resetRenderGovernorForTest,
  getRenderGovernorDiagnostics,
  governorRequestRender,
  holdContinuousRender,
  installRenderGovernor,
  releaseContinuousRender,
  uninstallRenderGovernor,
} from '../../renderGovernor.js';

const BOSTON = { lat: 42.3601, lon: -71.0589 };

/** One decoded snapshot in the shape `/api/transit/vehicles/<id>` returns. */
function snapshot(
  feedId,
  name,
  vehicles,
  { fetchedAt, feedTimestamp = null } = {},
) {
  return {
    feedId,
    name,
    fetchedAt,
    feedTimestamp,
    version: '2.0',
    entityCount: vehicles.length,
    truncated: false,
    count: vehicles.length,
    vehicles,
  };
}

/** A vehicle record as the proxy emits it, with its timestamp source resolved. */
function vehicle(id, lat, lon, atSeconds, extra = {}) {
  return {
    id,
    lat,
    lon,
    bearing: null,
    speedMps: null,
    timestamp: atSeconds,
    timestampSource: 'vehicle',
    routeId: '1',
    tripId: null,
    directionId: null,
    label: null,
    stopId: null,
    status: null,
    occupancy: null,
    ...extra,
  };
}

/**
 * A Transit layer wired to a stub scene and a scripted proxy.
 *
 * The render governor is the real one, so "does this layer keep the render loop
 * awake?" is answered by the same code the app runs.
 */
/**
 * A stand-in for the app's shared ground-floor system: warm cells, the coarse
 * grid, and a lowest-neighbour read. `floorAt` decides what a cell resolves to
 * when it is warmed; returning undefined models terrain that will not answer.
 * @param {(lat: number, lon: number) => number|undefined} floorAt
 */
function groundStub(floorAt) {
  const warm = new Map();
  const warmed = [];
  const coarseFloorCoord = (lat, lon) => ({
    lat: Number(lat.toFixed(3)),
    lon: Number(lon.toFixed(3)),
  });
  const key = (c) => `${c.lat},${c.lon}`;
  const cachedGroundFloor = (lat, lon) => {
    const value = warm.get(key(coarseFloorCoord(lat, lon)));
    return value === undefined ? null : value;
  };
  return {
    GROUND_FLOOR_LIFT_M: 1.5,
    coarseFloorCoord,
    cachedGroundFloor,
    neighborFloorM(cell) {
      let lowest = null;
      let resolved = 0;
      for (let dLat = -1; dLat <= 1; dLat += 1) {
        for (let dLon = -1; dLon <= 1; dLon += 1) {
          if (dLat === 0 && dLon === 0) continue;
          const h = cachedGroundFloor(
            cell.lat + dLat * 0.001,
            cell.lon + dLon * 0.001,
          );
          if (h === null) continue;
          resolved += 1;
          if (lowest === null || h < lowest) lowest = h;
        }
      }
      return resolved >= 3 ? lowest : null;
    },
    warmGroundFloor(points) {
      warmed.push(...points);
      for (const point of points) {
        const value = floorAt(point.lat, point.lon);
        if (Number.isFinite(value)) {
          warm.set(key(coarseFloorCoord(point.lat, point.lon)), value);
        }
      }
    },
    _warm: warm,
    _warmed: warmed,
    _key: (lat, lon) => key(coarseFloorCoord(lat, lon)),
  };
}

function harness(
  t,
  {
    source,
    altitude = 4_000,
    floorAt = () => 12,
    at = BOSTON,
    view = {
      west: at.lon - 0.1,
      south: at.lat - 0.1,
      east: at.lon + 0.1,
      north: at.lat + 0.1,
    },
  } = {},
) {
  const viewRect = { ...view };
  t.mock.timers.enable({
    apis: ['Date', 'setTimeout'],
    now: 1_789_000_000_000,
  });

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
  t.mock.method(performance, 'now', () => Date.now() - 1_789_000_000_000);
  const originalFetch = globalThis.fetch;
  const originalDocument = globalThis.document;
  const primitives = [];
  const sprites = new Map();
  const pickOwners = new Map();
  const overlaySources = new Map();
  const credits = [];
  /** @type {Map<string, (url: string) => {status:number, body?:object, headers?:object}>} */
  const responders = new Map();
  const requested = [];

  globalThis.document = Object.assign(new EventTarget(), {
    visibilityState: 'visible',
    documentElement: { dataset: {} },
  });
  // The style and vision events arrive on `window`, which Node does not have.
  const originalWindow = globalThis.window;
  globalThis.window = new EventTarget();

  const preRender = new Cesium.Event();
  const cameraChanged = new Cesium.Event();
  const viewer = {
    camera: {
      changed: cameraChanged,
      percentageChanged: 0.5,
      positionCartographic: {
        height: altitude,
        latitude: Cesium.Math.toRadians(at.lat),
        longitude: Cesium.Math.toRadians(at.lon),
      },
      computeViewRectangle() {
        return Cesium.Rectangle.fromDegrees(
          viewRect.west,
          viewRect.south,
          viewRect.east,
          viewRect.north,
        );
      },
    },
    scene: {
      canvas: { addEventListener() {}, removeEventListener() {} },
      globe: { ellipsoid: Cesium.Ellipsoid.WGS84 },
      pick: () => undefined,
      requestRenderMode: false,
      maximumRenderTimeChange: 0,
      requestRender() {},
      preRender,
      primitives: {
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
      },
    },
  };

  globalThis.fetch = async (url) => {
    requested.push(String(url));
    const feedId = String(url).split('/').pop();
    const responder = responders.get(feedId);
    const answer = responder
      ? responder(String(url))
      : { status: 504, body: { error: 'Transit feed unavailable' } };
    return {
      ok: answer.status >= 200 && answer.status < 300,
      status: answer.status,
      headers: { get: (name) => answer.headers?.[name.toLowerCase()] ?? null },
      json: async () => answer.body,
    };
  };

  const ground = groundStub(floorAt);
  /** Every call the floor cycle makes to the rendered-mesh sampler. */
  const meshCalls = [];
  const layer = createTransitLayer({
    source,
    services: {
      ground,
      mesh: {
        sampleMeshFloorCells(scene, points, options) {
          meshCalls.push({ scene, points: [...points], options });
        },
      },
      render: {
        governorRequestRender,
        holdContinuousRender,
        releaseContinuousRender,
      },
      sprites: {
        registerSpriteCollection: (id, collection) =>
          sprites.set(id, collection),
        unregisterSpriteCollection: (id) => sprites.delete(id),
        restoreSpriteOrder() {},
      },
      picking: {
        registerPickOwner: (id, predicate) => pickOwners.set(id, predicate),
        unregisterPickOwner: (id) => pickOwners.delete(id),
      },
      overlays: {
        setOverlayEntries: (id, entries) => overlaySources.set(id, entries),
        setOverlaySourceVisible() {},
        clearOverlaySource: (id) => overlaySources.delete(id),
      },
      credits: {
        registerDynamicCredit: (_viewer, credit) => credits.push(credit?.key),
        transitFeedCredit: (feed) => ({
          key: `transit-${feed.id}`,
          html: feed.name,
        }),
      },
    },
  });

  installRenderGovernor(viewer);
  layer.init(viewer);

  t.after(() => {
    try {
      layer.destroy(viewer);
    } catch {
      /* a test may already have destroyed it */
    }
    uninstallRenderGovernor(viewer);
    _resetRenderGovernorForTest();
    globalThis.fetch = originalFetch;
    if (originalDocument === undefined) delete globalThis.document;
    else globalThis.document = originalDocument;
    if (originalWindow === undefined) delete globalThis.window;
    else globalThis.window = originalWindow;
  });

  return {
    layer,
    viewer,
    primitives,
    sprites,
    pickOwners,
    overlaySources,
    credits,
    requested,
    serve(feedId, responder) {
      responders.set(feedId, responder);
    },
    silence(feedId) {
      responders.delete(feedId);
    },
    state: () => layer._transitStateForTest(),
    vehicles: () => [...layer._transitStateForTest()._vehicles.values()],
    frame() {
      preRender.raiseEvent();
    },
    advance(ms) {
      t.mock.timers.tick(ms);
    },
    /**
     * Let wall time pass the way it does in the app: with frames along the
     * way. The display clock only advances on frames, so a test that moves
     * the clock without them models a tab in the background, not a viewer.
     * @param {number} ms
     * @param {number} [step]
     */
    run(ms, step = 1_000) {
      const until = Date.now() + ms;
      while (Date.now() + step <= until) {
        t.mock.timers.tick(step);
        preRender.raiseEvent();
      }
      if (Date.now() < until) {
        t.mock.timers.tick(until - Date.now());
        preRender.raiseEvent();
      }
    },
    holds: () => getRenderGovernorDiagnostics().holds,
    ground,
    meshCalls,
    /**
     * Run the floor cycle the way its timer would, then a frame. Ground
     * resolution is a network round trip in the real app and deliberately
     * lives off the render path, so a vehicle with no floor yet is not drawn
     * until a re-read picks one up.
     * @param {number} [rounds]
     */
    settle(rounds = 4) {
      for (let i = 0; i < rounds; i += 1) {
        const parts = layer._transitPartsForTest();
        parts.height.rereadFloors();
        // The shown/hidden sweep is throttled in the app; running it here
        // keeps the clock out of it, so a test about glide timing is not also
        // a test about how long a sweep waits.
        parts.rendering.refreshVisibility();
        t.mock.timers.tick(16);
        preRender.raiseEvent();
      }
    },
    /** What the style manager dispatches when the user picks a preset. */
    style(name) {
      globalThis.window.dispatchEvent(
        new CustomEvent('gev:style-change', { detail: { style: name } }),
      );
    },
    /** What the style manager dispatches after every sync, cockpit included. */
    vision(style, cockpit) {
      globalThis.window.dispatchEvent(
        new CustomEvent('gev:vision-change', { detail: { style, cockpit } }),
      );
    },
    /** Move the camera's view rectangle, the way a real camera move would. */
    lookAt(next) {
      Object.assign(viewRect, next);
      cameraChanged.raiseEvent();
    },
  };
}

test('a vehicle is played back a fixed lag behind its fixes, at 1x', async (t) => {
  const app = harness(t);
  const start = Date.now();
  app.serve('mbta', () => ({
    status: 200,
    body: snapshot(
      'mbta',
      'MBTA',
      [vehicle('bus-1', 42.36, -71.06, reported())],
      {
        fetchedAt: Date.now(),
      },
    ),
  }));
  app.layer.enable(app.viewer);
  await app.layer.update();
  const [entry] = app.vehicles();
  assert.equal(entry.to.lat, 42.36);
  assert.equal(
    entry.sample.fromSeq,
    entry.sample.toSeq,
    'a brand-new vehicle holds at its only fix',
  );
  assert.equal(app.state()._moving.has(entry), false);
  assert.ok(
    Math.abs(Date.now() - entry.playT - LAG_MS) < 1,
    'its display clock starts a full lag behind',
  );

  // A later poll gives it a new fix. Nothing is drawn yet: the display clock
  // has not reached the first fix.
  app.advance(TRANSIT_POLL_MS);
  app.serve('mbta', () => ({
    status: 200,
    body: snapshot(
      'mbta',
      'MBTA',
      [vehicle('bus-1', 42.362, -71.06, reported())],
      {
        fetchedAt: Date.now(),
      },
    ),
  }));
  await app.layer.update();
  assert.ok(
    entry.wakeTimer != null,
    'one wake is scheduled at the first motion boundary',
  );
  app.frame();
  assert.ok(Math.abs(lat(entry) - 42.36) < 1e-6, 'still at the first fix');

  // The clock reaches the first fix LAG_MS after the wall time it was
  // reported at; halfway along the fifteen seconds to the second fix the
  // vehicle is drawn halfway between them.
  const firstFixAt = start - AGE_MS;
  app.run(firstFixAt + LAG_MS + TRANSIT_POLL_MS / 2 - Date.now());
  assert.ok(Math.abs(lat(entry) - 42.361) < 1e-4, `halfway, got ${lat(entry)}`);

  // Past the second fix it holds exactly there and stops being animated.
  app.run(TRANSIT_POLL_MS);
  assert.ok(Math.abs(lat(entry) - 42.362) < 1e-6);
  assert.equal(app.state()._moving.has(entry), false, 'held, not animated');
});
test('a vehicle the feed stops reporting is removed, and its primitive with it', async (t) => {
  const app = harness(t);
  const now = Date.now();
  const both = [
    vehicle('bus-1', 42.36, -71.06, now / 1000),
    vehicle('bus-2', 42.37, -71.07, now / 1000),
  ];
  app.serve('mbta', () => ({
    status: 200,
    body: snapshot('mbta', 'MBTA', both, { fetchedAt: Date.now() }),
  }));
  app.layer.enable(app.viewer);
  await app.layer.update();
  assert.equal(app.vehicles().length, 2);
  const collection = app.sprites.get('transit');
  assert.equal(collection.length, 2);

  app.serve('mbta', () => ({
    status: 200,
    body: snapshot(
      'mbta',
      'MBTA',
      [vehicle('bus-1', 42.361, -71.06, Date.now() / 1000)],
      {
        fetchedAt: Date.now(),
      },
    ),
  }));
  // One missed poll is tolerated (feeds drop a vehicle for a beat), two is not.
  app.advance(TRANSIT_POLL_MS);
  await app.layer.update();
  assert.equal(app.vehicles().length, 2);
  app.advance(TRANSIT_POLL_MS);
  await app.layer.update();
  assert.deepEqual(
    app.vehicles().map((entry) => entry.record.id),
    ['bus-1'],
  );
  assert.equal(
    collection.length + app.sprites.get('transit-motion').length,
    1,
    'the removed vehicle released its point primitive',
  );
});

test('one feed stale beside one fresh reads DEGRADED, not nominal', async (t) => {
  const app = harness(t);
  app.serve('mbta', () => ({
    status: 200,
    body: snapshot(
      'mbta',
      'MBTA',
      [vehicle('bus-1', 42.36, -71.06, Date.now() / 1000)],
      {
        fetchedAt: Date.now(),
      },
    ),
  }));
  app.layer.enable(app.viewer);
  await app.layer.update();

  const state = app.state();
  // Pretend a second feed is also in range and is being served from the proxy's
  // stale cache — exactly the mixed case the old `every(stale)` call missed.
  state._activeFeeds.set('ovapi-nl', {
    id: 'ovapi-nl',
    name: 'OVapi',
    region: 'Netherlands',
  });
  state._feedStatus.set('ovapi-nl', {
    count: 4,
    lastUpdate: Date.now(),
    error: null,
    stale: true,
    pollSeq: 1,
    loading: false,
  });
  const mixed = app.layer.getStats();
  assert.equal(mixed.stale, false, 'not everything is stale');
  assert.equal(mixed.degraded, true, 'but the view is part live and part not');

  // When every feed is stale the row says STALE outright.
  state._feedStatus.get('mbta').stale = true;
  const allStale = app.layer.getStats();
  assert.equal(allStale.stale, true);
});

test('a feed that goes silent has its vehicles evicted instead of frozen on the globe', async (t) => {
  const app = harness(t);
  app.serve('mbta', () => ({
    status: 200,
    body: snapshot(
      'mbta',
      'MBTA',
      [vehicle('bus-1', 42.36, -71.06, Date.now() / 1000)],
      {
        fetchedAt: Date.now(),
      },
    ),
  }));
  app.layer.enable(app.viewer);
  await app.layer.update();
  assert.equal(app.vehicles().length, 1);

  // The proxy's stale window expires and the feed stops answering at all.
  app.silence('mbta');
  app.advance(FEED_EVICT_AFTER_MS + 1_000);
  await app.layer.update();
  assert.equal(app.vehicles().length, 0, 'the last fleet is not left standing');
  assert.equal(app.sprites.get('transit').length, 0);
  const stats = app.layer.getStats();
  assert.equal(stats.count, 0);
  assert.equal(stats.stale, true);
});

test('inside a fresh snapshot, only the vehicle fixes that are too old are dropped', async (t) => {
  const app = harness(t);
  const now = Date.now();
  app.serve('mbta', () => ({
    status: 200,
    body: snapshot(
      'mbta',
      'MBTA',
      [
        vehicle('fresh', 42.36, -71.06, Date.now() / 1000),
        // A live feed really does carry these: a vehicle parked since this
        // morning, still listed, still reporting its last known position.
        vehicle(
          'ancient',
          42.37,
          -71.07,
          (Date.now() - 4 * 60 * 60 * 1000) / 1000,
        ),
        // A clock ahead of ours is treated as current, never as negative age.
        vehicle('future', 42.38, -71.08, (Date.now() + 60_000) / 1000),
      ],
      { fetchedAt: Date.now() },
    ),
  }));
  app.layer.enable(app.viewer);
  await app.layer.update();
  assert.deepEqual(
    app
      .vehicles()
      .map((entry) => entry.record.id)
      .sort(),
    ['fresh', 'future'],
  );

  // The same vehicles, unrefreshed, age out of the layer on a later sweep.
  app.silence('mbta');
  app.advance(VEHICLE_MAX_FIX_AGE_MS + 1_000);
  await app.layer.update();
  assert.equal(app.vehicles().length, 0);
  assert.equal(now <= Date.now(), true);
});

test('a snapshot the proxy replayed from its own cache for six minutes is refused, not drawn', async (t) => {
  const app = harness(t);
  const fetchedAt = Date.now();
  const vehicles = [
    vehicle('bus-1', 42.36, -71.06, fetchedAt / 1000),
    vehicle('bus-2', 42.37, -71.07, fetchedAt / 1000),
  ];
  app.serve('mbta', () => ({
    status: 200,
    body: snapshot('mbta', 'MBTA', vehicles, { fetchedAt }),
  }));
  app.layer.enable(app.viewer);
  await app.layer.update();
  assert.equal(app.vehicles().length, 2);

  // The operator stops answering. The proxy keeps handing back the SAME
  // snapshot every 15 s with STALE-ERROR; receiving bytes on a fresh cadence is
  // not the same as the buses being where they say.
  app.serve('mbta', () => ({
    status: 200,
    headers: { 'x-gev-cache': 'STALE-ERROR' },
    body: snapshot('mbta', 'MBTA', vehicles, { fetchedAt }),
  }));
  for (let tick = 0; tick < 24; tick += 1) {
    app.advance(TRANSIT_POLL_MS);
    await app.layer.update();
  }
  assert.ok(
    Date.now() - fetchedAt > FEED_EVICT_AFTER_MS,
    'six minutes have passed',
  );
  assert.equal(
    app.vehicles().length,
    0,
    'the replayed fleet is gone, not frozen',
  );
  assert.equal(app.sprites.get('transit').length, 0);
  const stats = app.layer.getStats();
  assert.equal(stats.count, 0);
  assert.equal(stats.stale, true);
  assert.match(stats.coverage, /\(\d+s old\)/);
  assert.equal(
    app.holds().includes('transit'),
    false,
    'and it holds no frames',
  );
});

test('disable aborts in-flight work and a response that lands late is ignored', async (t) => {
  const app = harness(t);
  let release;
  const pending = new Promise((resolve) => {
    release = resolve;
  });
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
  t.mock.method(performance, 'now', () => Date.now() - 1_789_000_000_000);
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    await pending;
    return originalFetch(url);
  };
  app.serve('mbta', () => ({
    status: 200,
    body: snapshot(
      'mbta',
      'MBTA',
      [vehicle('bus-1', 42.36, -71.06, Date.now() / 1000)],
      {
        fetchedAt: Date.now(),
      },
    ),
  }));
  app.layer.enable(app.viewer);
  const inFlight = app.layer.update();

  app.layer.disable(app.viewer);
  release();
  await inFlight;
  assert.equal(
    app.vehicles().length,
    0,
    'a poll from the disabled generation never lands',
  );
  assert.equal(app.state()._inFlight.size, 0);
  assert.equal(app.holds().includes('transit'), false);

  // Re-enabling starts a clean generation and does take data.
  globalThis.fetch = originalFetch;
  app.layer.enable(app.viewer);
  await app.layer.update();
  assert.equal(app.vehicles().length, 1);
});

test('a vehicle waits for its floor rather than standing on the ellipsoid', async (t) => {
  // The shared ground-floor system answers from the rendered mesh cell or the
  // real DEM cell; until one of them is warm there is no honest height to draw
  // at. Ellipsoid zero is not street level, and drawing there and dropping
  // afterwards is exactly the floating the owner reported.
  let terrainReady = false;
  const app = harness(t, { floorAt: () => (terrainReady ? 47 : undefined) });
  app.serve('mbta', () => ({
    status: 200,
    body: snapshot(
      'mbta',
      'MBTA',
      [vehicle('bus-1', 42.36, -71.06, Date.now() / 1000)],
      { fetchedAt: Date.now() },
    ),
  }));
  app.layer.enable(app.viewer);
  await app.layer.update();
  const entry = app.vehicles()[0];
  assert.equal(entry.heightResolved, false);
  app.settle();
  assert.equal(entry.heightPending, true, 'it has nothing to stand on');
  assert.equal(entry.marker.show, false, 'so it is not drawn');

  // Terrain arrives; the next re-read picks the cell up and the vehicle
  // appears, standing on it.
  terrainReady = true;
  app.settle();
  assert.equal(entry.heightResolved, true);
  assert.equal(entry.heightM, 47 + 1.5, 'the floor plus the shared lift');
  assert.equal(entry.marker.show, true);

  // Driving into a new cell asks that cell rather than keeping the one it was
  // born in.
  app.advance(TRANSIT_POLL_MS);
  const cellBefore = entry.heightCell;
  app.serve('mbta', () => ({
    status: 200,
    body: snapshot(
      'mbta',
      'MBTA',
      [vehicle('bus-1', 42.362, -71.06, Date.now() / 1000)],
      { fetchedAt: Date.now() },
    ),
  }));
  await app.layer.update();
  assert.notEqual(app.vehicles()[0].heightCell, cellBefore);
});

test('the render hold follows real motion, and is released when everything settles', async (t) => {
  const app = harness(t);
  const start = Date.now();
  app.serve('mbta', () => ({
    status: 200,
    body: snapshot(
      'mbta',
      'MBTA',
      [vehicle('bus-1', 42.36, -71.06, reported())],
      {
        fetchedAt: Date.now(),
      },
    ),
  }));
  app.layer.enable(app.viewer);
  await app.layer.update();
  // The first poll draws each vehicle at its fix; there is nothing to play,
  // and ground resolution runs off the render path, so the loop is never held.
  assert.equal(
    app.holds().includes('transit'),
    false,
    'a fleet that is not moving does not hold the loop',
  );
  app.frame();
  assert.equal(app.holds().includes('transit'), false);
  assert.equal(app.viewer.scene.requestRenderMode, true);

  // A second fix IS motion to come: the vehicle is armed and the loop held.
  app.advance(TRANSIT_POLL_MS);
  app.serve('mbta', () => ({
    status: 200,
    body: snapshot(
      'mbta',
      'MBTA',
      [vehicle('bus-1', 42.362, -71.06, reported())],
      {
        fetchedAt: Date.now(),
      },
    ),
  }));
  await app.layer.update();
  const firstFixAt = start - AGE_MS;
  app.run(firstFixAt + LAG_MS + TRANSIT_POLL_MS / 2 - Date.now());
  assert.ok(
    app.holds().includes('transit'),
    'a moving vehicle keeps the loop awake',
  );
  assert.equal(app.viewer.scene.requestRenderMode, false);

  // Past the second fix it holds and the loop is released again.
  app.run(TRANSIT_POLL_MS);
  assert.equal(
    app.holds().includes('transit'),
    false,
    'a settled fleet does not hold the GPU',
  );
  assert.equal(app.viewer.scene.requestRenderMode, true);
});
test('disable hands back the camera sensitivity it borrowed', async (t) => {
  const app = harness(t);
  assert.equal(app.viewer.camera.percentageChanged, 0.5);
  app.layer.enable(app.viewer);
  assert.equal(
    app.viewer.camera.percentageChanged,
    0.05,
    'the layer needs a finer camera trigger',
  );
  app.layer.disable(app.viewer);
  assert.equal(app.viewer.camera.percentageChanged, 0.5, 'and gives it back');
});

test('disable leaves the fine camera trigger another layer asked for', async (t) => {
  // The sequence that broke it: two layers ask for the SAME sensitivity, so
  // the value on the camera cannot say who owns it. Transit used to compare
  // the number, find its own 0.05 still there, and hand the coarse default
  // back while Bikeshare was still driving off the fine one.
  const app = harness(t);
  assert.equal(app.viewer.camera.percentageChanged, 0.5);

  app.layer.enable(app.viewer);
  assert.equal(app.viewer.camera.percentageChanged, 0.05);

  claimCameraSensitivity(app.viewer.camera, 'bikeshare', 0.05);
  app.layer.disable(app.viewer);

  assert.equal(
    app.viewer.camera.percentageChanged,
    0.05,
    'bikeshare is still enabled, so the fine trigger stays',
  );
  assert.deepEqual(cameraSensitivityClaims(app.viewer.camera), ['bikeshare']);

  releaseCameraSensitivity(app.viewer.camera, 'bikeshare');
  assert.equal(
    app.viewer.camera.percentageChanged,
    0.5,
    'and the original returns once the last claim is gone',
  );
  assert.deepEqual(cameraSensitivityClaims(app.viewer.camera), []);
});

test('a finer claim wins while it stands, and the coarser one survives it', async (t) => {
  const app = harness(t);
  app.layer.enable(app.viewer);
  claimCameraSensitivity(app.viewer.camera, 'traffic', 0.01);
  assert.equal(app.viewer.camera.percentageChanged, 0.01);

  releaseCameraSensitivity(app.viewer.camera, 'traffic');
  assert.equal(
    app.viewer.camera.percentageChanged,
    0.05,
    'transit still needs its own trigger',
  );
  app.layer.disable(app.viewer);
  assert.equal(app.viewer.camera.percentageChanged, 0.5);
});

test('destroy releases every shared registration this layer took', async (t) => {
  const app = harness(t);
  app.serve('mbta', () => ({
    status: 200,
    body: snapshot(
      'mbta',
      'MBTA',
      [vehicle('bus-1', 42.36, -71.06, Date.now() / 1000)],
      {
        fetchedAt: Date.now(),
      },
    ),
  }));
  app.layer.enable(app.viewer);
  await app.layer.update();
  assert.ok(app.sprites.has('transit'));
  assert.ok(app.pickOwners.has('transit'));
  assert.equal(app.primitives.length, 2);

  app.layer.destroy(app.viewer);
  assert.equal(
    app.sprites.has('transit'),
    false,
    'the sprite collection is unregistered',
  );
  assert.equal(
    app.pickOwners.has('transit'),
    false,
    'the pick owner is released',
  );
  assert.equal(
    app.primitives.length,
    0,
    'the primitive collection leaves the scene',
  );
  assert.equal(app.holds().includes('transit'), false);
  assert.equal(app.state()._viewer, null);
  assert.equal(app.state()._dataManager, null);
});

test('two layers built from the factory share no state', async (t) => {
  const app = harness(t);
  const second = createTransitLayer({
    services: {
      ground: groundStub(() => 12),
      render: {
        governorRequestRender,
        holdContinuousRender,
        releaseContinuousRender,
      },
      sprites: {
        registerSpriteCollection() {},
        unregisterSpriteCollection() {},
        restoreSpriteOrder() {},
      },
      picking: { registerPickOwner() {}, unregisterPickOwner() {} },
      overlays: {
        setOverlayEntries() {},
        setOverlaySourceVisible() {},
        clearOverlaySource() {},
      },
      credits: {
        registerDynamicCredit() {},
        transitFeedCredit: (feed) => ({ key: feed.id, html: feed.name }),
      },
    },
  });
  app.serve('mbta', () => ({
    status: 200,
    body: snapshot(
      'mbta',
      'MBTA',
      [vehicle('bus-1', 42.36, -71.06, Date.now() / 1000)],
      {
        fetchedAt: Date.now(),
      },
    ),
  }));
  app.layer.enable(app.viewer);
  await app.layer.update();
  assert.equal(app.vehicles().length, 1);
  assert.equal(second._transitStateForTest()._vehicles.size, 0);
  assert.notEqual(second._transitStateForTest(), app.state());
  assert.equal(second.getStats().count, 0);
});

test('a proxy cooldown reaches the row as a time, not just a shrug', async (t) => {
  const app = harness(t);
  // The proxy answers 503 with how long it intends to leave the operator alone.
  app.serve('mbta', () => ({
    status: 503,
    body: { error: 'Transit feed unavailable', feedId: 'mbta', retryInSec: 60 },
  }));
  app.layer.enable(app.viewer);
  await app.layer.update();
  const stats = app.layer.getStats();
  assert.equal(stats.count, 0);
  assert.match(String(stats.error), /MBTA/);
  assert.equal(stats.retryInSec, 60);

  // A successful poll clears both the error and the countdown.
  app.serve('mbta', () => ({
    status: 200,
    body: snapshot(
      'mbta',
      'MBTA',
      [vehicle('bus-1', 42.36, -71.06, Date.now() / 1000)],
      {
        fetchedAt: Date.now(),
      },
    ),
  }));
  app.advance(TRANSIT_POLL_MS);
  await app.layer.update();
  const recovered = app.layer.getStats();
  assert.equal(recovered.error, null);
  assert.equal(recovered.retryInSec, undefined);
});

test('the coverage text ages a quiet feed by the same rule the row state uses', async (t) => {
  const app = harness(t);
  app.serve('mbta', () => ({
    status: 200,
    body: snapshot(
      'mbta',
      'MBTA',
      [vehicle('bus-1', 42.36, -71.06, Date.now() / 1000)],
      {
        fetchedAt: Date.now(),
      },
    ),
  }));
  app.layer.enable(app.viewer);
  await app.layer.update();
  assert.equal(app.layer.getStats().coverage, 'MBTA 1');

  // Past the stale threshold the text names the age, and the row agrees.
  app.silence('mbta');
  app.advance(FEED_STALE_AFTER_MS + 10_000);
  const stale = app.layer.getStats();
  assert.match(stale.coverage, /^MBTA 1 \(\d+s old\)$/);
  assert.equal(stale.stale, true);
});

test('a parked fleet that keeps reporting the same position stops asking for frames', async (t) => {
  const app = harness(t);
  // A depot at night: the feed answers on time, every 15 s, with coordinates
  // that do not change. Each of those is a real observation — the bus is
  // still there — but there is nothing to draw, and drawing it anyway kept
  // the render loop awake all night.
  const parked = () => [
    vehicle('bus-1', 42.36, -71.06, reported()),
    vehicle('bus-2', 42.37, -71.07, reported()),
  ];
  app.serve('mbta', () => ({
    status: 200,
    body: snapshot('mbta', 'MBTA', parked(), { fetchedAt: Date.now() }),
  }));
  app.layer.enable(app.viewer);
  await app.layer.update();
  app.frame();
  assert.equal(
    app.holds().includes('transit'),
    false,
    'nothing moved on the first poll',
  );

  for (let poll = 0; poll < 4; poll += 1) {
    app.advance(TRANSIT_POLL_MS);
    await app.layer.update();
    app.frame();
    assert.equal(
      app.holds().includes('transit'),
      false,
      `identical poll ${poll + 1} must not count as motion`,
    );
    assert.equal(app.state()._moving.size, 0);
  }
  assert.equal(app.viewer.scene.requestRenderMode, true);
  assert.equal(app.vehicles().length, 2, 'and the fleet is still on screen');

  // One vehicle finally moves: that IS work, and the hold comes back.
  app.advance(TRANSIT_POLL_MS);
  app.serve('mbta', () => ({
    status: 200,
    body: snapshot(
      'mbta',
      'MBTA',
      [
        vehicle('bus-1', 42.3605, -71.06, reported()),
        vehicle('bus-2', 42.37, -71.07, reported()),
      ],
      { fetchedAt: Date.now() },
    ),
  }));
  await app.layer.update();
  assert.equal(
    app.holds().includes('transit'),
    false,
    'departure remains buffered until its boundary',
  );
  app.advance(6000);
  app.frame();
  assert.ok(
    app.holds().includes('transit'),
    'departure wakes the loop at its boundary',
  );
  app.advance(TRANSIT_POLL_MS / 2);
  app.frame();
  assert.ok(app.holds().includes('transit'));
  assert.equal(
    app.state()._moving.size,
    1,
    'only the vehicle that actually moved is animating',
  );
});
test('the last vehicle leaving mid-segment takes the render hold with it', async (t) => {
  const app = harness(t);
  const fetchedAt = Date.now();
  app.serve('mbta', () => ({
    status: 200,
    body: snapshot(
      'mbta',
      'MBTA',
      [vehicle('bus-1', 42.36, -71.06, reported())],
      {
        fetchedAt: Date.now(),
      },
    ),
  }));
  app.layer.enable(app.viewer);
  await app.layer.update();

  // Second poll: the vehicle has somewhere to go, so the hold is taken.
  app.advance(TRANSIT_POLL_MS);
  app.serve('mbta', () => ({
    status: 200,
    body: snapshot(
      'mbta',
      'MBTA',
      [vehicle('bus-1', 42.362, -71.06, reported())],
      {
        fetchedAt: Date.now(),
      },
    ),
  }));
  await app.layer.update();
  app.advance(TRANSIT_POLL_MS / 3);
  app.frame();
  assert.ok(app.holds().includes('transit'), 'in motion, so the loop is held');
  assert.equal(app.state()._moving.has(app.vehicles()[0]), true);

  // The feed dies. The sweep removes the last vehicle while it is still
  // in motion, and the poll that discovers this fails — so no frame follows to
  // notice the fleet is gone. The hold has to be released by the eviction.
  app.silence('mbta');
  app.advance(FEED_EVICT_AFTER_MS + 1_000);
  await app.layer.update();
  assert.equal(app.vehicles().length, 0);
  assert.equal(
    app.holds().includes('transit'),
    false,
    'no hold may outlive the fleet that justified it',
  );
  assert.equal(app.viewer.scene.requestRenderMode, true);
  assert.ok(Date.now() - fetchedAt > FEED_EVICT_AFTER_MS);
});
test('only the vehicles near the view are animated frame by frame', async (t) => {
  const app = harness(t);
  const near = vehicle('near', 42.36, -71.06, reported());
  // Far enough away to be outside any plausible inflation of the harness view
  // rectangle, but well inside the feed's coverage circle.
  const far = vehicle('far', 42.62, -71.44, reported());
  app.serve('mbta', () => ({
    status: 200,
    body: snapshot('mbta', 'MBTA', [near, far], { fetchedAt: Date.now() }),
  }));
  app.layer.enable(app.viewer);
  await app.layer.update();
  app.frame();

  // Both move on the next poll; only the one in view is armed at all.
  app.advance(TRANSIT_POLL_MS);
  app.serve('mbta', () => ({
    status: 200,
    body: snapshot(
      'mbta',
      'MBTA',
      [
        vehicle('near', 42.3625, -71.06, reported()),
        vehicle('far', 42.6225, -71.44, reported()),
      ],
      { fetchedAt: Date.now() },
    ),
  }));
  await app.layer.update();
  const byId = new Map(app.vehicles().map((entry) => [entry.record.id, entry]));
  app.advance(6000);
  app.frame();
  assert.equal(
    app.state()._moving.size,
    1,
    'a poll arms only the vehicle in view',
  );
  assert.ok(app.state()._moving.has(byId.get('near')));
  assert.equal(
    byId.get('far').marker.show,
    false,
    'the off-screen vehicle is hidden',
  );

  app.advance(TRANSIT_POLL_MS / 4);
  app.frame();
  assert.equal(
    app.state()._moving.has(byId.get('far')),
    false,
    'and is never animated',
  );
  assert.ok(
    app.state()._moving.has(byId.get('near')),
    'the one in view keeps playing',
  );

  // When the view reaches it, its clock is re-synced and the frame pass places
  // it: nothing is owed for motion nobody watched.
  app.lookAt({ west: -71.54, south: 42.52, east: -71.34, north: 42.72 });
  // Two floor passes: it was never warmed while hidden, and a warmed cell
  // answers on the pass after the one that asked.
  app.settle(2);
  app.advance(250);
  app.frame();
  assert.notEqual(byId.get('far').marker.show, false, 'now shown');
  assert.ok(
    Math.abs(lat(byId.get('far')) - 42.62) < 1e-3,
    'placed on its history',
  );
});
test('a wide oblique view does not hide the fleet that is plainly in it', async (t) => {
  // Codex's reproduction: a high oblique camera over Europe sees roughly
  // -78°..88° of longitude. Padding each endpoint on its own wrapped that span
  // into a five-degree slice of the Pacific, so every Dutch vehicle failed the
  // view gate — hidden, unanimated, and invisible to DETECT — while filling
  // the screen.
  const app = harness(t, {
    at: { lat: 52.09, lon: 5.12 },
    altitude: 1_500_000,
    view: { west: -78.084, south: 20, east: 88.084, north: 84 },
  });
  const now = Date.now();
  const utrecht = vehicle('nl-1', 52.09, 5.12, now / 1000);
  const rotterdam = vehicle('nl-2', 51.92, 4.48, now / 1000);
  app.serve('ovapi-nl', () => ({
    status: 200,
    body: snapshot('ovapi-nl', 'OVapi', [utrecht, rotterdam], {
      fetchedAt: Date.now(),
    }),
  }));

  app.layer.enable(app.viewer);
  await app.layer.update();
  app.advance(250);
  app.frame();

  const shown = app.vehicles().filter((entry) => entry.marker?.show !== false);
  assert.equal(shown.length, 2, 'both vehicles are in the view the camera has');
  assert.equal(
    app.layer.getDetectableObjects({ maxCount: 50, seed: 0 }).length,
    2,
    'and DETECT can see them',
  );
});

test('a lone visible vehicle is offered to DETECT out of a large hidden fleet', async (t) => {
  // The stride used to run over the WHOLE fleet and discard the hidden ones
  // afterwards, so one visible bus among thousands could fall outside the
  // sample and go unlabelled while the overlay had capacity to spare.
  const app = harness(t);
  const now = Date.now();
  const vehicles = [];
  for (let i = 0; i < 400; i += 1) {
    // Far outside the harness view rectangle, inside MBTA coverage.
    vehicles.push(vehicle(`away-${i}`, 42.6 + i * 0.001, -71.45, now / 1000));
    // Deliberately NOT first in the map: an ordinal stride happens to pick
    // index zero, which would hide the fault rather than show it.
    if (i === 0) vehicles.push(vehicle('visible', 42.361, -71.058, now / 1000));
  }
  app.serve('mbta', () => ({
    status: 200,
    body: snapshot('mbta', 'MBTA', vehicles, { fetchedAt: Date.now() }),
  }));
  app.layer.enable(app.viewer);
  await app.layer.update();
  app.settle();

  const contacts = app.layer.getDetectableObjects({ maxCount: 8, seed: 0 });
  assert.equal(contacts.length, 1, 'only the visible one is a candidate');
  assert.equal(contacts[0].sourceId, 'mbta:visible');
});

test('removing one vehicle does not hand every label to its neighbour', async (t) => {
  // Striding by position meant that one bus leaving at the front renumbered
  // everyone behind it: the sampled set flipped from even indices to odd, and
  // not one of the previous identities survived.
  const app = harness(t, {
    view: { west: -71.3, south: 42.2, east: -70.8, north: 42.5 },
  });
  const now = Date.now();
  const fleet = [];
  for (let i = 0; i < 40; i += 1) {
    fleet.push(vehicle(`bus-${i}`, 42.35 + i * 0.001, -71.06, now / 1000));
  }
  app.serve('mbta', () => ({
    status: 200,
    body: snapshot('mbta', 'MBTA', fleet, { fetchedAt: Date.now() }),
  }));
  app.layer.enable(app.viewer);
  await app.layer.update();
  app.settle();

  const before = app.layer
    .getDetectableObjects({ maxCount: 10, seed: 0 })
    .map((contact) => contact.sourceId);
  assert.equal(before.length, 10);

  // The first vehicle stops being reported; everyone else is unchanged. It
  // takes MISSED_POLLS_TO_DROP polls of silence for it to actually leave.
  for (let poll = 0; poll < MISSED_POLLS_TO_DROP + 1; poll += 1) {
    app.advance(TRANSIT_POLL_MS);
    app.serve('mbta', () => ({
      status: 200,
      body: snapshot(
        'mbta',
        'MBTA',
        fleet.slice(1).map((v) => ({ ...v, timestamp: Date.now() / 1000 })),
        { fetchedAt: Date.now() },
      ),
    }));
    await app.layer.update();
    app.frame();
  }
  assert.equal(
    app.vehicles().some((entry) => entry.record.id === 'bus-0'),
    false,
    'the vehicle really did leave',
  );

  const after = new Set(
    app.layer
      .getDetectableObjects({ maxCount: 10, seed: 0 })
      .map((contact) => contact.sourceId),
  );
  const survived = before.filter(
    (id) => id !== 'mbta:bus-0' && after.has(id),
  ).length;
  const expected = before.filter((id) => id !== 'mbta:bus-0').length;
  assert.equal(
    survived,
    expected,
    'every still-present labelled vehicle keeps its label',
  );
});

test('a vehicle inside the view drives out of it instead of vanishing', async (t) => {
  // A fix placing the DESTINATION just past the padded edge used to hide the
  // marker on the spot — while the vehicle was still drawn well inside the
  // view — and throw its glide away in the same frame.
  const app = harness(t, {
    view: { west: -71.062, south: 42.3585, east: -71.058, north: 42.3605 },
  });
  const now = Date.now();
  app.serve('mbta', () => ({
    status: 200,
    body: snapshot('mbta', 'MBTA', [vehicle('b', 42.36, -71.06, now / 1000)], {
      fetchedAt: Date.now(),
    }),
  }));
  app.layer.enable(app.viewer);
  await app.layer.update();
  app.settle();
  const entry = app.vehicles()[0];
  assert.notEqual(entry.marker.show, false, 'it starts on screen');

  // Next fix is beyond the inflated rectangle; the vehicle is still drawn
  // inside it.
  app.advance(TRANSIT_POLL_MS);
  app.serve('mbta', () => ({
    status: 200,
    body: snapshot(
      'mbta',
      'MBTA',
      [vehicle('b', 42.3625, -71.06, Date.now() / 1000)],
      { fetchedAt: Date.now() },
    ),
  }));
  await app.layer.update();
  app.frame();

  assert.notEqual(
    entry.marker.show,
    false,
    'it is still on screen, because it still is',
  );
  assert.ok(
    entry.wakeTimer != null || app.state()._moving.has(entry),
    'and it has a departure wake rather than teleporting',
  );
});

test('the selected card lands where the vehicle stopped, not short of it', async (t) => {
  // The card is refreshed on a 250 ms throttle. The last tick before a
  // segment ends left it a few metres behind, and then the render hold was
  // released with no frame scheduled to close the gap.
  const app = harness(t);
  const start = Date.now();
  app.serve('mbta', () => ({
    status: 200,
    body: snapshot('mbta', 'MBTA', [vehicle('b', 42.36, -71.06, reported())], {
      fetchedAt: Date.now(),
    }),
  }));
  app.layer.enable(app.viewer);
  await app.layer.update();
  // Its floor resolves, so the marker is shown: a hidden vehicle has no card.
  app.settle();

  const entry = app.vehicles()[0];
  app.layer._transitPartsForTest().selection.selectVehicle(entry.key);

  app.advance(TRANSIT_POLL_MS);
  // Stamped exactly one poll after the first fix, so the vehicle's own lag
  // equals the feed's and the clock runs at exactly 1x through the segment.
  const secondFixS = (entry.fixes[0].t + TRANSIT_POLL_MS) / 1000;
  app.serve('mbta', () => ({
    status: 200,
    body: snapshot(
      'mbta',
      'MBTA',
      [vehicle('b', 42.3625, -71.0625, secondFixS)],
      {
        fetchedAt: Date.now(),
      },
    ),
  }));
  await app.layer.update();

  // Codex's sequence: a card refresh 200 ms before the segment completes, then
  // the settling frame — which falls INSIDE the 250 ms card throttle, so
  // nothing but a forced refresh can close the gap.
  // The segment ends when the clock reaches the second fix, a lag after it.
  const segmentEndsAt = entry.fixes[1].t + LAG_MS;
  app.run(segmentEndsAt - 200 - Date.now());
  // The settling frame — whichever frame that turns out to be — falls INSIDE
  // the card throttle, so only the forced refresh can close the gap.
  let frames = 0;
  while (app.state()._moving.has(entry) && frames < 60) {
    app.advance(16);
    app.frame();
    frames += 1;
  }
  assert.equal(app.state()._moving.has(entry), false, 'settled');
  assert.equal(
    app.state()._selectedCardAt,
    Date.now(),
    'the settling frame forced a card refresh, throttle or no throttle',
  );

  const card = app.overlaySources.get('transit-selected')?.[0];
  assert.ok(card, 'the card is still on screen');
  const anchor =
    typeof card.position === 'function' ? card.position() : card.position;
  const drift = Cesium.Cartesian3.distance(anchor, entry.marker.position);
  assert.ok(
    drift < 0.5,
    `the card sits on the vehicle it follows (was ${drift.toFixed(2)} m behind)`,
  );
});
test('a parked fleet over unsampled ground off screen stops asking for frames', async (t) => {
  // 200 stationary vehicles in distinct off-screen cells whose terrain never
  // resolves used to keep the height queue non-empty for ever, and a non-empty
  // queue is a held render loop over a view with nothing moving in it.
  const app = harness(t, { floorAt: () => undefined });
  const now = Date.now();
  const parked = [];
  for (let i = 0; i < 200; i += 1) {
    parked.push(vehicle(`p-${i}`, 42.5 + i * 0.003, -71.4, now / 1000));
  }
  const serve = () => ({
    status: 200,
    body: snapshot('mbta', 'MBTA', parked, { fetchedAt: Date.now() }),
  });
  app.serve('mbta', serve);
  app.layer.enable(app.viewer);
  await app.layer.update();
  app.frame();

  // Eight polls — two minutes — with nothing moving and nothing in view.
  for (let poll = 0; poll < 8; poll += 1) {
    app.advance(TRANSIT_POLL_MS);
    app.serve('mbta', serve);
    await app.layer.update();
    for (let f = 0; f < 4; f += 1) {
      app.advance(100);
      app.frame();
    }
  }

  assert.equal(
    app.ground._warmed.length,
    0,
    'no ground was asked for on behalf of vehicles nobody can see',
  );
  assert.equal(
    app.holds().includes('transit'),
    false,
    'and the render loop is not held over an empty view',
  );
});

test('a height that arrives from a neighbour lifts a stationary vehicle too', async (t) => {
  // A cache hit updated heightM but the billboard endpoints only refreshed on
  // a lat/lon change, so a bus that had not moved kept drawing at ellipsoid
  // height beside a neighbour standing on the street.
  const app = harness(t, { floorAt: () => 125 });
  const now = Date.now();
  const parked = vehicle('still', 42.36, -71.06, now / 1000);
  app.serve('mbta', () => ({
    status: 200,
    body: snapshot('mbta', 'MBTA', [parked], { fetchedAt: Date.now() }),
  }));
  app.layer.enable(app.viewer);
  await app.layer.update();

  const entry = app.vehicles()[0];
  // Pretend the floor landed for this cell while the vehicle was absent: the
  // shared cache knows the height, the entry does not.
  entry.heightM = 0;
  entry.heightResolved = false;
  entry.heightPending = false;
  app.ground._warm.set(app.ground._key(42.36, -71.06), 125);

  app.advance(TRANSIT_POLL_MS);
  app.serve('mbta', () => ({
    status: 200,
    body: snapshot(
      'mbta',
      'MBTA',
      [vehicle('still', 42.36, -71.06, Date.now() / 1000)],
      { fetchedAt: Date.now() },
    ),
  }));
  await app.layer.update();
  app.frame();

  const carto = Cesium.Cartographic.fromCartesian(entry.marker.position);
  assert.ok(
    Math.abs(carto.height - 126.5) < 1,
    `the vehicle stands on the ground its cell reported (drew at ${carto.height.toFixed(1)} m)`,
  );
});

test('a feed answering 304 every poll stays healthy instead of ageing out', async (t) => {
  // The proxy keeps serving the body it holds, whose fetch time stops
  // advancing. Reading that as "when did we last hear from them" marked a feed
  // whose every request succeeded as DEGRADED at 90 s and emptied it at five
  // minutes.
  const app = harness(t);
  const firstFetch = Date.now();
  const body = snapshot(
    'mbta',
    'MBTA',
    [vehicle('b', 42.36, -71.06, firstFetch / 1000)],
    { fetchedAt: firstFetch },
  );
  app.serve('mbta', () => ({
    status: 200,
    body,
    headers: { 'x-transit-contact': String(Date.now()) },
  }));
  app.layer.enable(app.viewer);
  await app.layer.update();
  assert.equal(app.vehicles().length, 1);

  // Twenty-four polls — six minutes — of successful revalidation.
  for (let poll = 0; poll < 24; poll += 1) {
    app.advance(16_000);
    app.serve('mbta', () => ({
      status: 200,
      body,
      headers: { 'x-transit-contact': String(Date.now()) },
    }));
    await app.layer.update();
  }

  const stats = app.layer.getStats();
  assert.equal(app.vehicles().length, 1, 'the vehicle is still on the globe');
  assert.equal(stats.stale, false, 'and the feed does not read as gone quiet');
});

test('a feed that has genuinely stopped answering still ages out', async (t) => {
  // The other half of the same rule: a contact time that does NOT advance is
  // still silence, and silence must empty the map.
  const app = harness(t);
  const firstFetch = Date.now();
  const body = snapshot(
    'mbta',
    'MBTA',
    [vehicle('b', 42.36, -71.06, firstFetch / 1000)],
    { fetchedAt: firstFetch },
  );
  app.serve('mbta', () => ({
    status: 200,
    body,
    headers: { 'x-transit-contact': String(firstFetch) },
  }));
  app.layer.enable(app.viewer);
  await app.layer.update();
  assert.equal(app.vehicles().length, 1);

  app.advance(FEED_EVICT_AFTER_MS + 30_000);
  app.serve('mbta', () => ({
    status: 200,
    body,
    headers: { 'x-transit-contact': String(firstFetch) },
  }));
  await app.layer.update();
  assert.equal(app.vehicles().length, 0, 'a silent feed empties the globe');
});

test('a vehicle with no surface yet waits instead of floating', async (t) => {
  // Ellipsoid zero is not street level — in Boston it is about thirty metres
  // underground — so a marker drawn at +3 m while its sample is pending sits
  // above its final height and then drops. The owner saw that as floating.
  let allowSamples = false;
  const app = harness(t, {
    floorAt: () => (allowSamples ? 30 : undefined),
  });
  app.serve('mbta', () => ({
    status: 200,
    body: snapshot(
      'mbta',
      'MBTA',
      [vehicle('b', 42.36, -71.06, Date.now() / 1000)],
      { fetchedAt: Date.now() },
    ),
  }));
  app.layer.enable(app.viewer);
  await app.layer.update();
  app.frame();

  const entry = app.vehicles()[0];
  assert.equal(
    entry.heightPending,
    true,
    'it knows it has nothing to stand on',
  );
  assert.equal(entry.marker.show, false, 'so it is not drawn');

  allowSamples = true;
  app.settle();
  assert.equal(entry.heightPending, false);
  assert.equal(entry.marker.show, true, 'and appears once the ground answers');
  const carto = Cesium.Cartographic.fromCartesian(entry.marker.position);
  assert.ok(
    Math.abs(carto.height - 31.5) < 1,
    `standing on its floor plus the shared lift, got ${carto.height.toFixed(1)} m`,
  );
});

test('a new vehicle borrows the lowest surface resolved nearby', async (t) => {
  // The first visible frame uses the best prior available rather than a flat
  // +3 m, and the prior is biased LOW so a marker can only rise onto its own
  // surface, never appear above it and fall.
  const app = harness(t, { floorAt: () => 40 });
  const early = [
    vehicle('a', 42.36, -71.06, Date.now() / 1000),
    vehicle('b', 42.361, -71.06, Date.now() / 1000),
    vehicle('c', 42.36, -71.061, Date.now() / 1000),
    vehicle('d', 42.361, -71.061, Date.now() / 1000),
  ];
  app.serve('mbta', () => ({
    status: 200,
    body: snapshot('mbta', 'MBTA', early, { fetchedAt: Date.now() }),
  }));
  app.layer.enable(app.viewer);
  await app.layer.update();
  app.settle();

  // A second vehicle appears a block away, in a cell of its own whose
  // neighbours are warm. The shared floor wants at least three resolved
  // neighbours before it will speak for a cold cell.
  app.advance(TRANSIT_POLL_MS);
  app.serve('mbta', () => ({
    status: 200,
    body: snapshot(
      'mbta',
      'MBTA',
      [
        ...early.map((v) => ({ ...v, timestamp: Date.now() / 1000 })),
        // Its own cell is cold; the three around it are warm.
        vehicle('second', 42.3605, -71.0605, Date.now() / 1000),
      ],
      { fetchedAt: Date.now() },
    ),
  }));
  await app.layer.update();

  const second = app.vehicles().find((e) => e.record.id === 'second');
  assert.equal(
    second.heightPending,
    false,
    'it has ground to stand on at once',
  );
  assert.equal(second.heightM, 41.5, 'borrowed from the neighbourhood');
  app.advance(250);
  app.frame();
  assert.equal(second.marker.show, true);
});

test('only the vehicles in view have their ground warmed', async (t) => {
  // Warming is a network round trip through the shared resolver. A parked
  // metropolitan fleet off screen used to keep a queue — and with it the
  // render loop — alive indefinitely over an empty view.
  const app = harness(t, { floorAt: () => undefined });
  const warmed = app.ground._warmed;
  const fleet = [vehicle('near', 42.36, -71.06, Date.now() / 1000)];
  for (let i = 0; i < 50; i += 1) {
    fleet.push(
      vehicle(`far-${i}`, 42.6 + i * 0.002, -71.45, Date.now() / 1000),
    );
  }
  app.serve('mbta', () => ({
    status: 200,
    body: snapshot('mbta', 'MBTA', fleet, { fetchedAt: Date.now() }),
  }));
  app.layer.enable(app.viewer);
  await app.layer.update();
  app.settle();

  assert.ok(warmed.length > 0, 'the one in view is warmed');
  const offScreen = warmed.filter((point) => point.lat > 42.5);
  assert.equal(offScreen.length, 0, 'and nothing off screen is');
  assert.equal(
    app.holds().includes('transit'),
    false,
    'a fleet waiting for ground is not a fleet worth burning frames on',
  );
});

test('a segment climbs from the ground it left to the ground it reaches', async (t) => {
  // Rebuilding both ends of a segment at the destination's altitude lifted the
  // vehicle onto the new height on the FIRST frame: it flew up, then
  // travelled. With the display running a lag behind, the trap is subtler —
  // the floor is asked for the NEWEST fix while an older one is still being
  // drawn — so each fix carries its own floor.
  const app = harness(t, { floorAt: (lat) => (lat > 42.3615 ? 100 : 10) });
  const start = Date.now();
  app.serve('mbta', () => ({
    status: 200,
    body: snapshot('mbta', 'MBTA', [vehicle('b', 42.36, -71.06, reported())], {
      fetchedAt: Date.now(),
    }),
  }));
  app.layer.enable(app.viewer);
  await app.layer.update();
  app.settle();
  const entry = app.vehicles()[0];
  assert.ok(Math.abs(entry.heightM - 11.5) < 1, 'it starts on the low ground');

  // The destination's surface is already known — a hundred metres uphill — so
  // the poll resolves it immediately, on the fix that stands there.
  app.ground._warm.set(app.ground._key(42.362, -71.06), 100);
  app.advance(TRANSIT_POLL_MS);
  app.serve('mbta', () => ({
    status: 200,
    body: snapshot('mbta', 'MBTA', [vehicle('b', 42.362, -71.06, reported())], {
      fetchedAt: Date.now(),
    }),
  }));
  await app.layer.update();
  assert.ok(Math.abs(entry.heightM - 101.5) < 1, 'the destination is uphill');
  const height = () =>
    Cesium.Cartographic.fromCartesian(entry.marker.position).height;
  app.run(400);
  assert.ok(
    height() < 30,
    `still on the ground it is drawn on, got ${height().toFixed(1)} m`,
  );

  // Halfway along the segment it is halfway up; at the end, on the high ground.
  const firstFixAt = start - AGE_MS;
  app.run(firstFixAt + LAG_MS + TRANSIT_POLL_MS / 2 - Date.now());
  assert.ok(
    Math.abs(height() - 11.5) < 3,
    `at the corridor floor, got ${height().toFixed(1)} m`,
  );
  app.run(TRANSIT_POLL_MS);
  assert.ok(
    Math.abs(height() - 101.5) < 1.5,
    `and arrives on the high ground, got ${height().toFixed(1)} m`,
  );
});
test('a lone impossible fix leaves the displayed vehicle and health untouched', async (t) => {
  const app = harness(t, { floorAt: () => 5 });
  app.serve('mbta', () => ({
    status: 200,
    body: snapshot('mbta', 'MBTA', [vehicle('b', 42.36, -71.06, reported())], {
      fetchedAt: Date.now(),
    }),
  }));
  app.layer.enable(app.viewer);
  await app.layer.update();
  app.settle();
  const entry = app.vehicles()[0];

  // Eleven kilometres in one poll: 2,600 km/h.
  app.advance(TRANSIT_POLL_MS);
  app.serve('mbta', () => ({
    status: 200,
    body: snapshot('mbta', 'MBTA', [vehicle('b', 42.46, -71.06, reported())], {
      fetchedAt: Date.now(),
    }),
  }));
  await app.layer.update();

  assert.equal(
    entry.sample.fromSeq,
    entry.sample.toSeq,
    'no segment was started',
  );
  assert.equal(app.state()._moving.has(entry), false);
  assert.equal(entry.fixes.length, 1, 'the accepted history is preserved');
  assert.equal(entry.resets, 0, 'one bad fix cannot reset playback');
  assert.deepEqual(
    [entry.to.lat, entry.to.lon],
    [42.36, -71.06],
    'it remains at its accepted position',
  );
  assert.ok(Math.abs(lat(entry) - 42.36) < 1e-6);
});
test('the detection metric says what the display is doing, not what the feed claims', async (t) => {
  const app = harness(t);
  app.serve('mbta', () => ({
    status: 200,
    body: snapshot(
      'mbta',
      'MBTA',
      [
        vehicle('m', 42.36, -71.06, Date.now() / 1000, {
          routeId: 'Green-C',
          status: 'STOPPED_AT',
          stopId: '49001',
        }),
      ],
      { fetchedAt: Date.now() },
    ),
  }));
  app.layer.enable(app.viewer);
  await app.layer.update();
  app.settle();

  // It moves; the feed still says STOPPED_AT.
  app.advance(TRANSIT_POLL_MS);
  app.serve('mbta', () => ({
    status: 200,
    body: snapshot(
      'mbta',
      'MBTA',
      [
        vehicle('m', 42.362, -71.06, Date.now() / 1000, {
          routeId: 'Green-C',
          status: 'STOPPED_AT',
          stopId: '49001',
        }),
      ],
      { fetchedAt: Date.now() },
    ),
  }));
  await app.layer.update();
  app.advance(2_000);
  app.frame();

  const [contact] = app.layer.getDetectableObjects({ maxCount: 5, seed: 0 });
  assert.ok(contact, 'the vehicle is a contact');
  assert.equal(
    contact.metric.includes('STOPPED'),
    false,
    `a moving vehicle is not stopped, got "${contact.metric}"`,
  );
  assert.equal(contact.id, 'GREEN-C');
  assert.ok(
    contact.klass.includes('METRO') || contact.klass.includes('TRAM'),
    `the class carries the mode, got "${contact.klass}"`,
  );
});

test('the card keeps the operator claim as a report and says the mode plainly', async (t) => {
  const app = harness(t);
  app.serve('mbta', () => ({
    status: 200,
    body: snapshot(
      'mbta',
      'MBTA',
      [
        vehicle('m', 42.36, -71.06, Date.now() / 1000, {
          routeId: 'Red',
          status: 'STOPPED_AT',
          stopId: '49001',
        }),
      ],
      { fetchedAt: Date.now() },
    ),
  }));
  app.layer.enable(app.viewer);
  await app.layer.update();
  app.settle();

  const entry = app.vehicles()[0];
  app.layer._transitPartsForTest().selection.selectVehicle(entry.key);
  const card = app.overlaySources.get('transit-selected')?.[0];
  assert.ok(card, 'a card is shown');
  const text = card.details.join(' | ');
  assert.match(text, /Subway/, 'the mode is said in words');
  assert.match(text, /Last report: stopped at stop 49001/);
  assert.match(
    text,
    /Shown at street level/,
    'and the surface caveat is stated',
  );
});

test('a vehicle reporting every 30 s moves continuously at its own speed', async (t) => {
  // Measured on the live MBTA feed: half the fleet updates every thirty
  // seconds while the browser polls every fifteen. Gliding over a fixed poll
  // interval drew that half-minute of travel in fifteen seconds and then left
  // the fleet perfectly still for the other fifteen — 46 vehicles moving, then
  // zero, then 43, then zero. Played back a lag behind, the segment takes the
  // thirty seconds the fixes describe and runs straight into the next one.
  const app = harness(t, { floorAt: () => 5 });
  const start = Date.now();
  const firstFixAt = start - AGE_MS;
  let fixAt = firstFixAt;
  let north = 42.36;
  app.serve('mbta', () => ({
    status: 200,
    body: snapshot(
      'mbta',
      'MBTA',
      [vehicle('b', north, -71.06, fixAt / 1000)],
      {
        fetchedAt: Date.now(),
      },
    ),
  }));
  app.layer.enable(app.viewer);
  await app.layer.update();
  app.settle();
  const entry = app.vehicles()[0];

  // Polls at 15 s (a repeat), 30 s (moved 0.0025°), 45 s (repeat), 60 s (moved)…
  const samples = [];
  // Each poll lands at the end of the previous fifteen frames, the way the
  // manager tick does in the app: frames run continuously between polls.
  for (let poll = 1; poll <= 6; poll += 1) {
    if (poll % 2 === 0) {
      fixAt += 2 * TRANSIT_POLL_MS;
      north += 0.0025;
    }
    await app.layer.update();
    for (let f = 0; f < 15; f += 1) {
      app.advance(1_000);
      app.frame();
      samples.push({ at: Date.now(), lat: lat(entry), playT: entry.playT });
    }
  }
  // A thirty-second reporter under a thirty-five-second prior holds once,
  // before its first segment: nobody knows its cadence until the second fix
  // arrives, and the hold is what earns it the longer lag. From the first
  // frame it moves, the clock runs at exactly one second per second with no
  // dead interval, and the drawn speed is the fix speed.
  const firstMove = samples.findIndex(
    (s, i) => i > 0 && s.lat !== samples[i - 1].lat,
  );
  assert.ok(firstMove > 0, 'it starts moving');
  const playing = samples.filter(
    (s, i) => i >= firstMove && s.playT < entry.fixes.at(-1).t,
  );
  assert.ok(
    playing.length >= 40,
    `long enough to judge (${playing.length} samples)`,
  );
  for (let i = 1; i < playing.length; i += 1) {
    const dPlay = playing[i].playT - playing[i - 1].playT;
    const dWall = playing[i].at - playing[i - 1].at;
    // 1x, or the 0.95x it runs at while banking the longer lag it has just
    // learned it needs — never a freeze, never a rush.
    assert.ok(
      dPlay <= dWall + 1 && dPlay >= 0.95 * dWall - 1,
      `no freeze and no rush (${dPlay} ms of play in ${dWall} ms)`,
    );
    const metresPerS =
      ((playing[i].lat - playing[i - 1].lat) * 111_320) / (dWall / 1000);
    const fixSpeed = (0.0025 * 111_320) / ((2 * TRANSIT_POLL_MS) / 1000);
    assert.ok(
      metresPerS <= fixSpeed * 1.01 + 0.05 &&
        metresPerS >= fixSpeed * 0.94 - 0.05,
      `at the fix speed: ${metresPerS.toFixed(2)} vs ${fixSpeed.toFixed(2)} m/s`,
    );
  }
});

test('the selected card anchors to the live marker every frame and republishes text only on change', async (t) => {
  // The anchor was a clone refreshed on a 250 ms throttle under a 60 Hz
  // sprite, so the card stepped behind a smooth vehicle. It is a getter now,
  // read by the overlay host on every paint; the text keeps its throttle and
  // is re-sent only when it has changed.
  const app = harness(t);
  const start = Date.now();
  app.serve('mbta', () => ({
    status: 200,
    body: snapshot('mbta', 'MBTA', [vehicle('b', 42.36, -71.06, reported())], {
      fetchedAt: Date.now(),
    }),
  }));
  app.layer.enable(app.viewer);
  await app.layer.update();
  // Its floor resolves, so the marker is shown: a hidden vehicle has no card.
  app.settle();
  const entry = app.vehicles()[0];
  const published = [];
  app.layer._setTransitOverlayHostForTest({
    setEntries: (id, entries) => published.push(entries[0]),
    setVisible() {},
    clearSource() {},
  });
  app.layer._transitPartsForTest().selection.selectVehicle(entry.key);
  assert.equal(published.length, 1);
  const card = published[0];
  assert.equal(typeof card.position, 'function', 'the anchor is a getter');

  app.advance(TRANSIT_POLL_MS);
  app.serve('mbta', () => ({
    status: 200,
    body: snapshot(
      'mbta',
      'MBTA',
      [vehicle('b', 42.3625, -71.0625, reported())],
      {
        fetchedAt: Date.now(),
      },
    ),
  }));
  await app.layer.update();
  // Frames at 16 ms through the segment: the anchor never lags the marker,
  // whether or not a card refresh happened to run.
  const firstFixAt = start - AGE_MS;
  app.advance(firstFixAt + LAG_MS + 2_000 - Date.now());
  let worst = 0;
  for (let f = 0; f < 60; f += 1) {
    app.advance(16);
    app.frame();
    const anchor = card.position();
    worst = Math.max(
      worst,
      Cesium.Cartesian3.distance(anchor, entry.marker.position),
    );
  }
  assert.ok(
    worst < 1e-6,
    `the anchor is the marker's own position (worst gap ${worst} m)`,
  );
  assert.ok(app.state()._moving.has(entry), 'and it was moving throughout');

  // The text: throttled, and republished only when it changes. Sixty frames
  // of one second is sixty throttle windows, but the card copy only changes
  // when the reported age or the motion state does.
  const before = published.length;
  for (let f = 0; f < 5; f += 1) {
    app.advance(16);
    app.frame();
  }
  assert.equal(
    published.length,
    before,
    'identical text within a second is not re-sent',
  );

  // A hidden marker anchors nothing.
  entry.marker.show = false;
  assert.equal(card.position(), null);
});

test('DETECT gets the same candidate list back until something could have changed it', async (t) => {
  // Detection pulls the list on every paint. It used to be a fleet scan with
  // an allocation and, above the cap, a sort — on the demo path, sixty times
  // a second. The list is rebuilt on polls, visibility sweeps, removals and
  // selection, and handed back as-is between them.
  const app = harness(t);
  const fleet = () =>
    Array.from({ length: 40 }, (_, i) =>
      vehicle(`v${i}`, 42.36 + i * 0.0002, -71.06, reported(), {
        routeId: `${i}`,
      }),
    );
  app.serve('mbta', () => ({
    status: 200,
    body: snapshot('mbta', 'MBTA', fleet(), { fetchedAt: Date.now() }),
  }));
  app.layer.enable(app.viewer);
  await app.layer.update();
  app.settle();

  const first = app.layer.getDetectableObjects({ maxCount: 10, seed: 7 });
  assert.equal(first.length, 10);
  const again = app.layer.getDetectableObjects({ maxCount: 10, seed: 7 });
  assert.equal(again, first, 'the same array, not a rebuilt one');
  app.layer.getDetectableObjects({ maxCount: 5, seed: 7 });
  app.advance(250);
  app.layer._transitPartsForTest().queries.refreshDetectCache();
  const other = app.layer.getDetectableObjects({ maxCount: 5, seed: 7 });
  assert.notEqual(other, first, 'a different cap is a different list');
  assert.equal(other.length, 5);

  // Positions are the markers' own Cartesians: live, no copy.
  const entry = app.vehicles().find((v) => v.key === first[0].sourceId);
  assert.equal(first[0].position, entry.marker.position);
  assert.equal(first[0].id, entry.record.routeId);

  // Selecting a vehicle changes what the list says, so it is rebuilt.
  app.layer._transitPartsForTest().selection.selectVehicle(first[0].sourceId);
  app.layer.getDetectableObjects({ maxCount: 10, seed: 7 });
  app.advance(250);
  app.layer._transitPartsForTest().queries.refreshDetectCache();
  const afterSelect = app.layer.getDetectableObjects({ maxCount: 10, seed: 7 });
  assert.notEqual(afterSelect, first);
  assert.equal(afterSelect[0].skipLabel, true);

  // A poll rebuilds it; removing an UNSELECTED vehicle leaves the chosen set.
  const chosenBefore = afterSelect.map((c) => c.sourceId);
  app.advance(TRANSIT_POLL_MS);
  await app.layer.update();
  app.settle();
  app.layer._transitPartsForTest().queries.refreshDetectCache();
  const afterPoll = app.layer.getDetectableObjects({ maxCount: 10, seed: 7 });
  assert.notEqual(afterPoll, afterSelect, 'rebuilt after the poll');
  assert.deepEqual(
    afterPoll.map((c) => c.sourceId),
    chosenBefore,
    'same stable selection',
  );
});

test('under FLIR and NVG every sprite is white-hot with a dark halo, and selection cannot undo it', async (t) => {
  const app = harness(t);
  app.serve('mbta', () => ({
    status: 200,
    body: snapshot(
      'mbta',
      'MBTA',
      [
        vehicle('bus', 42.36, -71.06, reported(), { routeId: '742' }),
        vehicle('metro', 42.361, -71.06, reported(), { routeId: 'Red' }),
        vehicle('tram', 42.362, -71.06, reported(), { routeId: 'Green-E' }),
      ],
      { fetchedAt: Date.now() },
    ),
  }));
  app.layer.enable(app.viewer);
  await app.layer.update();
  app.settle();
  const byRoute = new Map(app.vehicles().map((v) => [v.record.routeId, v]));
  const bus = byRoute.get('742');
  const plainImage = bus.marker.image;
  const plainWidth = bus.marker.width;
  const modeColour = bus.marker.color.clone();

  app.style('thermal');
  for (const entry of app.vehicles()) {
    assert.ok(
      Cesium.Color.equals(entry.marker.color, Cesium.Color.WHITE),
      `${entry.record.routeId} is white-hot`,
    );
    assert.notEqual(entry.marker.image, plainImage, 'a haloed raster');
    assert.match(
      Buffer.from(entry.marker.image.split(',')[1], 'base64').toString(),
      /#000000/,
      'with the dark ring',
    );
    assert.ok(entry.marker.width > plainWidth * 1.2, 'and larger');
  }
  // Selecting under FLIR grows the sprite and keeps it white — cyan would dim it.
  app.layer._transitPartsForTest().selection.selectVehicle(bus.key);
  assert.ok(
    Cesium.Color.equals(bus.marker.color, Cesium.Color.WHITE),
    'still white when selected',
  );
  assert.ok(
    bus.marker.width > byRoute.get('Red').marker.width,
    'and bigger than its neighbours',
  );
  app.layer._transitPartsForTest().selection.clearSelection();
  assert.ok(
    Cesium.Color.equals(bus.marker.color, Cesium.Color.WHITE),
    'and white when deselected',
  );
  assert.equal(bus.marker.width, byRoute.get('Red').marker.width);

  // Back to normal: the shipped look, exactly.
  app.style('normal');
  assert.ok(
    Cesium.Color.equals(bus.marker.color, modeColour),
    'mode colour restored',
  );
  assert.equal(bus.marker.image, plainImage, 'plain raster restored');
  assert.equal(bus.marker.width, plainWidth, 'shipped size restored');
  // A style that is not a sensor changes nothing.
  app.style('anime');
  assert.equal(bus.marker.image, plainImage);
});

test('a cockpit vision override wins over the map style while it lasts, and destroy stops listening', async (t) => {
  const app = harness(t);
  app.serve('mbta', () => ({
    status: 200,
    body: snapshot('mbta', 'MBTA', [vehicle('b', 42.36, -71.06, reported())], {
      fetchedAt: Date.now(),
    }),
  }));
  app.layer.enable(app.viewer);
  await app.layer.update();
  app.settle();
  const entry = app.vehicles()[0];
  const plain = entry.marker.image;
  app.vision('nvg', true);
  assert.ok(
    Cesium.Color.equals(entry.marker.color, Cesium.Color.WHITE),
    'cockpit NVG restyles',
  );
  app.style('normal');
  assert.ok(
    Cesium.Color.equals(entry.marker.color, Cesium.Color.WHITE),
    'the map style cannot undo a live cockpit override',
  );
  app.vision('normal', false);
  assert.equal(
    entry.marker.image,
    plain,
    'leaving the cockpit restores the map style',
  );
  assert.equal(app.state()._styleListeners.length, 2);
  app.layer.destroy(app.viewer);
  assert.equal(app.state()._styleListeners.length, 0, 'listeners removed');
  assert.doesNotThrow(
    () => app.style('thermal'),
    "and a later event is nobody's business",
  );
});

test('DETECT contacts carry a bracket tier per mode, keyed or keyless alike', async (t) => {
  const app = harness(t);
  app.serve('mbta', () => ({
    status: 200,
    body: snapshot(
      'mbta',
      'MBTA',
      [
        vehicle('bus', 42.36, -71.06, reported(), { routeId: '742' }),
        vehicle('metro', 42.361, -71.06, reported(), { routeId: 'Red' }),
        vehicle('tram', 42.362, -71.06, reported(), { routeId: 'Green-E' }),
      ],
      { fetchedAt: Date.now() },
    ),
  }));
  app.layer.enable(app.viewer);
  await app.layer.update();
  app.settle();
  const tiers = new Map(
    app.layer.getDetectableObjects().map((c) => [c.id, c.tier]),
  );
  assert.equal(tiers.get('742'), 'transit_bus');
  assert.equal(tiers.get('RED'), 'transit_subway');
  assert.equal(tiers.get('GREEN-E'), 'transit_tram');
});

test('the floor cycle samples the rendered mesh for the cells it warms, with its own sprites excluded', async (t) => {
  // A transit-only session never warmed a mesh floor: the layer warmed the
  // DEM and stopped, so under a photogrammetric city it drew on bare earth
  // seventeen metres down. The same cells now go to the application's mesh
  // sampler after every warm — bounded by the sampler's own per-call cap and
  // proximity gate — with the layer's billboards excluded so a vertical probe
  // cannot land on a bus.
  const app = harness(t, { floorAt: () => 5 });
  app.serve('mbta', () => ({
    status: 200,
    body: snapshot(
      'mbta',
      'MBTA',
      [
        vehicle('a', 42.36, -71.06, reported()),
        vehicle('b', 42.37, -71.07, reported()),
        vehicle('far', 42.62, -71.44, reported()),
      ],
      { fetchedAt: Date.now() },
    ),
  }));
  app.layer.enable(app.viewer);
  await app.layer.update();
  app.settle();
  assert.ok(
    app.meshCalls.length >= 1,
    'the sampler was asked after the floor resolved',
  );
  const call = app.meshCalls[0];
  assert.equal(call.scene, app.viewer.scene);
  assert.deepEqual(
    call.points.map((p) => p.lat).sort(),
    [42.36, 42.37],
    'the in-view cells, and not the one off screen',
  );
  assert.equal(
    call.options.excludeObjects.length,
    2,
    'both in-view billboards excluded',
  );
  assert.ok(
    Math.abs(call.options.viewerLat - BOSTON.lat) < 1e-6,
    'viewer subpoint in degrees',
  );
  assert.ok(Math.abs(call.options.viewerLon - BOSTON.lon) < 1e-6);
});

test('a failing prefix of cells cannot starve the vehicle behind it of a floor', async (t) => {
  // Codex's reproduction: 301 visible cold entries, the first 300 in cells
  // that never resolve. The budget used to take the first 300 unresolved
  // vehicles in map order every cycle, so the 301st was never even asked for.
  const count = FLOOR_WARM_PER_POLL + 1;
  const app = harness(t, {
    // Only the LAST vehicle's cell ever answers.
    floorAt: (lat) =>
      Math.abs(lat - (42.36 + (count - 1) * 0.002)) < 1e-9 ? 12 : undefined,
    view: { west: -71.2, south: 42.3, east: -70.9, north: 43.2 },
  });
  const fleet = Array.from({ length: count }, (_, i) =>
    vehicle(`v${i}`, 42.36 + i * 0.002, -71.06, reported()),
  );
  app.serve('mbta', () => ({
    status: 200,
    body: snapshot('mbta', 'MBTA', fleet, { fetchedAt: Date.now() }),
  }));
  app.layer.enable(app.viewer);
  await app.layer.update();
  // The unique-cell budget resets per poll; the next poll rotates priority.
  app.settle(3);
  app.advance(TRANSIT_POLL_MS);
  await app.layer.update();
  app.settle(3);
  const last = app.vehicles().find((v) => v.record.id === `v${count - 1}`);
  assert.equal(last.heightResolved, true, 'the 301st vehicle got its floor');
  assert.ok(Math.abs(last.heightM - 13.5) < 1e-9);
  assert.ok(
    app.ground._warmed.some((p) => Math.abs(p.lat - last.record.lat) < 1e-9),
    'because its cell was actually asked for',
  );
});

test('a resolved floor still adopts a later mesh sample or a regime change on a parked vehicle', async (t) => {
  // Codex's reproduction: resolve the DEM at 10 m, then the shared floor
  // changes to a 50 m mesh sample; the parked entry kept 11.5 m for ever
  // because ingestion only re-read a resolved height when the cell changed.
  const app = harness(t, { floorAt: () => 10 });
  app.serve('mbta', () => ({
    status: 200,
    body: snapshot('mbta', 'MBTA', [vehicle('p', 42.36, -71.06, reported())], {
      fetchedAt: Date.now(),
    }),
  }));
  app.layer.enable(app.viewer);
  await app.layer.update();
  app.settle();
  const entry = app.vehicles()[0];
  assert.ok(Math.abs(entry.heightM - 11.5) < 1e-9, 'DEM floor, lifted');
  const height = () =>
    Cesium.Cartographic.fromCartesian(entry.marker.position).height;
  assert.ok(Math.abs(height() - 11.5) < 0.5);

  // The mesh lands on the same cell.
  app.ground._warm.set(app.ground._key(42.36, -71.06), 50);
  app.advance(TRANSIT_POLL_MS);
  await app.layer.update();
  app.frame();
  assert.ok(
    Math.abs(entry.heightM - 51.5) < 1e-9,
    'the parked vehicle adopts the mesh floor',
  );
  assert.ok(Math.abs(height() - 51.5) < 0.5, 'and is drawn on it');

  // Leaving the photoreal regime: the shared floor answers the DEM again.
  app.ground._warm.set(app.ground._key(42.36, -71.06), 10);
  app.advance(TRANSIT_POLL_MS);
  await app.layer.update();
  app.frame();
  assert.ok(Math.abs(height() - 11.5) < 0.5, 'and follows it back down');
});

test('a stamp an hour ahead is bounded, so the honest fixes that follow are not refused', async (t) => {
  // Codex's reproduction: the first fix stamped one hour ahead, then a
  // corrected clock and normal travel. The marker stayed at its first
  // position for as long as the wrong clock stayed newer than real time, and
  // survived eviction because every refused snapshot refreshed its record.
  const app = harness(t, { floorAt: () => 5 });
  const ahead = (Date.now() + 3_600_000) / 1000;
  app.serve('mbta', () => ({
    status: 200,
    body: snapshot('mbta', 'MBTA', [vehicle('c', 42.36, -71.06, ahead)], {
      fetchedAt: Date.now(),
    }),
  }));
  app.layer.enable(app.viewer);
  await app.layer.update();
  app.settle();
  const entry = app.vehicles()[0];
  assert.ok(
    entry.fixes[0].t <= Date.now() + FUTURE_STAMP_TOLERANCE_MS,
    'the stamp is bounded by the fetch time',
  );
  // The clock is corrected; the bus travels north 200 m per poll.
  let north = 42.36;
  for (let poll = 1; poll <= 4; poll += 1) {
    app.advance(TRANSIT_POLL_MS);
    north += 0.0018;
    const fixAtS = (Date.now() - 2_000) / 1000;
    app.serve('mbta', () => ({
      status: 200,
      body: snapshot('mbta', 'MBTA', [vehicle('c', north, -71.06, fixAtS)], {
        fetchedAt: Date.now(),
      }),
    }));
    await app.layer.update();
  }
  assert.ok(
    entry.fixes.length >= 3,
    `honest fixes were accepted (${entry.fixes.length} in history)`,
  );
  assert.equal(entry.track.pendingCount, 0);
  app.run(120_000);
  assert.ok(
    Math.abs(lat(entry) - 42.36) > 0.003,
    'and the marker has moved on',
  );
});

test('a run of out-of-order fixes restarts the history instead of freezing the vehicle', async (t) => {
  const app = harness(t, { floorAt: () => 5 });
  const later = (Date.now() + 5_000) / 1000; // within tolerance, but newer than what follows
  app.serve('mbta', () => ({
    status: 200,
    body: snapshot('mbta', 'MBTA', [vehicle('o', 42.36, -71.06, later)], {
      fetchedAt: Date.now(),
    }),
  }));
  app.layer.enable(app.viewer);
  await app.layer.update();
  app.settle();
  const entry = app.vehicles()[0];
  const firstRecord = entry.record;
  // The feed's clock steps BACK: every following stamp is older than the first.
  for (let poll = 1; poll <= ORDER_REJECTS_BEFORE_RESET; poll += 1) {
    app.advance(TRANSIT_POLL_MS);
    const stale = later - 60 + poll;
    app.serve('mbta', () => ({
      status: 200,
      body: snapshot(
        'mbta',
        'MBTA',
        [vehicle('o', 42.365, -71.06, stale, { label: `poll${poll}` })],
        {
          fetchedAt: Date.now(),
        },
      ),
    }));
    await app.layer.update();
    if (poll < ORDER_REJECTS_BEFORE_RESET) {
      assert.equal(
        entry.record,
        firstRecord,
        `refusal ${poll} does not refresh the record`,
      );
      assert.equal(entry.track.pendingCount, poll);
    }
  }
  assert.equal(
    entry.track.pendingCount,
    0,
    'reset after three advancing observations',
  );
  assert.equal(entry.fixes.length, 2);
  app.settle();
  assert.equal(entry.resets, 1);
  assert.ok(
    Math.abs(lat(entry) - 42.365) < 1e-6,
    'placed at the fix it restarted from',
  );
});

test('selected trail and marker share revised start floors, with unknown history left as gaps', async (t) => {
  const app = harness(t, { floorAt: () => 10 });
  let position = 42.36;
  app.serve('mbta', () => ({
    status: 200,
    body: snapshot(
      'mbta',
      'MBTA',
      [vehicle('trail', position, -71.06, reported())],
      { fetchedAt: Date.now() },
    ),
  }));
  app.layer.enable(app.viewer);
  await app.layer.update();
  app.settle();
  app.advance(15000);
  position += 0.0001;
  await app.layer.update();
  app.settle();
  const entry = app.vehicles()[0],
    parts = app.layer._transitPartsForTest();
  parts.selection.selectVehicle(entry.key);
  app.run(8000, 16);
  let trail = parts.trails.diagnostics();
  assert.ok(trail.segments > 0);
  assert.equal(trail.entitiesAdded, 0);
  assert.ok(
    Cesium.Cartesian3.equals(
      trail.head.positions.at(-1),
      entry.marker.position,
    ),
  );
  const body = trail.body,
    revision = trail.revision;
  app.run(1000, 16);
  assert.equal(parts.trails.diagnostics().body, body);
  app.ground._warm.set(app.ground._key(42.36, -71.06), 30);
  parts.height.rereadFloors();
  app.frame();
  trail = parts.trails.diagnostics();
  assert.ok(trail.revision > revision);
  assert.ok(
    Cesium.Cartesian3.equals(
      trail.head.positions.at(-1),
      entry.marker.position,
    ),
  );
  assert.ok(
    Cesium.Cartographic.fromCartesian(entry.marker.position).height > 30,
  );
  assert.ok(entry.trailVertices <= 640);
  parts.selection.clearSelection();
  assert.equal(parts.trails.diagnostics(), null);
});

test('selection restores retained history without changing clock or health; churn aborts late reads', async (t) => {
  const app = harness(t);
  app.serve('mbta', () => ({
    status: 200,
    body: snapshot('mbta', 'MBTA', [vehicle('b', 42.36, -71.06, reported())], {
      fetchedAt: Date.now(),
    }),
  }));
  app.layer.enable(app.viewer);
  await app.layer.update();
  app.settle();
  const entry = app.vehicles()[0],
    parts = app.layer._transitPartsForTest();
  const liveT = entry.fixes[0].t;
  const payload = {
    version: 1,
    feedId: 'mbta',
    vehicleId: 'b',
    oldestT: liveT - 30000,
    newestT: liveT,
    truncated: false,
    epochs: [{ id: 1, trip: '', route: '1', mode: 'bus' }],
    fixes: [
      [liveT - 30000, 42.359, -71.06, 1, 1],
      [liveT - 15000, 42.3595, -71.06, 1, 1],
      [liveT, 42.37, -71.06, 1, 1],
    ],
  };
  const priorFetch = globalThis.fetch;
  let complete,
    signal,
    requests = 0;
  globalThis.fetch = (url, options) => {
    if (!String(url).includes('/trail/')) return priorFetch(url, options);
    requests++;
    signal = options.signal;
    return new Promise((resolve) => {
      complete = () => resolve(new Response(JSON.stringify(payload)));
    });
  };
  const health = entry.track.acceptedAt,
    clock = entry.playT;
  parts.selection.selectVehicle(entry.key);
  complete();
  for (let i = 0; i < 20; i++) await Promise.resolve();
  assert.equal(entry.track.count, 3);
  assert.equal(
    entry.fixes.at(-1).lat,
    42.36,
    'live position wins the conflict',
  );
  assert.equal(entry.track.acceptedAt, health);
  assert.equal(entry.playT, clock);
  assert.equal(requests, 1);
  parts.selection.selectVehicle(entry.key);
  assert.equal(requests, 2);
  parts.selection.clearSelection();
  assert.equal(signal.aborted, true);
  const count = entry.track.count;
  complete();
  for (let i = 0; i < 20; i++) await Promise.resolve();
  assert.equal(entry.track.count, count);
  assert.equal(parts.trails.requestDiagnostics().pending, false);
  parts.selection.selectVehicle(entry.key);
  app.layer.disable(app.viewer);
  assert.equal(signal.aborted, true);
  complete();
  for (let i = 0; i < 20; i++) await Promise.resolve();
  assert.equal(app.vehicles().length, 0);
});

test('a long selected history shortens its oldest geometry before sacrificing the active corridor', async (t) => {
  const app = harness(t);
  const parts = app.layer._transitPartsForTest();
  const { mergeHistory, seek } = await import('../../data/contactPlayback.js');
  app.serve('mbta', () => ({
    status: 200,
    body: snapshot(
      'mbta',
      'MBTA',
      [vehicle('long', 42.36, -71.06, reported(), { routeId: 'CR-1' })],
      { fetchedAt: Date.now() },
    ),
  }));
  app.layer.enable(app.viewer);
  await app.layer.update();
  app.settle();
  const entry = app.vehicles()[0],
    newest = entry.fixes[0].t;
  mergeHistory(
    entry.track,
    Array.from({ length: 100 }, (_, i) => ({
      t: newest - (99 - i) * 15000,
      lat: 42.36 - (99 - i) * 0.009,
      lon: -71.06,
      epoch: entry.currentEpoch,
    })),
  );
  for (let i = 0; i < 1000; i++)
    app.ground._warm.set(app.ground._key(41.45 + i * 0.001, -71.06), 12);
  seek(entry.track, newest - 7500, {
    wallNowMs: Date.now(),
    monoNowMs: performance.now(),
  });
  parts.rendering.sampleIdle(entry);
  parts.selection.selectVehicle(entry.key);
  assert.equal(entry.trailTruncated, true);
  assert.ok(entry.trailVertices <= 640);
  assert.ok(
    entry.displayPaths.has(entry.sample.fromSeq),
    'active path is prepared first',
  );
  assert.ok(
    entry.trailSegments.every(
      (segment, i, list) => i === 0 || list[i - 1].fromT <= segment.fromT,
    ),
  );
});

test('missing rectangle still rejects the far side, and frustum rejection wins', async (t) => {
  const app = harness(t, { altitude: 100_000 });
  app.viewer.camera.computeViewRectangle = () => undefined;
  app.serve('mbta', () => ({
    status: 200,
    body: snapshot(
      'mbta',
      'MBTA',
      [
        vehicle('near', 42.36, -71.06, reported()),
        vehicle('far', -42.36, 108.94, reported()),
      ],
      { fetchedAt: Date.now() },
    ),
  }));
  app.layer.enable(app.viewer);
  await app.layer.update();
  app.advance(250);
  app.frame();
  assert.deepEqual(
    [...app.state()._visible].map((e) => e.record.id),
    ['near'],
  );
  app.viewer.camera.frustum = {
    computeCullingVolume: () => ({
      computeVisibility: () => Cesium.Intersect.OUTSIDE,
    }),
  };
  app.advance(250);
  app.layer._transitPartsForTest().rendering.refreshVisibility();
  assert.equal(app.state()._visible.size, 0);
  assert.equal(app.state()._moving.size, 0);
  assert.equal(app.holds().includes('transit'), false);
});

test('motion transitions migrate billboards and update cached positions; disable clears owners', async (t) => {
  const app = harness(t);
  let latitude = 42.36;
  app.serve('mbta', () => ({
    status: 200,
    body: snapshot(
      'mbta',
      'MBTA',
      [vehicle('bus', latitude, -71.06, reported())],
      { fetchedAt: Date.now() },
    ),
  }));
  app.layer.enable(app.viewer);
  await app.layer.update();
  app.settle();
  const entry = app.vehicles()[0];
  const old = entry.marker;
  app.layer.getDetectableObjects();
  app.advance(15000);
  latitude += 0.001;
  await app.layer.update();
  app.run(8000, 16);
  assert.equal(entry.markerCollection, app.state()._animatedMarkers);
  assert.notEqual(entry.marker, old);
  assert.equal(entry.detectContact.position, entry.marker.position);
  app.run(30000, 16);
  assert.equal(entry.markerCollection, app.state()._markers);
  const parts = app.layer._transitPartsForTest();
  const contacts = app.layer.getDetectableObjects();
  const metric = contacts[0].metric;
  for (let i = 0; i < 20; i++) {
    assert.equal(app.layer.getDetectableObjects(), contacts);
    assert.equal(contacts[0].metric, metric);
  }
  parts.rendering.requestVisibility();
  app.layer.disable(app.viewer);
  assert.equal(app.state()._detectCache, null);
  assert.equal(entry.detectContact, null);
  assert.equal(app.state()._visible.size, 0);
  assert.equal(app.state()._visibilityTimer, null);
  assert.equal(app.state()._maintenanceTimer, null);
  assert.equal(entry.wakeTimer, null);
  assert.equal(app.state()._inFlight.size, 0);
  assert.equal(parts.trails.requestDiagnostics().pending, false);
});

test('every styling path retains the mode palette and exact unpadded size', async (t) => {
  const app = harness(t);
  app.serve('mbta', () => ({
    status: 200,
    body: snapshot(
      'mbta',
      'MBTA',
      [vehicle('bus', 42.36, -71.06, reported(), { routeId: '741' })],
      { fetchedAt: Date.now() },
    ),
  }));
  app.layer.enable(app.viewer);
  await app.layer.update();
  app.settle();
  const entry = app.vehicles()[0],
    parts = app.layer._transitPartsForTest();
  const check = (hex, display) => {
    assert.equal(entry.marker.color.toCssHexString().toUpperCase(), hex);
    const svg = Buffer.from(
      entry.marker.image.split(',')[1],
      'base64',
    ).toString();
    const width = Number(svg.match(/viewBox="-\d+ -\d+ (\d+)/)[1]);
    assert.ok(Math.abs((entry.marker.width * 96) / width - display) < 1e-9);
  };
  check('#5EF08A', 20);
  parts.selection.selectVehicle(entry.key);
  check('#5EF08A', 30);
  parts.rendering.paintMode(entry, 'subway');
  check('#FF4538', 30);
  app.style('thermal');
  check('#FFFFFF', 39);
  parts.selection.clearSelection();
  check('#FFFFFF', 26);
  app.vision('nvg', true);
  check('#FFFFFF', 26);
  parts.selection.selectVehicle(entry.key);
  check('#FFFFFF', 39);
  app.vision('normal', false);
  check('#FF4538', 30);
  parts.selection.clearSelection();
  check('#FF4538', 20);
});

test('QA fleets at both budgets exercise real marker motion', async (t) => {
  const app = harness(t, { altitude: 30000 });
  app.layer.enable(app.viewer);
  await app.layer.update();
  for (const count of [800, 3000]) {
    const loaded = app.layer._loadTransitFleetForTest(count, BOSTON, 1);
    assert.equal(loaded.count, count);
    assert.equal(loaded.moving, count);
    assert.equal(loaded.fixBytes, count * 128 * 48);
    const entry = app.vehicles()[0];
    const before = Cesium.Cartesian3.clone(entry.marker.position);
    app.advance(100);
    app.frame();
    assert.ok(Cesium.Cartesian3.distance(before, entry.marker.position) > 0.09);
  }
});

test('visible motion is recullable without a camera event and releases its hold offscreen', async (t) => {
  const app = harness(t, { altitude: 30000 });
  app.layer.enable(app.viewer);
  await app.layer.update();
  app.layer._loadTransitFleetForTest(1, BOSTON, 1);
  assert.equal(app.state()._moving.size, 1);
  app.viewer.camera.frustum = {
    computeCullingVolume: () => ({
      computeVisibility: () => Cesium.Intersect.OUTSIDE,
    }),
  };
  app.layer._transitPartsForTest().rendering.maintainPresentation();
  app.advance(250);
  assert.equal(app.state()._moving.size, 0);
  assert.equal(app.state()._renderHeld, false);
});

test('mesh refinement reaches all 100 retained DEM cells within five poll budgets', async (t) => {
  const { createHeight } = await import('./height.js');
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let mono = 0;
  t.mock.method(performance, 'now', () => mono);
  const cells = Array.from({ length: 100 }, (_, i) => ({
    lat: i / 1000,
    lon: 0,
  }));
  const entry = { key: 'selected', to: cells[0], fixes: [cells.at(-1)] };
  const probed = new Set();
  const state = {
    _enabled: true,
    _selectedKey: entry.key,
    _vehicles: new Map([[entry.key, entry]]),
    _floorCursor: 0,
    _heightDirty: new Set(),
    _viewer: { camera: { positionCartographic: { height: 100 } } },
  };
  const height = createHeight({
    state,
    services: {
      render: { governorRequestRender() {} },
      ground: {
        coarseFloorCoord: (lat, lon) => ({ lat, lon }),
        cachedGroundFloor: () => 10,
        GROUND_FLOOR_LIFT_M: 1.5,
      },
      mesh: {
        sampleMeshFloorCells(scene, points) {
          for (const point of points) probed.add(point.cell);
        },
      },
    },
    parts: {
      trails: {
        prepareEntry(e, collect) {
          if (collect)
            for (const point of cells)
              collect(point, height.requestHeight(point.lat, point.lon));
        },
      },
      rendering: { requestVisibility() {} },
    },
  });
  t.after(() => height.clear());
  for (let poll = 0; poll < 5; poll++) {
    mono = poll * TRANSIT_POLL_MS;
    height.anchorFloors();
  }
  assert.equal(probed.size, 100);
});

test('selection churn releases past geometry on every retained vehicle', async (t) => {
  const app = harness(t, { floorAt: () => 10 });
  const { mergeHistory, seek } = await import('../../data/contactPlayback.js');
  const parts = app.layer._transitPartsForTest();
  app.serve('mbta', () => ({
    status: 200,
    body: snapshot(
      'mbta',
      'MBTA',
      Array.from({ length: 5 }, (_, i) =>
        vehicle(`churn-${i}`, 42.36, -71.06, reported()),
      ),
      { fetchedAt: Date.now() },
    ),
  }));
  app.layer.enable(app.viewer);
  await app.layer.update();
  app.settle();
  for (const entry of app.vehicles()) {
    const newest = entry.fixes[0].t;
    mergeHistory(
      entry.track,
      Array.from({ length: 100 }, (_, i) => ({
        t: newest - (99 - i) * 5000,
        lat: 42.36 - (99 - i) * 0.0001,
        lon: -71.06,
        epoch: entry.currentEpoch,
      })),
    );
    for (let i = 0; i < 20; i++)
      app.ground._warm.set(app.ground._key(42.345 + i * 0.001, -71.06), 10);
    seek(entry.track, newest - 7500, {
      wallNowMs: Date.now(),
      monoNowMs: performance.now(),
    });
    parts.rendering.sampleIdle(entry);
    parts.selection.selectVehicle(entry.key);
    assert.ok(entry.trailSegments.length > 50);
    parts.selection.clearSelection();
    for (const retained of app.vehicles()) {
      assert.equal(retained.trailSegments?.length || 0, 0);
      assert.equal(retained.trailVertices || 0, 0);
      assert.ok(
        [...retained.displayPaths.keys()].every(
          (seq) => seq >= retained.sample.fromSeq,
        ),
      );
    }
    assert.equal(parts.trails.diagnostics(), null);
    assert.equal(
      entry.displayPaths.size,
      2,
      'only active and future corridors remain',
    );
    seek(entry.track, newest - 1000, {
      wallNowMs: Date.now(),
      monoNowMs: performance.now(),
    });
    parts.rendering.sampleIdle(entry);
    assert.equal(
      entry.displayPaths.size,
      1,
      'marker playback releases completed corridors',
    );
  }
});

test('tab visibility synchronizes playback before the returning frame and removes its listener', async (t) => {
  const app = harness(t, { floorAt: () => 10 });
  app.layer.enable(app.viewer);
  app.layer._loadTransitFleetForTest(1, BOSTON, 5);
  app.settle();
  const entry = app.vehicles()[0];
  app.frame();
  const before = entry.playT;
  const resets = entry.track.resets;
  document.visibilityState = 'hidden';
  document.dispatchEvent(new Event('visibilitychange'));
  app.advance(30000);
  document.visibilityState = 'visible';
  document.dispatchEvent(new Event('visibilitychange'));
  assert.equal(entry.track.resetReason, 're-entry');
  assert.equal(entry.track.resets, resets + 1);
  assert.ok(entry.playT > before);
  assert.equal(entry.playT, Date.now() - entry.track.targetDelayMs);
  const synchronized = entry.playT;
  app.frame();
  assert.equal(
    entry.playT,
    synchronized,
    'first frame does not replay hidden elapsed time',
  );
  document.dispatchEvent(new Event('visibilitychange'));
  assert.equal(entry.track.resets, resets + 1, 'visible duplicate is a no-op');
  const remove = t.mock.method(document, 'removeEventListener');
  app.layer.disable(app.viewer);
  assert.ok(
    remove.mock.calls.some((call) => call.arguments[0] === 'visibilitychange'),
  );
});

for (const bounds of ['null', 'stale']) {
  test(`browser visibility starts an injected fleet with ${bounds} bounds and an unsampled hidden marker`, async (t) => {
    const app = harness(t);
    app.viewer.camera.frustum = {
      computeCullingVolume: () => ({
        computeVisibility: () => Cesium.Intersect.INSIDE,
      }),
    };
    app.layer.enable(app.viewer);
    const loaded = app.layer._loadTransitFleetForTest(4, BOSTON, 70, [
      'Red',
      '741',
      '742',
      'Green-E',
    ]);
    const state = app.state(),
      parts = app.layer._transitPartsForTest();
    state._viewBounds =
      bounds === 'null' ? null : { south: 0, north: 1, west: 0, east: 1 };
    for (const entry of app.vehicles()) {
      state._visible.delete(entry);
      state._moving.delete(entry);
      entry.marker.show = false;
      entry.sample = null;
    }
    state._visibilityAt = 0;
    parts.rendering.refreshVisibility();
    assert.equal(state._visible.size, loaded.count);
    assert.equal(state._moving.size, loaded.count);
    assert.equal(app.viewer.scene.requestRenderMode, false);
    const entry = app.vehicles()[0],
      before = Cesium.Cartesian3.clone(entry.marker.position);
    app.run(1000, 16);
    assert.ok(Cesium.Cartesian3.distance(before, entry.marker.position) > 0.9);
  });
}

test('keyless loaded terrain resolves a pending surface without needing a frame first', async (t) => {
  const app = harness(t, { floorAt: () => undefined });
  let floor;
  app.viewer.scene.globe.show = true;
  app.viewer.scene.globe.getHeight = () => floor;
  app.serve('mbta', () => ({
    status: 200,
    body: snapshot(
      'mbta',
      'MBTA',
      [vehicle('bus', 42.36, -71.06, reported())],
      { fetchedAt: Date.now() },
    ),
  }));
  app.layer.enable(app.viewer);
  await app.layer.update();
  const entry = app.vehicles()[0],
    parts = app.layer._transitPartsForTest();
  assert.equal(entry.heightPending, true);
  assert.equal(entry.marker.show, false);
  floor = 12;
  parts.height.rereadFloors();
  app.state()._visibilityAt = 0;
  parts.rendering.refreshVisibility();
  assert.equal(entry.heightPending, false);
  assert.equal(entry.surfaceReady, true);
  assert.equal(entry.marker.show, true);
});

test('scripted keyless fleet keeps its known floor through selection and floor rereads', async (t) => {
  const app = harness(t, { floorAt: () => undefined });
  app.viewer.scene.globe.show = true;
  app.layer.enable(app.viewer);
  app.layer._loadTransitFleetForTest(4, BOSTON, 70);
  const parts = app.layer._transitPartsForTest(),
    entry = app.vehicles()[0];
  parts.selection.selectVehicle(entry.key);
  parts.height.rereadFloors();
  app.run(1000, 16);
  assert.equal(entry.surfaceReady, true);
  assert.equal(entry.marker.show, true);
  assert.ok(entry.trailSegments.length > 0);
  assert.ok(app.state()._moving.has(entry));
});

for (const count of [800, 3000]) {
  test(`real perspective frustum admits all ${count} moving budget fixtures`, async (t) => {
    const altitude = count === 800 ? 600 : 30000;
    const app = harness(t, { altitude, floorAt: () => undefined });
    const camera = app.viewer.camera;
    camera.positionWC = Cesium.Cartesian3.fromDegrees(
      BOSTON.lon,
      BOSTON.lat,
      altitude,
    );
    camera.directionWC = Cesium.Cartesian3.negate(
      Cesium.Ellipsoid.WGS84.geodeticSurfaceNormal(
        camera.positionWC,
        new Cesium.Cartesian3(),
      ),
      new Cesium.Cartesian3(),
    );
    const enu = Cesium.Transforms.eastNorthUpToFixedFrame(camera.positionWC);
    camera.upWC = Cesium.Matrix4.getColumn(enu, 1, new Cesium.Cartesian3());
    camera.frustum = new Cesium.PerspectiveFrustum({
      fov: Math.PI / 3,
      aspectRatio: 1920 / 1080,
      near: 1,
      far: 100000,
    });
    app.layer.enable(app.viewer);
    const loaded = app.layer._loadTransitFleetForTest(
      count,
      BOSTON,
      count === 800 ? 5 : 120,
    );
    assert.equal(loaded.moving, count);
    assert.equal(app.state()._visible.size, count);
    const entry = app.vehicles()[0],
      before = Cesium.Cartesian3.clone(entry.marker.position);
    app.run(1000, 16);
    assert.ok(Cesium.Cartesian3.distance(before, entry.marker.position) > 0.9);
    assert.equal(app.viewer.scene.requestRenderMode, false);
  });
}

test('click handler selects a migrated scripted billboard and prepares a valid depth-fail trail', async (t) => {
  const app = harness(t, { floorAt: () => undefined });
  app.layer.enable(app.viewer);
  app.layer._loadTransitFleetForTest(4, BOSTON, 70);
  const entry = app.vehicles()[0];
  assert.equal(entry.markerCollection, app.state()._animatedMarkers);
  app.viewer.scene.pick = () => ({ primitive: entry.marker, id: entry.key });
  app
    .state()
    ._clickHandler.getInputAction(Cesium.ScreenSpaceEventType.LEFT_CLICK)({
    position: new Cesium.Cartesian2(500, 400),
  });
  assert.equal(app.state()._selectedKey, entry.key);
  const body = app.layer._transitPartsForTest().trails.diagnostics().body;
  assert.ok(body.geometryInstances.length > 0);
  body._batchTableAttributeIndices = { color: 0, depthFailColor: 1 };
  assert.doesNotThrow(() =>
    Cesium.Primitive._updateColorAttribute(
      body,
      body.depthFailAppearance.vertexShaderSource,
      true,
    ),
  );
  assert.ok(entry.trailSegments.length > 0);
  app.run(1000, 16);
  assert.equal(entry.marker.show, true);
});

test('intercepted scripted reports resolve their explicit floor and wake without a preRender bootstrap', async (t) => {
  const app = harness(t, { floorAt: () => undefined });
  app.layer._setTransitFixtureFloorsForTest(['mbta:sim-straight'], 20);
  let latitude = BOSTON.lat;
  app.serve('mbta', () => ({
    status: 200,
    body: snapshot(
      'mbta',
      'MBTA',
      [vehicle('sim-straight', latitude, BOSTON.lon, reported())],
      { fetchedAt: Date.now() },
    ),
  }));
  app.layer.enable(app.viewer);
  await app.layer.update();
  app.advance(15000);
  latitude += 0.001;
  await app.layer.update();
  app.advance(8000);
  const entry = app.vehicles()[0];
  assert.equal(entry.heightPending, false);
  assert.equal(entry.surfaceReady, true);
  assert.equal(entry.marker.show, true);
  assert.ok(app.state()._moving.has(entry));
  assert.equal(app.viewer.scene.requestRenderMode, false);
  const before = Cesium.Cartesian3.clone(entry.marker.position);
  app.run(1000, 16);
  assert.ok(Cesium.Cartesian3.distance(before, entry.marker.position) > 1);
  app.layer.disable(app.viewer);
  assert.equal(app.state()._qaFixtureFloors.size, 0);
});

test('hot path reuses sample outputs and reads camera altitude once per frame', async (t) => {
  const h = harness(t);
  await h.layer.enable(h.viewer);
  h.layer._loadTransitFleetForTest(800, BOSTON, 5);
  const state = h.state();
  const parts = h.layer._transitPartsForTest();
  const entry = state._vehicles.values().next().value;
  const out = new Cesium.Cartesian3();
  assert.equal(parts.trails.samplePosition(entry, entry.sample, out), out);
  const sample = entry.sample;
  const carto = h.viewer.camera.positionCartographic;
  let reads = 0;
  Object.defineProperty(h.viewer.camera, 'positionCartographic', {
    configurable: true,
    get() {
      reads++;
      return carto;
    },
  });
  h.advance(17);
  h.frame();
  assert.equal(entry.sample, sample);
  assert.ok(reads <= 2, `camera altitude reads/frame ${reads}, limit 2`);
  const contacts = h.layer.getDetectableObjects();
  const contact = contacts[0];
  for (let i = 0; i < 100; i++) {
    state._detectRevision++;
    assert.equal(h.layer.getDetectableObjects(), contacts);
    assert.equal(contacts[0], contact);
  }
});

test('scripted straight and changing delay preserve ordinary-frame speed through polls', async (t) => {
  const h = harness(t, { altitude: 600 });
  const start = Date.now();
  const modes = ['straight', 'gap', 'dup'];
  h.serve('mbta', () => {
    const elapsed = (Date.now() - start) / 1000;
    return {
      status: 200,
      body: snapshot(
        'mbta',
        'MBTA',
        modes.map((id) => {
          let sec =
            Math.floor(elapsed / (id === 'dup' ? 30 : 10)) *
            (id === 'dup' ? 30 : 10);
          if (id === 'gap' && sec >= 40 && sec < 130) sec = 40;
          return vehicle(
            id,
            BOSTON.lat + (sec * 8) / 111320,
            BOSTON.lon,
            (start + sec * 1000) / 1000,
          );
        }),
        { fetchedAt: Date.now() },
      ),
    };
  });
  await h.layer.enable(h.viewer);
  let prior = new Map(),
    worst = 0,
    pair = null,
    samples = 0;
  for (let ms = 17; ms <= 200000; ms += 17) {
    h.advance(17);
    if (ms % 15011 === 0) await h.layer.update();
    h.frame();
    for (const e of h.vehicles()) {
      const a = prior.get(e.key),
        s = e.sample,
        p = e.marker.position;
      const b = {
        x: p.x,
        y: p.y,
        z: p.z,
        t: s.displayT,
        from: s.fromSeq,
        to: s.toSeq,
        speed: s.segmentSpeedMps,
        phase: s.phase,
      };
      if (
        a &&
        a.phase === 'playing' &&
        b.phase === 'playing' &&
        a.from === b.from &&
        a.to === b.to &&
        a.speed > 0 &&
        b.t > a.t
      ) {
        const error = Math.abs(
          Math.hypot(b.x - a.x, b.y - a.y, b.z - a.z) /
            ((b.t - a.t) / 1000) /
            a.speed -
            1,
        );
        samples++;
        if (error > worst) {
          worst = error;
          pair = { key: e.key, ms, a, b };
        }
      }
      prior.set(e.key, b);
    }
  }
  assert.ok(samples > 1000);
  assert.ok(worst < 0.02, JSON.stringify({ worst, pair, samples }));
});

test('a lost prepared surface releases moving playback on that frame', async (t) => {
  const h = harness(t);
  await h.layer.enable(h.viewer);
  h.layer._loadTransitFleetForTest(1, BOSTON, 5);
  const parts = h.layer._transitPartsForTest();
  assert.equal(h.state()._moving.size, 1);
  h.state()._heightDirty.clear();
  clearTimeout(h.state()._visibilityTimer);
  h.state()._visibilityTimer = null;
  t.mock.method(parts.trails, 'samplePosition', () => null);
  h.advance(17);
  h.frame();
  assert.equal(h.state()._moving.size, 0);
  assert.equal(h.state()._renderHeld, false);
});

test('sensor brackets clear the padded hot body and retain their contact during style changes', async (t) => {
  const h = harness(t);
  await h.layer.enable(h.viewer);
  h.layer._loadTransitFleetForTest(1, BOSTON, 5);
  const parts = h.layer._transitPartsForTest(),
    entry = h.vehicles()[0];
  const contact = h.layer.getDetectableObjects()[0];
  for (const style of ['thermal', 'surveillance', 'noir', 'normal']) {
    parts.rendering.setStylePreset(style);
    assert.equal(entry.detectContact, contact);
    assert.ok(contact.bracketHalfWidth >= entry.marker.width / 2 + 2, style);
    assert.ok(contact.bracketHalfHeight >= entry.marker.height / 2 + 2, style);
  }
});

test('selected anchor rejects nonfinite marker coordinates before sampling and during surface changes', async (t) => {
  const app = harness(t, { floorAt: () => undefined });
  app.layer.enable(app.viewer);
  app.layer._loadTransitFleetForTest(4, BOSTON, 70);
  const entry = app.vehicles()[0];
  app.layer._transitPartsForTest().selection.selectVehicle(entry.key);
  const card = app.overlaySources.get('transit-selected')[0];
  assert.ok(card.position());
  const position = Cesium.Cartesian3.clone(entry.marker.position);
  entry.marker.position = new Cesium.Cartesian3(NaN, 0, 0);
  assert.equal(card.position(), null);
  entry.marker.position = position;
  assert.equal(card.position(), entry.marker.position);
  entry.marker.show = false;
  assert.equal(card.position(), null);
});

test('preset clicks preserve both pick id paths through moving and stationary collection migration', async (t) => {
  const app = harness(t, { floorAt: () => undefined });
  app.layer.enable(app.viewer);
  app.layer._loadTransitFleetForTest(4, BOSTON, 70);
  const entry = app.vehicles()[0],
    parts = app.layer._transitPartsForTest();
  for (const style of ['normal', 'thermal', 'surveillance', 'noir', 'retro'])
    for (const animated of [true, false]) {
      parts.rendering.setStylePreset(style);
      entry.sample.phase = animated ? 'playing' : 'held';
      entry.sample.segmentSpeedMps = animated ? 1 : 0;
      entry.sample.nextWakeMonoMs = Infinity;
      entry.sample.segmentCourseDeg = entry.courseDeg;
      parts.rendering.schedulePlayback(entry);
      assert.equal(
        entry.markerCollection,
        animated ? app.state()._animatedMarkers : app.state()._markers,
      );
      assert.equal(entry.marker.id, entry.key);
      for (const pick of [{ id: entry.key }, { primitive: entry.marker }]) {
        app.viewer.scene.pick = () => pick;
        app
          .state()
          ._clickHandler.getInputAction(Cesium.ScreenSpaceEventType.LEFT_CLICK)(
          { position: new Cesium.Cartesian2(500, 400) },
        );
        assert.equal(app.state()._selectedKey, entry.key);
        parts.selection.clearSelection();
      }
    }
});

test('QA backwards seek reconstructs the pruned fixture paths before allocation measurement', async (t) => {
  const app = harness(t, { floorAt: () => undefined });
  app.layer.enable(app.viewer);
  app.layer._loadTransitFleetForTest(4, BOSTON, 70);
  app.run(10000, 16);
  const entry = app.vehicles()[0];
  entry.displayPaths.clear();
  app.layer._resetTransitFixtureClockForTest();
  assert.ok(
    entry.displayPaths.size <= 6,
    'rewind retains only the active and future fixture corridor',
  );
  assert.equal(entry.marker.show, true);
  assert.equal(app.state()._moving.size, 4);
  const before = Cesium.Cartesian3.clone(entry.marker.position);
  app.run(1000, 16);
  assert.ok(Cesium.Cartesian3.distance(before, entry.marker.position) > 0.9);
});

test('sensor clicks map displayed pixels into the pre-shader pick buffer', async (t) => {
  const app = harness(t, { floorAt: () => undefined });
  app.layer.enable(app.viewer);
  app.layer._loadTransitFleetForTest(4, BOSTON, 70);
  const entry = app.vehicles()[0],
    scene = app.viewer.scene;
  let actual;
  scene.pick = (p) => {
    actual = { x: p.x, y: p.y };
    return { id: entry.key };
  };
  scene.canvas = {
    width: 1920,
    height: 1080,
    clientWidth: 1920,
    clientHeight: 1080,
  };
  const uniforms = { intensity: 1, pixelation: 1 };
  scene.postProcessStages = {
    getStageByName: () => ({ enabled: true, uniforms }),
  };
  const click = app
    .state()
    ._clickHandler.getInputAction(Cesium.ScreenSpaceEventType.LEFT_CLICK);
  app.layer._transitPartsForTest().rendering.setStylePreset('surveillance');
  click({ position: new Cesium.Cartesian2(1440, 540) });
  assert.ok(Math.abs(actual.x - 1472) < 1e-6);
  assert.equal(actual.y, 540);
  app.layer._transitPartsForTest().rendering.setStylePreset('thermal');
  uniforms.pixelation = 1.5;
  click({ position: new Cesium.Cartesian2(100.9, 200.1) });
  assert.ok(Math.abs(actual.x - 100.5) < 1e-6);
  assert.ok(Math.abs(actual.y - 201) < 1e-6);
  assert.equal(app.state()._selectedKey, entry.key);
});

test('rejected route metadata stays on the accepted bus', async (t) => {
  const app = harness(t);
  let routeId = '741',
    latitude = 42.36;
  app.serve('mbta', () => ({
    status: 200,
    body: snapshot(
      'mbta',
      'MBTA',
      [vehicle('b', latitude, -71.06, reported(), { routeId })],
      { fetchedAt: Date.now() },
    ),
  }));
  app.layer.enable(app.viewer);
  await app.layer.update();
  app.settle();
  const entry = app.vehicles()[0];
  const image = entry.marker.image;
  app.advance(TRANSIT_POLL_MS);
  routeId = 'Red';
  latitude = 43.36;
  await app.layer.update();
  assert.equal(entry.mode, 'bus');
  assert.equal(entry.record.routeId, '741');
  assert.equal(entry.marker.image, image);
  assert.equal(entry.currentEpoch, 1);
  assert.equal(entry.track.count, 1);
  assert.doesNotMatch(
    app.layer
      .getDetectableObjects()
      .map((c) => c.metric)
      .join(' '),
    /METRO/,
  );
});

test('reject then selected history backfill cannot resurrect a 111 km displacement', async (t) => {
  const app = harness(t);
  let latitude = 42.36;
  app.serve('mbta', () => ({
    status: 200,
    body: snapshot(
      'mbta',
      'MBTA',
      [vehicle('b', latitude, -71.06, reported())],
      { fetchedAt: Date.now() },
    ),
  }));
  app.layer.enable(app.viewer);
  await app.layer.update();
  app.settle();
  const entry = app.vehicles()[0];
  app.advance(15000);
  latitude += 0.001;
  await app.layer.update();
  app.settle();
  const accepted = entry.fixes.map((f) => [f.t, f.lat, f.lon, 1, 1]);
  app.advance(15000);
  latitude = 43.36;
  await app.layer.update();
  assert.equal(entry.track.count, 2);
  const pending = entry.track.pending;
  const clock = entry.playT;
  const priorFetch = globalThis.fetch;
  globalThis.fetch = (url, options) =>
    String(url).includes('/trail/')
      ? Promise.resolve(
          new Response(
            JSON.stringify({
              version: 1,
              feedId: 'mbta',
              vehicleId: 'b',
              oldestT: accepted[0][0],
              newestT: pending.t,
              truncated: false,
              epochs: [{ id: 1, trip: '', route: '1', mode: 'bus' }],
              fixes: [...accepted, [pending.t, latitude, -71.06, 1, 1]],
            }),
          ),
        )
      : priorFetch(url, options);
  const parts = app.layer._transitPartsForTest();
  parts.selection.selectVehicle(entry.key);
  for (let i = 0; i < 30; i++) await Promise.resolve();
  assert.equal(entry.track.count, 2);
  assert.equal(entry.playT, clock);
  assert.equal(entry.track.pending, pending);
  app.run(60000);
  assert.ok(Math.abs(lat(entry) - 42.361) * 111320 < 1);
  assert.equal(entry.track.resets, 0);
});

test('actual Traffic, Bikeshare and Transit lifecycles retain sensitivity in every enable/disable order', async (t) => {
  const { createLifecycle: trafficLifecycle } =
    await import('../traffic/lifecycle.js');
  const { createLifecycle: bikeLifecycle } =
    await import('../bikeshare/lifecycle.js');
  const app = harness(t);
  const noop = () => {};
  const traffic = trafficLifecycle({
    state: { _pointCollection: {}, _loadGeneration: 0 },
    services: {
      render: { holdContinuousRender: noop, releaseContinuousRender: noop },
    },
    source: {},
    parts: {
      flow: { ensureFlowStatus: noop },
      animation: { animate: noop, clearDots: noop },
      viewport: { onCameraChanged: noop },
      ingestion: { cancelActiveFetch: noop },
    },
  }).methods;
  const bike = bikeLifecycle({
    state: {
      _pointCollection: {},
      _overlayHost: { setVisible: noop },
      _cityRuntime: new Map(),
    },
    services: {
      sprites: { restoreSpriteOrder: noop },
      picking: { registerPickOwner: noop, unregisterPickOwner: noop },
    },
    source: {},
    parts: {
      selection: {
        _installClickHandler: noop,
        _clearSelection: noop,
        _onKeyDown: noop,
      },
      viewport: {
        onCameraChanged: noop,
        runProximityCheck: noop,
        deactivateAllCities: noop,
      },
      ingestion: { abortAllInFlight: noop },
    },
  }).methods;
  app.viewer.camera.moveEnd = new Cesium.Event();
  const layers = { traffic, bikeshare: bike, transit: app.layer };
  const orders = [
    ['traffic', 'bikeshare', 'transit'],
    ['traffic', 'transit', 'bikeshare'],
    ['bikeshare', 'traffic', 'transit'],
    ['bikeshare', 'transit', 'traffic'],
    ['transit', 'traffic', 'bikeshare'],
    ['transit', 'bikeshare', 'traffic'],
  ];
  try {
    for (const enable of orders)
      for (const disable of orders) {
        const active = new Set();
        for (const id of enable) {
          layers[id].enable(app.viewer);
          active.add(id);
          assert.equal(app.viewer.camera.percentageChanged, 0.05);
          assert.deepEqual(
            new Set(cameraSensitivityClaims(app.viewer.camera)),
            active,
          );
        }
        for (const id of disable) {
          layers[id].disable(app.viewer);
          active.delete(id);
          assert.equal(
            app.viewer.camera.percentageChanged,
            active.size ? 0.05 : 0.5,
            `${enable} / ${disable} after ${id}`,
          );
          assert.deepEqual(
            new Set(cameraSensitivityClaims(app.viewer.camera)),
            active,
          );
        }
      }
  } finally {
    for (const layer of Object.values(layers)) layer.disable(app.viewer);
  }
});

test('moving and stationary transit stay adjacent above CCTV and Bikeshare during migration', async (t) => {
  const {
    registerSpriteCollection,
    unregisterSpriteCollection,
    restoreSpriteOrder,
  } = await import('../../data/spriteOrder.js');
  const app = harness(t);
  app.layer.enable(app.viewer);
  app.layer._loadTransitFleetForTest(1, BOSTON, 70);
  const cctv = {},
    bike = {},
    flights = {};
  app.primitives.push(cctv, bike, flights);
  app.viewer.scene.primitives.raiseToTop = (c) => {
    app.primitives.splice(app.primitives.indexOf(c), 1);
    app.primitives.push(c);
  };
  const collections = new Map([
    ...app.sprites,
    ['cctv', cctv],
    ['bikeshare', bike],
    ['flights', flights],
  ]);
  for (const [id, collection] of collections)
    registerSpriteCollection(id, collection);
  t.after(() => {
    for (const [id, c] of collections) unregisterSpriteCollection(id, c);
  });
  const entry = app.vehicles()[0],
    parts = app.layer._transitPartsForTest();
  for (const moving of [true, false, true]) {
    entry.sample.phase = moving ? 'playing' : 'held';
    entry.sample.segmentSpeedMps = moving ? 1 : 0;
    entry.sample.segmentCourseDeg = NaN;
    parts.rendering.schedulePlayback(entry);
    restoreSpriteOrder(app.viewer);
    const active = app.primitives.indexOf(entry.markerCollection);
    assert.ok(active > app.primitives.indexOf(cctv));
    assert.ok(active > app.primitives.indexOf(bike));
    assert.ok(active < app.primitives.indexOf(flights));
    assert.equal(
      Math.abs(
        app.primitives.indexOf(app.state()._markers) -
          app.primitives.indexOf(app.state()._animatedMarkers),
      ),
      1,
    );
    assert.equal(entry.marker.id, entry.key);
  }
});

test('transit polls the supplied source and cancels it when disabled', async (t) => {
  const calls = [];
  const source = {
    async requestSnapshot(feedId, { signal }) {
      calls.push({ feedId, signal });
      return Response.json(
        snapshot(
          feedId,
          'MBTA',
          [vehicle('injected', 42.36, -71.06, reported())],
          { fetchedAt: Date.now() },
        ),
      );
    },
    async getHistory() {
      throw new Error('No selected vehicle');
    },
  };
  const app = harness(t, { source });
  globalThis.fetch = () => {
    throw new Error('Unexpected global fetch');
  };
  app.layer.enable(app.viewer);
  await app.layer.update();
  assert.ok(calls.some(({ feedId }) => feedId === 'mbta'));
  assert.ok(app.vehicles().some((entry) => entry.record.id === 'injected'));
  const before = calls.length;
  app.layer.disable(app.viewer);
  await app.layer.update();
  assert.equal(calls.length, before);
});
