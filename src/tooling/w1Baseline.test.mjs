import assert from 'node:assert/strict';
import test from 'node:test';
import vm from 'node:vm';
import {
  compareBaselines,
  feedRequestKey,
  frozenClockScript,
  isFeedRequest,
  replayEntry,
} from './w1Baseline.js';

test('feed requests are the app API calls, keyed by method, path and query', () => {
  assert.equal(isFeedRequest('http://localhost:4400/api/opensky/states'), true);
  assert.equal(
    isFeedRequest('http://localhost:4400/src/layers/flights/motion.js'),
    false,
  );
  assert.equal(
    isFeedRequest('https://tile.openstreetmap.org/1/0/0.png'),
    false,
  );
  assert.equal(
    feedRequestKey('get', 'http://localhost:4400/api/a?b=1&_=99'),
    'GET /api/a?b=1',
  );
  assert.equal(
    feedRequestKey('POST', 'http://localhost:4400/api/a'),
    'POST /api/a',
  );
});

test('replay serves the exact request, else the latest of its path, else nothing', () => {
  const recording = {
    entries: [
      { key: 'GET /api/a?x=1', path: '/api/a', status: 200, body: 'one' },
      { key: 'GET /api/a?x=2', path: '/api/a', status: 200, body: 'two' },
      { key: 'GET /api/b', path: '/api/b', status: 200, body: 'bee' },
    ],
  };
  assert.equal(replayEntry(recording, 'GET', 'http://h/api/a?x=1').body, 'one');
  assert.equal(replayEntry(recording, 'GET', 'http://h/api/a?x=9').body, 'two');
  assert.equal(replayEntry(recording, 'GET', 'http://h/api/c'), null);
});

test('the frozen clock freezes Date.now and new Date(), and keeps dates with arguments', () => {
  const sandbox = { Date, globalThis: null };
  sandbox.globalThis = sandbox;
  vm.runInNewContext(frozenClockScript(1_800_000_000_123), sandbox);
  const FrozenDate = sandbox.Date;
  assert.equal(FrozenDate.now(), 1_800_000_000_123);
  assert.equal(new FrozenDate().getTime(), 1_800_000_000_123);
  assert.equal(new FrozenDate(5).getTime(), 5);
  assert.equal(FrozenDate.UTC(2020, 0, 1), Date.UTC(2020, 0, 1));
  assert.ok(new FrozenDate() instanceof Date);
});

const run = (overrides = {}) => ({
  layers: {
    flights: {
      fill: { count: 10 },
      poses: {
        city: {
          rows: 10,
          onScreen: 3,
          known: [
            {
              id: 'a',
              lat: 40.1,
              lon: -73.1,
              altitudeM: 1000,
              screen: { x: 100, y: 200 },
            },
          ],
        },
      },
      tracking: {
        ok: true,
        poseAfter2s: { x: 1, y: 2, z: 6_400_000, heading: 10, pitch: -30 },
      },
      ...overrides,
    },
  },
});

test('equal runs compare equal; moved objects and poses are reported', () => {
  assert.deepEqual(compareBaselines(run(), run()).differences, []);
  const moved = run();
  moved.layers.flights.poses.city.known[0].lat += 0.001;
  moved.layers.flights.poses.city.known[0].screen.x += 3;
  moved.layers.flights.poses.city.onScreen = 4;
  moved.layers.flights.tracking.poseAfter2s.z += 100;
  const { differences, ok } = compareBaselines(run(), moved);
  assert.equal(ok, false);
  const what = differences.map(({ what }) => what).sort();
  assert.deepEqual(what, [
    'known position',
    'known screen point',
    'on-screen count',
    'tracking pose',
  ]);
  // Inside the tolerances: equal.
  const near = run();
  near.layers.flights.poses.city.known[0].screen.x += 0.4;
  near.layers.flights.tracking.poseAfter2s.z += 1;
  assert.equal(compareBaselines(run(), near).ok, true);
});

test('the feed requests a run made are compared too', () => {
  const asked = run({ requests: ['GET /api/flights → exact'] });
  const other = run({
    requests: ['GET /api/flights?lat=1 → as GET /api/flights'],
  });
  const { differences } = compareBaselines(asked, other);
  assert.deepEqual(
    differences.map(({ what }) => what),
    ['requests'],
  );
  assert.equal(
    compareBaselines(asked, run({ requests: ['GET /api/flights → exact'] })).ok,
    true,
  );
});
