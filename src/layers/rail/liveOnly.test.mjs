// Only live trains are drawn. A live feed whose positions fail is shown as
// unavailable: no train is placed or moved from its timetable, nothing is
// asked for to place one, and the trains it drew go as their reports age.
// A schedule pack is read only for a selected live train's stops. Feeds
// that read their routes from a schedule pack wait for the server's
// catalog, which is asked for again with a backoff when it fails.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  CATALOG_RETRY_FIRST_MS,
  CATALOG_RETRY_MAX_MS,
  FEED_EVICT_AFTER_MS,
  RAIL_POLL_MS,
  railCatalogRetryDelayMs,
  railTrainKey,
} from './policy.js';
import * as policy from './policy.js';
import {
  getRegisteredRailFeed,
  publicRailCatalog,
  railFeedNeedsSchedulePack,
} from '../../data/railFeeds.js';
import {
  RAIL_HARNESS_T0 as T0,
  railLayerHarness as harness,
  railTrain as train,
} from '../../testSupport/railLayerHarness.mjs';

const FEED = 'septa-regional-rail';
const PHILADELPHIA = { lat: 40.0, lon: -75.25 };
const MADRID = { lat: 40.42, lon: -3.7 };
/** The server's catalog, narrowed to SEPTA so no other feed is polled. */
const CATALOG = publicRailCatalog().filter((feed) => feed.id === FEED);
const LAT = 40.0;
const STEP_M = 0.1 * 111_320 * Math.cos((LAT * Math.PI) / 180);
const DAY = new Date(T0).toISOString().slice(0, 10);
/** Seconds after midnight (UTC) at the tests' start. */
const T0_SEC = (T0 - Date.parse(`${DAY}T00:00:00Z`)) / 1000;

/**
 * A SEPTA schedule pack of one Paoli/Thorndale run, T1, west to east across
 * three stops an hour long, that left its first stop ten minutes before the
 * tests start. It is served, and must never place a train.
 */
const SEPTA_PACK = Object.freeze({
  version: 1,
  feedId: FEED,
  timezone: 'UTC',
  window: { from: DAY, to: DAY },
  routes: { PAO: { type: 2 } },
  stops: [
    { id: 'A', name: 'Paoli', lat: LAT, lon: -75.45 },
    { id: 'B', name: 'Bryn Mawr', lat: LAT, lon: -75.35 },
    { id: 'C', name: '30th Street', lat: LAT, lon: -75.25 },
  ],
  patterns: [
    {
      shape: 0,
      stops: [0, 1, 2],
      seq: [1, 2, 3],
      dist: [0, STEP_M, 2 * STEP_M],
    },
  ],
  profiles: [[0, 0, 1800, 1860, 3600, 3600]],
  services: { WK: [DAY] },
  trips: {
    T1: {
      pattern: 0,
      profile: 0,
      startSec: T0_SEC - 600,
      route: 'PAO',
      service: 'WK',
      headsign: '30th Street',
      name: '9512',
    },
  },
});
const LIVE_V1 = railTrainKey(FEED, 'V1');

/** SEPTA's live answer, switched by the test; its schedule pack is served. */
function septa(app, answer = { status: 502 }) {
  const live = { answer };
  app.schedules.set(FEED, SEPTA_PACK);
  app.feeds.set(FEED, () =>
    typeof live.answer === 'function' ? live.answer() : live.answer,
  );
  return live;
}

const feedStatus = (app) => app.state()._feedStatus.get(FEED);
const feedKeys = (app) =>
  [...app.state()._trains.keys()].filter((key) =>
    key.startsWith(`rail:${FEED}:`),
  );
const asked = (app) => app.requested.filter((id) => id === FEED).length;

/** Live V1 on trip T1, near where the timetable has the train. */
function liveV1() {
  const minutes = (Date.now() - T0) / 60_000;
  return [
    train('V1', LAT, -75.4 + minutes * 0.002, {
      tripId: 'T1',
      routeId: 'PAO',
      category: 'local',
      label: '9512',
    }),
  ];
}

test('the layer has no timetable fallback to switch to', () => {
  for (const gone of [
    'LIVE_FAILURES_TO_TIMETABLE',
    'LIVE_PROBE_MIN_MS',
    'LIVE_PROBE_MAX_MS',
    'railLiveFailureKind',
    'railLiveProbeDelayMs',
  ])
    assert.equal(policy[gone], undefined, gone);
});

test('a live feed whose operator fails shows unavailable, and no timetable is asked for', async (t) => {
  t.mock.method(console, 'warn', () => {});
  const app = harness(t, { at: PHILADELPHIA, catalog: CATALOG });
  septa(app);
  await app.enable();
  for (let i = 0; i < 4; i += 1) {
    const status = feedStatus(app);
    assert.match(status.error, /unavailable/, `poll ${i + 1}`);
    assert.equal(status.loading, false);
    assert.deepEqual(feedKeys(app), [], 'no train placed from the timetable');
    app.run(RAIL_POLL_MS);
    await app.poll();
  }
  assert.deepEqual(app.requestedSchedules, [], 'no schedule pack asked for');
  // Live positions are asked for again every poll, as for any feed.
  assert.equal(asked(app), 5);
  assert.match(app.layer.getStats().error, /unavailable/);
});

test('trains a failing feed drew are never moved on by its timetable; they age out', async (t) => {
  t.mock.method(console, 'warn', () => {});
  const app = harness(t, {
    at: PHILADELPHIA,
    catalog: CATALOG,
    scheduleStops: true,
  });
  const live = septa(app, liveV1);
  await app.enable();
  app.run(RAIL_POLL_MS);
  await app.poll();
  assert.deepEqual(feedKeys(app), [LIVE_V1]);
  // A selected live train reads its stops from the schedule pack.
  app.parts().selection.selectTrain(LIVE_V1);
  await app.settle();
  assert.deepEqual(app.requestedSchedules, [FEED]);
  const lastReport = app.entry(LIVE_V1).record;

  // The operator fails: the train keeps its last report, and only that.
  live.answer = { status: 502 };
  const failedAt = Date.now();
  while (Date.now() - failedAt <= FEED_EVICT_AFTER_MS) {
    app.run(RAIL_POLL_MS);
    await app.poll();
    for (const key of feedKeys(app))
      assert.equal(key, LIVE_V1, 'no timetable run is drawn');
    if (app.entry(LIVE_V1))
      assert.equal(app.entry(LIVE_V1).record, lastReport, 'never moved on');
  }
  assert.deepEqual(feedKeys(app), [], 'gone as its report aged');
  assert.equal(app.state()._selectedKey, null);
  assert.match(feedStatus(app).error, /unavailable/);
  assert.deepEqual(app.requestedSchedules, [FEED], 'asked for once, for stops');
});

test('a server that answers with timetable positions has no live data: nothing drawn', async (t) => {
  t.mock.method(console, 'warn', () => {});
  // SEPTA's trains route answers 200 with no live positions
  // (`positions: 'schedule'`, no trains).
  const app = harness(t, { at: PHILADELPHIA, catalog: CATALOG });
  septa(app, { positions: 'schedule' });
  await app.enable();
  for (let i = 0; i < 3; i += 1) {
    app.run(RAIL_POLL_MS);
    await app.poll();
  }
  assert.deepEqual(feedKeys(app), []);
  assert.match(feedStatus(app).error, /unavailable/);
  assert.deepEqual(app.requestedSchedules, []);
  // It is not taken for a timetable feed: live is asked for every poll.
  assert.equal(asked(app), 4);
});

test('a train record placed from a timetable is never drawn, whatever the feed says', async (t) => {
  const app = harness(t, { at: PHILADELPHIA, catalog: CATALOG });
  septa(app, () => [
    train('V1', LAT, -75.4, { positionSource: 'schedule' }),
    train('V2', LAT, -75.3, { positionSource: 'gps' }),
    train('V3', LAT, -75.35, { positionSource: 'event' }),
    train('V4', LAT, -75.32, { positionSource: undefined }),
  ]);
  await app.enable();
  assert.deepEqual(feedKeys(app).sort(), [
    railTrainKey(FEED, 'V2'),
    railTrainKey(FEED, 'V3'),
    railTrainKey(FEED, 'V4'),
  ]);
  assert.equal(feedStatus(app).error, null);
});

test('a catalog feed without live positions is never polled', async (t) => {
  // A catalog entry whose positions are not live is left alone.
  const app = harness(t, {
    at: PHILADELPHIA,
    catalog: CATALOG.map((feed) => ({ ...feed, positions: 'schedule' })),
  });
  septa(app, liveV1);
  await app.enable();
  app.run(RAIL_POLL_MS);
  await app.poll();
  assert.ok(!app.state()._activeFeeds.has(FEED));
  assert.equal(asked(app), 1, 'only the first poll, before the catalog');
  assert.deepEqual(feedKeys(app), []);
  assert.deepEqual(app.requestedSchedules, []);
});

test('a feed the catalog leaves out is never polled once it loads', async (t) => {
  // Here the catalog lists SEPTA's regional rail alone, so the other
  // bundled feed in range (the trolleys) is dropped as soon as it answers.
  const app = harness(t, { at: PHILADELPHIA, catalog: CATALOG });
  septa(app, liveV1);
  await app.enable();
  assert.deepEqual([...app.state()._activeFeeds.keys()], [FEED]);
  const before = app.requested.filter((id) => id !== FEED).length;
  for (let i = 0; i < 3; i += 1) {
    app.run(RAIL_POLL_MS);
    await app.poll();
  }
  assert.equal(app.requested.filter((id) => id !== FEED).length, before);
  assert.deepEqual(
    [...app.state()._feedStatus.keys()],
    [FEED],
    'no status, so no error, for a feed the catalog left out',
  );
});

/** A catalog the test answers (or fails) when it chooses. */
function pendingCatalog() {
  const pending = {};
  pending.promise = new Promise((resolve, reject) => {
    pending.resolve = resolve;
    pending.reject = reject;
  });
  return pending;
}

const LONG_DISTANCE = 'renfe-larga-distancia';
const CERCANIAS = 'renfe-cercanias';

/** Madrid's two live feeds, both answering with no trains. */
function liveFeedsAnswer(app) {
  app.feeds.set(LONG_DISTANCE, () => []);
  app.feeds.set(CERCANIAS, () => []);
}

const needsPack = (id) => railFeedNeedsSchedulePack(getRegisteredRailFeed(id));

test('Renfe long distance reads its routes from a pack: it is held back until the catalog lists it', () => {
  assert.equal(needsPack(LONG_DISTANCE), true);
  assert.equal(needsPack(CERCANIAS), false);
});

test('a pack-routed live feed waits for the catalog, then runs once its pack is built', async (t) => {
  // A fresh install builds no packs: until the catalog says which are
  // built, no such feed's pack is asked for (it would answer 404).
  const catalog = pendingCatalog();
  const app = harness(t, { at: MADRID, catalog: catalog.promise, paths: {} });
  liveFeedsAnswer(app);
  await app.enable();
  const asks = () => [...app.requestedSchedules, ...app.requestedPaths];
  assert.ok(app.requestedPaths.includes(CERCANIAS), 'Cercanías starts at once');
  assert.deepEqual(asks().filter(needsPack), []);
  assert.ok(!app.state()._activeFeeds.has(LONG_DISTANCE));
  assert.ok(!app.requested.includes(LONG_DISTANCE));

  catalog.resolve(
    publicRailCatalog({ schedulePackBuilt: (id) => id === LONG_DISTANCE }),
  );
  await app.settle();
  assert.ok(app.state()._activeFeeds.has(LONG_DISTANCE));
  assert.ok(app.requested.includes(LONG_DISTANCE), 'its live positions');
  assert.ok(app.requestedPaths.includes(LONG_DISTANCE), 'and its line');
  // Its schedule pack is not needed to place anything.
  assert.deepEqual(app.requestedSchedules, []);
});

test('a pack-routed live feed whose pack is not built is never polled', async (t) => {
  const app = harness(t, {
    at: MADRID,
    catalog: publicRailCatalog({ schedulePackBuilt: () => false }),
    paths: {},
  });
  liveFeedsAnswer(app);
  await app.enable();
  for (let i = 0; i < 2; i += 1) {
    app.run(RAIL_POLL_MS);
    await app.poll();
  }
  assert.deepEqual([...app.state()._activeFeeds.keys()], [CERCANIAS]);
  assert.ok(!app.requested.includes(LONG_DISTANCE));
  assert.deepEqual(
    [...app.requestedSchedules, ...app.requestedPaths].filter(needsPack),
    [],
  );
});

test('a catalog that fails keeps pack-routed feeds held back and is asked for again', async (t) => {
  t.mock.method(console, 'warn', () => {});
  // Two failures, then a catalog with Renfe long distance's pack built.
  const answers = [
    () => Promise.reject(new Error('Rail feeds HTTP 500')),
    () => Promise.reject(new Error('Rail feeds HTTP 502')),
    () =>
      publicRailCatalog({ schedulePackBuilt: (id) => id === LONG_DISTANCE }),
  ];
  const app = harness(t, {
    at: MADRID,
    catalog: () => answers.shift()(),
    paths: {},
  });
  liveFeedsAnswer(app);
  await app.enable();
  const asks = () => [...app.requestedSchedules, ...app.requestedPaths];
  assert.equal(app.catalogRequests.length, 1);
  assert.ok(app.state()._activeFeeds.has(CERCANIAS), 'live feeds still run');
  assert.deepEqual(asks().filter(needsPack), [], 'no pack asked for');
  assert.ok(!app.state()._activeFeeds.has(LONG_DISTANCE));

  // Asked for again after 30 s, then after a further minute.
  t.mock.timers.tick(CATALOG_RETRY_FIRST_MS - 1);
  await app.settle();
  assert.equal(app.catalogRequests.length, 1);
  t.mock.timers.tick(1);
  await app.settle();
  assert.equal(app.catalogRequests.length, 2);
  assert.deepEqual(asks().filter(needsPack), []);
  t.mock.timers.tick(2 * CATALOG_RETRY_FIRST_MS);
  await app.settle();
  assert.equal(app.catalogRequests.length, 3);
  assert.ok(app.state()._activeFeeds.has(LONG_DISTANCE));
  assert.ok(app.requestedPaths.includes(LONG_DISTANCE));

  // A catalog that loaded is not asked for again.
  t.mock.timers.tick(CATALOG_RETRY_MAX_MS);
  await app.settle();
  assert.equal(app.catalogRequests.length, 3);
});

test('the catalog retry backs off to ten minutes and stops with the layer', async (t) => {
  t.mock.method(console, 'warn', () => {});
  assert.equal(railCatalogRetryDelayMs(1), CATALOG_RETRY_FIRST_MS);
  assert.equal(railCatalogRetryDelayMs(2), 2 * CATALOG_RETRY_FIRST_MS);
  assert.equal(railCatalogRetryDelayMs(30), CATALOG_RETRY_MAX_MS);
  const app = harness(t, {
    at: MADRID,
    catalog: () => Promise.reject(new Error('Rail feeds HTTP 500')),
    paths: {},
  });
  liveFeedsAnswer(app);
  await app.enable();
  app.layer.disable(app.viewer);
  t.mock.timers.tick(CATALOG_RETRY_MAX_MS);
  await app.settle();
  assert.equal(app.catalogRequests.length, 1, 'no retry while off');
});

test('a source without a catalog polls only the feeds that need no pack', async (t) => {
  const app = harness(t, { at: MADRID, catalog: false, paths: {} });
  liveFeedsAnswer(app);
  await app.enable();
  const active = [...app.state()._activeFeeds.keys()];
  assert.deepEqual(active, [CERCANIAS]);
  assert.deepEqual(
    [...app.requestedSchedules, ...app.requestedPaths].filter(needsPack),
    [],
  );
});
