// The Rail layer's schedule tier, the stops provider of live trains: null
// before the pack loads, trip-id matching with a nearest-run fallback, delay
// polling only while a train is selected on a feed with a timetable. It
// places no train itself. Built from a small synthetic schedule pack and path
// pack.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  MATCH_NEAREST_MAX_M,
  RAIL_UPDATES_MAX_AGE_MS,
  RAIL_UPDATES_POLL_MS,
  SCHEDULE_RETRY_FIRST_MS,
  SCHEDULE_RETRY_MS,
  createRailSchedules,
  delaysFromUpdates,
  pathsMatch,
  scheduledRunPoint,
  scheduleRetryDelayMs,
} from './schedules.js';
import * as schedules from './schedules.js';
import { createSchedule } from '../../data/railSchedule.js';
import { createRailPathPack } from '../../data/railPaths.js';

const FEED = 'test-rail';
const LAT = 50;
const STEP_M = 0.1 * 111_320 * Math.cos((LAT * Math.PI) / 180);
const at = (hhmm) => Date.parse(`2026-11-06T${hhmm}:00Z`);

/** Three stops due east 0.1° apart; T1 runs 10:00 → 10:20, dwelling at B. */
const rawSchedule = Object.freeze({
  version: 1,
  feedId: FEED,
  timezone: 'UTC',
  window: { from: '2026-11-05', to: '2026-11-08' },
  routes: { R1: { type: 2 }, BUS: { type: 3 } },
  stops: [
    { id: 'A', name: 'Alpha', lat: LAT, lon: 0 },
    { id: 'B', name: 'Bravo', lat: LAT, lon: 0.1 },
    { id: 'C', name: 'Charlie', lat: LAT, lon: 0.2 },
  ],
  patterns: [
    {
      shape: 0,
      stops: [0, 1, 2],
      seq: [1, 2, 3],
      dist: [0, STEP_M, 2 * STEP_M],
    },
    {
      shape: 1,
      stops: [2, 1, 0],
      seq: [1, 2, 3],
      dist: [0, STEP_M, 2 * STEP_M],
    },
  ],
  profiles: [[0, 0, 600, 660, 1260, 1260]],
  services: { WK: ['2026-11-06'] },
  trips: {
    T1: {
      pattern: 0,
      profile: 0,
      startSec: 10 * 3600,
      route: 'R1',
      service: 'WK',
      headsign: 'Charlie',
      name: 'Train 1',
    },
    T2: {
      pattern: 1,
      profile: 0,
      startSec: 10 * 3600,
      route: 'R1',
      service: 'WK',
      headsign: 'Alpha',
      name: 'Train 2',
    },
    B9: {
      pattern: 0,
      profile: 0,
      startSec: 10 * 3600,
      route: 'BUS',
      service: 'WK',
    },
  },
});

const rawPaths = Object.freeze({
  version: 1,
  feedId: FEED,
  shapes: [
    [LAT, 0, LAT, 0.1, LAT, 0.2],
    [LAT, 0.2, LAT, 0.1, LAT, 0],
  ],
  dist: [
    [0, STEP_M, 2 * STEP_M],
    [0, STEP_M, 2 * STEP_M],
  ],
  trips: { T1: 0, T2: 1 },
  routes: { R1: [0, 1] },
});

const reply = (body, status = 200) => ({
  ok: status >= 200 && status < 300,
  status,
  async json() {
    return body;
  },
});

const flush = async () => {
  for (let i = 0; i < 4; i++) await new Promise((r) => setImmediate(r));
};

/** A provider over a fake source, fake clock and fake interval timers. */
function harness({
  schedule = () => reply(rawSchedule),
  updates = () => reply({ trips: [] }),
  tripUpdates = true,
  clock = at('10:05'),
} = {}) {
  const calls = { schedule: 0, updates: 0 };
  const timers = new Map();
  let nextTimer = 1;
  const h = {
    calls,
    timers,
    now: clock,
    provider: null,
  };
  h.provider = createRailSchedules({
    source: {
      async requestSchedule(feedId) {
        calls.schedule += 1;
        assert.equal(feedId, FEED);
        return schedule();
      },
      async requestUpdates(feedId) {
        calls.updates += 1;
        assert.equal(feedId, FEED);
        return updates();
      },
    },
    hasTripUpdates: () => tripUpdates,
    pathPackFor: () => createRailPathPack(rawPaths),
    now: () => h.now,
    setInterval: (fn, ms) => {
      const id = nextTimer++;
      timers.set(id, { fn, ms });
      return id;
    },
    clearInterval: (id) => timers.delete(id),
  });
  return h;
}

const liveTrain = (record) => ({
  feedId: FEED,
  tripId: record.tripId ?? null,
  routeId: record.routeId ?? null,
  record,
});

// ---------------------------------------------------------------------------
// Where a run is, compared with a live train's report to find its run

test('the tier places no trains: it has no train records to offer', () => {
  assert.equal(schedules.scheduledTrainRecords, undefined);
  const provider = createRailSchedules({
    source: {},
    hasTripUpdates: () => false,
  });
  assert.deepEqual(Object.keys(provider).sort(), [
    'delaysFor',
    'forget',
    'loadSchedule',
    'onSelect',
    'scheduleFor',
    'stats',
    'stop',
    'stopsFor',
    'unwatchUpdates',
    'watchUpdates',
  ]);
});

test('without the path pack a run’s point lies between its stops', () => {
  const schedule = createSchedule(rawSchedule);
  const point = scheduledRunPoint(schedule, 'T1', at('10:05'), null, null);
  assert.equal(point.onShape, false);
  assert.ok(Math.abs(point.lon - 0.05) < 1e-9);
  assert.ok(Number.isNaN(point.bearingDeg));
  const onShape = scheduledRunPoint(
    schedule,
    'T1',
    at('10:05'),
    null,
    createRailPathPack(rawPaths),
  );
  assert.equal(onShape.onShape, true);
  assert.ok(Math.abs(onShape.bearingDeg - 90) < 1e-6);
});

test('a schedule from another build than its path pack stays between stops', () => {
  const built = '2026-11-10T08:00:00.000Z';
  const schedule = createSchedule({ ...rawSchedule, pathsBuiltAt: built });
  const same = createRailPathPack({ ...rawPaths, builtAt: built });
  const rebuilt = createRailPathPack({
    ...rawPaths,
    builtAt: '2026-11-10T09:00:00.000Z',
  });
  assert.equal(schedule.pathsBuiltAt, built);
  assert.equal(same.builtAt, built);
  assert.equal(pathsMatch(schedule, same), true);
  assert.equal(pathsMatch(schedule, rebuilt), false);
  assert.equal(pathsMatch(schedule, null), false);
  // Packs from before the stamps are taken as a pair.
  assert.equal(pathsMatch(createSchedule(rawSchedule), rebuilt), true);
  const onShape = scheduledRunPoint(schedule, 'T1', at('10:05'), null, same);
  assert.equal(onShape.onShape, true);
  const between = scheduledRunPoint(schedule, 'T1', at('10:05'), null, rebuilt);
  assert.equal(between.onShape, false);
  assert.ok(Math.abs(between.lon - 0.05) < 1e-9);
});

test('trip updates become the delays map the timetable reads', () => {
  const delays = delaysFromUpdates({
    trips: [
      {
        tripId: 'T1',
        routeId: 'R1',
        startDate: '20261106',
        relationship: 'SCHEDULED',
        delaySec: null,
        stops: [{ stopId: 'B', arrival: { time: null, delay: 240 } }],
      },
      { tripId: '', delaySec: 60 },
      null,
    ],
  });
  assert.deepEqual(Object.keys(delays), ['T1']);
  assert.equal(delays.T1.delaySec, null);
  assert.equal(delays.T1.stops[0].arrival.delay, 240);
  assert.deepEqual(delaysFromUpdates(null), {});
});

// ---------------------------------------------------------------------------
// Stops provider

test('the provider answers null until the timetable has loaded', async () => {
  const h = harness();
  const train = liveTrain({
    id: 'v1',
    tripId: 'T1',
    routeId: 'R1',
    lat: LAT,
    lon: 0.05,
  });
  assert.equal(h.provider.stopsFor(train, h.now), null);
  assert.equal(h.calls.schedule, 1);
  // Asking again while it loads does not fetch twice.
  assert.equal(h.provider.stopsFor(train, h.now), null);
  assert.equal(h.calls.schedule, 1);
  await flush();
  const trip = h.provider.stopsFor(train, h.now);
  assert.equal(trip.match, 'trip');
  assert.equal(trip.headsign, 'Charlie');
  assert.deepEqual(
    trip.stops.map((stop) => [stop.name, stop.state, stop.expectedArrival]),
    [
      ['Alpha', 'passed', '10:00'],
      ['Bravo', 'next', '10:10'],
      ['Charlie', 'upcoming', '10:21'],
    ],
  );
  assert.equal(trip.stops[1].relative, 'T−5');
  assert.equal(h.calls.schedule, 1);
  assert.equal(h.provider.stopsFor(null, h.now), null);
});

test('a live trip id the timetable lacks falls back to the nearest run', async () => {
  const h = harness();
  await h.provider.loadSchedule(FEED);
  const near = h.provider.stopsFor(
    liveTrain({
      id: 'v7',
      tripId: 'live-123',
      routeId: 'R1',
      lat: LAT,
      lon: 0.149,
    }),
    h.now,
  );
  // At 10:05 T2 is at 0.15 (westbound) and T1 at 0.05: T2 is nearest.
  assert.equal(near.match, 'nearest');
  assert.equal(near.headsign, 'Alpha');
  // A train with no route searches every run.
  const noRoute = h.provider.stopsFor(
    liveTrain({ id: 'v8', tripId: null, lat: LAT, lon: 0.051 }),
    h.now,
  );
  assert.equal(noRoute.headsign, 'Charlie');
  // Too far from any run: no stops rather than a wrong train's.
  const farLon = 0.05 + (2 * MATCH_NEAREST_MAX_M) / (STEP_M * 10);
  assert.equal(
    h.provider.stopsFor(
      liveTrain({
        id: 'v9',
        tripId: 'x',
        routeId: 'R1',
        lat: LAT + 0.1,
        lon: farLon,
      }),
      h.now,
    ),
    null,
  );
  // Another route's train does not take a run of R1.
  assert.equal(
    h.provider.stopsFor(
      liveTrain({ id: 'v10', tripId: 'x', routeId: 'R9', lat: LAT, lon: 0.05 }),
      h.now,
    ),
    null,
  );
});

test('delays are polled every 30 s only while a train on the feed is selected', async () => {
  const h = harness({
    updates: () =>
      reply({
        trips: [
          {
            tripId: 'T1',
            delaySec: 240,
            stops: [{ stopId: 'B', arrival: { delay: 240 }, departure: null }],
          },
        ],
      }),
  });
  const train = liveTrain({
    id: 'v1',
    tripId: 'T1',
    routeId: 'R1',
    lat: LAT,
    lon: 0.05,
  });
  assert.equal(h.calls.updates, 0);
  h.provider.onSelect(train);
  await flush();
  assert.equal(h.calls.updates, 1);
  assert.equal(h.timers.size, 1);
  assert.equal([...h.timers.values()][0].ms, RAIL_UPDATES_POLL_MS);
  assert.equal(RAIL_UPDATES_POLL_MS, 30_000);
  const trip = h.provider.stopsFor(train, h.now);
  const bravo = trip.stops[1];
  assert.equal(bravo.arrivalDelaySec, 240);
  assert.equal(bravo.expectedArrival, '10:14');

  // The interval re-reads; reselecting on the same feed adds no second poll.
  [...h.timers.values()][0].fn();
  await flush();
  assert.equal(h.calls.updates, 2);
  h.provider.onSelect({ ...train, record: { ...train.record, id: 'v2' } });
  assert.equal(h.timers.size, 1);

  // Delays too old to trust are not applied.
  h.now += RAIL_UPDATES_MAX_AGE_MS + 1;
  assert.equal(h.provider.delaysFor(FEED), null);
  assert.equal(h.provider.stopsFor(train, h.now).stops[1].arrivalDelaySec, 0);

  // Clearing the selection stops the poll.
  h.provider.onSelect(null);
  assert.equal(h.timers.size, 0);
});

test('delays are as old as the server’s read, even when it replays them', async () => {
  let readAt = null;
  const h = harness({
    updates: () =>
      reply({
        fetchedAt: readAt ?? h.now,
        trips: [
          {
            tripId: 'T1',
            delaySec: 240,
            stops: [{ stopId: 'B', arrival: { delay: 240 }, departure: null }],
          },
        ],
      }),
  });
  const train = liveTrain({
    id: 'v1',
    tripId: 'T1',
    routeId: 'R1',
    lat: LAT,
    lon: 0.05,
  });
  h.provider.onSelect(train);
  await flush();
  assert.equal(h.provider.stopsFor(train, h.now).stops[1].arrivalDelaySec, 240);

  // The operator fails: each poll is answered with the server's last copy,
  // still stamped with the time it was read.
  readAt = h.now;
  const poll = [...h.timers.values()][0].fn;
  for (let i = 0; i < 3; i++) {
    h.now += RAIL_UPDATES_POLL_MS;
    poll();
    await flush();
  }
  assert.equal(h.calls.updates, 4);
  assert.ok(3 * RAIL_UPDATES_POLL_MS > RAIL_UPDATES_MAX_AGE_MS);
  assert.equal(h.provider.delaysFor(FEED), null);
  assert.equal(h.provider.stopsFor(train, h.now).stops[1].arrivalDelaySec, 0);

  // A fresh read applies again; a server clock ahead counts as now.
  readAt = h.now + 5_000;
  poll();
  await flush();
  assert.equal(h.provider.stopsFor(train, h.now).stops[1].arrivalDelaySec, 240);
  h.now += RAIL_UPDATES_MAX_AGE_MS;
  assert.notEqual(h.provider.delaysFor(FEED), null);
});

test('a selected train’s delays are not polled when its feed has no timetable', async () => {
  const h = harness({
    schedule: () => reply({ error: 'No rail schedule' }, 404),
  });
  h.provider.onSelect(liveTrain({ id: 'v1', tripId: 'T1' }));
  await flush();
  assert.equal(h.calls.schedule, 1);
  assert.equal(h.calls.updates, 0);
  assert.equal(h.timers.size, 0);
  assert.equal(h.provider.stats().updates[FEED], undefined);

  // With the pack, the same selection polls; cleared before the pack
  // arrives, it starts no poll.
  const ready = harness();
  ready.provider.onSelect(liveTrain({ id: 'v1', tripId: 'T1' }));
  ready.provider.onSelect(null);
  await flush();
  assert.equal(ready.calls.updates, 0);
  assert.equal(ready.timers.size, 0);
  ready.provider.onSelect(liveTrain({ id: 'v1', tripId: 'T1' }));
  await flush();
  assert.equal(ready.calls.updates, 1);
  assert.equal(ready.timers.size, 1);
});

test('every reader of a feed’s delays shares one poll', async () => {
  const h = harness();
  h.provider.watchUpdates(FEED, 'probe');
  h.provider.onSelect(liveTrain({ id: 'v1', tripId: 'T1' }));
  await flush();
  assert.deepEqual(h.provider.stats().updates[FEED].reasons, [
    'probe',
    'selection',
  ]);
  assert.equal(h.timers.size, 1);
  h.provider.onSelect(null);
  assert.equal(h.timers.size, 1);
  h.provider.unwatchUpdates(FEED, 'probe');
  assert.equal(h.timers.size, 0);
  h.provider.watchUpdates(FEED, 'probe');
  h.provider.stop();
  assert.equal(h.timers.size, 0);
});

test('a feed without trip updates is never polled for them', async () => {
  const h = harness({ tripUpdates: false });
  h.provider.onSelect(liveTrain({ id: 'v1', tripId: 'T1' }));
  h.provider.watchUpdates(FEED, 'probe');
  await flush();
  assert.equal(h.calls.updates, 0);
  assert.equal(h.timers.size, 0);
  assert.equal(h.provider.delaysFor(FEED), null);
});

test('without trip updates, the delay a train reports moves its stops', async () => {
  // Irish Rail and SJ Nord publish no trip updates, but each report says
  // how late the train is: 9 minutes here.
  const h = harness({ tripUpdates: false, clock: at('10:12') });
  await h.provider.loadSchedule(FEED);
  const late = (record) =>
    h.provider.stopsFor(liveTrain({ routeId: 'R1', ...record }), h.now);
  const byTrip = late({
    id: 'v1',
    tripId: 'T1',
    lat: LAT,
    lon: 0.06,
    delaySec: 540,
  });
  assert.equal(byTrip.match, 'trip');
  // On time it would have left Bravo at 10:11; 9 minutes late it is still
  // to reach it.
  assert.deepEqual(
    byTrip.stops.map((stop) => [stop.name, stop.state, stop.expectedArrival]),
    [
      ['Alpha', 'passed', '10:09'],
      ['Bravo', 'next', '10:19'],
      ['Charlie', 'upcoming', '10:30'],
    ],
  );
  assert.equal(byTrip.stops[1].arrivalDelaySec, 540);
  // Without a usable trip id the run is found where its timetable was 9
  // minutes ago: T1 at 10:03, not T2, which is nearer the report at 10:12.
  const byPlace = late({
    id: 'v2',
    tripId: 'SJN:DatedServiceJourney:1',
    lat: LAT,
    lon: 0.03,
    delaySec: 540,
  });
  assert.equal(byPlace.match, 'nearest');
  assert.equal(byPlace.headsign, 'Charlie');
  assert.equal(byPlace.stops[1].expectedArrival, '10:19');
  // A train 25 minutes late is still on its run after the timetable ends.
  h.now = at('10:40');
  const after = late({
    id: 'v3',
    tripId: 'T1',
    lat: LAT,
    lon: 0.18,
    delaySec: 1500,
  });
  assert.equal(after.stops[2].state, 'next');
  assert.equal(after.stops[2].expectedArrival, '10:46');
});

test('a feed with trip updates takes its delays from them, not the report', async () => {
  const h = harness({ clock: at('10:12') });
  await h.provider.loadSchedule(FEED);
  const trip = h.provider.stopsFor(
    liveTrain({
      id: 'v1',
      tripId: 'T1',
      routeId: 'R1',
      lat: LAT,
      lon: 0.15,
      delaySec: 540,
    }),
    h.now,
  );
  assert.deepEqual(
    trip.stops.map((stop) => stop.state),
    ['passed', 'passed', 'next'],
  );
  assert.equal(trip.stops[2].expectedArrival, '10:21');
});

test('no timetable (404) is final; a failed load is retried later', async () => {
  const missing = harness({
    schedule: () => reply({ error: 'No rail schedule' }, 404),
  });
  const train = liveTrain({ id: 'v1', tripId: 'T1' });
  assert.equal(missing.provider.stopsFor(train, missing.now), null);
  await flush();
  missing.now += SCHEDULE_RETRY_MS * 10;
  assert.equal(missing.provider.stopsFor(train, missing.now), null);
  await flush();
  assert.equal(missing.calls.schedule, 1);
  assert.equal(await missing.provider.loadSchedule(FEED), null);

  let fail = true;
  const flaky = harness({
    schedule: () => (fail ? reply({}, 503) : reply(rawSchedule)),
  });
  const warn = console.warn;
  console.warn = () => {};
  try {
    assert.equal(await flaky.provider.loadSchedule(FEED), null);
    fail = false;
    assert.equal(await flaky.provider.loadSchedule(FEED), null);
    assert.equal(flaky.calls.schedule, 1);
    flaky.now += SCHEDULE_RETRY_MS;
    assert.ok(await flaky.provider.loadSchedule(FEED));
    assert.equal(flaky.calls.schedule, 2);
    // A malformed pack is not fetched again.
    const broken = harness({ schedule: () => reply({ version: 99 }) });
    assert.equal(await broken.provider.loadSchedule(FEED), null);
    broken.now += SCHEDULE_RETRY_MS * 10;
    assert.equal(await broken.provider.loadSchedule(FEED), null);
    assert.equal(broken.calls.schedule, 1);
  } finally {
    console.warn = warn;
  }
});

test('a failing pack is tried again after 30 s, then twice as long each time, up to ten minutes', async () => {
  assert.deepEqual(
    [1, 2, 3, 4, 5, 6, 7].map(scheduleRetryDelayMs),
    [30_000, 60_000, 120_000, 240_000, 480_000, 600_000, 600_000],
  );
  let fail = true;
  const flaky = harness({
    schedule: () => (fail ? reply({}, 502) : reply(rawSchedule)),
  });
  const warn = console.warn;
  console.warn = () => {};
  try {
    // One transient 5xx: back within a minute, not ten.
    assert.equal(await flaky.provider.loadSchedule(FEED), null);
    flaky.now += SCHEDULE_RETRY_FIRST_MS - 1;
    assert.equal(await flaky.provider.loadSchedule(FEED), null);
    assert.equal(flaky.calls.schedule, 1, 'not before 30 s');
    flaky.now += 1;
    assert.equal(await flaky.provider.loadSchedule(FEED), null);
    assert.equal(flaky.calls.schedule, 2);
    // Failing again, it waits twice as long.
    flaky.now += 2 * SCHEDULE_RETRY_FIRST_MS - 1;
    assert.equal(await flaky.provider.loadSchedule(FEED), null);
    assert.equal(flaky.calls.schedule, 2, 'not before 60 s');
    fail = false;
    flaky.now += 1;
    assert.ok(await flaky.provider.loadSchedule(FEED));
    assert.equal(flaky.calls.schedule, 3);
    // Loaded, it is never fetched again.
    flaky.now += SCHEDULE_RETRY_MS * 10;
    assert.ok(await flaky.provider.loadSchedule(FEED));
    assert.equal(flaky.calls.schedule, 3);
  } finally {
    console.warn = warn;
  }
});

test('a forgotten feed gives back its timetable and loads it again when used', async () => {
  const h = harness();
  await h.provider.loadSchedule(FEED);
  assert.equal(h.provider.stats().schedules[FEED].status, 'ready');
  assert.equal(h.calls.schedule, 1);
  h.provider.forget(FEED);
  assert.equal(h.provider.stats().schedules[FEED], undefined);
  await h.provider.loadSchedule(FEED);
  assert.equal(h.calls.schedule, 2);
  // Trip updates still polled for a reason are not dropped.
  h.provider.watchUpdates(FEED, 'probe');
  await flush();
  h.provider.forget(FEED);
  assert.ok(h.provider.stats().updates[FEED].polling);
  h.provider.unwatchUpdates(FEED, 'probe');
  h.provider.forget(FEED);
  assert.equal(h.provider.stats().updates[FEED], undefined);
});
