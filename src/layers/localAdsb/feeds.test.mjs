import test from 'node:test';
import assert from 'node:assert/strict';

import { LOCAL_RECEIVERS_URL, createLocalReceiverFeeds } from './feeds.js';

const flush = () => new Promise((resolve) => setImmediate(resolve));

function route(bodies) {
  const calls = [];
  const fetchImpl = async (url) => {
    calls.push(url);
    const next = bodies.length > 1 ? bodies.shift() : bodies[0];
    if (next instanceof Error) throw next;
    if (next === 404) return { ok: false, status: 404 };
    return { ok: true, json: async () => structuredClone(next) };
  };
  return { calls, fetchImpl };
}

function payload(records, generatedAt = 1_000_000) {
  return {
    configured: true,
    generatedAt,
    feeds: [
      { band: '1090', label: '1090 MHz', status: 'live', aircraft: 1 },
      { band: '978', label: '978 MHz UAT', status: 'live', aircraft: 1 },
    ],
    records,
  };
}

function aircraft(overrides = {}) {
  return {
    icao: 'ae5d8a',
    lat: 30.27,
    lon: -97.79,
    lastPositionAt: 999_000,
    lastMessageAt: 999_500,
    band: '1090',
    source: 'feed',
    ...overrides,
  };
}

test('an unconfigured server is asked once and never polled', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const { calls, fetchImpl } = route([
    { configured: false, feeds: [], records: [] },
  ]);
  const feeds = createLocalReceiverFeeds({ fetchImpl });
  feeds.start();
  await flush();
  assert.deepEqual(calls, [LOCAL_RECEIVERS_URL]);
  assert.equal(feeds.getState().configured, false);
  assert.equal(feeds.getState().polling, false);
  t.mock.timers.tick(5_000);
  await flush();
  assert.equal(calls.length, 1);
});

test('a build without the route stops after one failed request', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const { calls, fetchImpl } = route([404]);
  const feeds = createLocalReceiverFeeds({ fetchImpl });
  feeds.start();
  await flush();
  t.mock.timers.tick(5_000);
  await flush();
  assert.equal(calls.length, 1);
  assert.equal(feeds.getState().configured, false);
});

test('configured feeds poll every second between start and stop, on the browser clock', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const { calls, fetchImpl } = route([payload([aircraft()])]);
  const clock = 1_000_250;
  const feeds = createLocalReceiverFeeds({ fetchImpl, now: () => clock });
  const seen = [];
  feeds.subscribe((state) => seen.push(state.polling));
  feeds.start();
  await flush();
  const state = feeds.getState();
  assert.equal(state.configured, true);
  assert.equal(state.polling, true);
  assert.equal(state.feeds.length, 2);
  // Server generated at 1_000_000; received at 1_000_250: rebased +250 ms.
  assert.equal(state.records[0].lastPositionAt, 999_250);
  assert.equal(state.records[0].lastMessageAt, 999_750);

  t.mock.timers.tick(1_000);
  await flush();
  t.mock.timers.tick(1_000);
  await flush();
  assert.equal(calls.length, 3);
  feeds.stop();
  t.mock.timers.tick(5_000);
  await flush();
  assert.equal(calls.length, 3, 'no polling once stopped');
  assert.equal(feeds.getState().polling, false);
  assert.equal(seen.at(-1), false);
});

test('an aircraft a feed drops is kept until 60 s after its last message', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const bodies = [
    payload([aircraft(), aircraft({ band: '978' })], 1_000_000),
    payload([aircraft()], 1_010_000),
    payload([], 1_060_000),
  ];
  let clock = 1_000_000;
  const { fetchImpl } = route(bodies);
  const feeds = createLocalReceiverFeeds({ fetchImpl, now: () => clock });
  feeds.start();
  await flush();
  assert.equal(feeds.getState().records.length, 2);
  clock = 1_010_000;
  t.mock.timers.tick(1_000);
  await flush();
  assert.deepEqual(
    feeds.getState().records.map((record) => record.band),
    ['1090', '978'],
    'the 978 reception is remembered',
  );
  clock = 1_060_000;
  t.mock.timers.tick(1_000);
  await flush();
  assert.deepEqual(feeds.getState().records, [], 'forgotten after 60 s');
  feeds.stop();
});

test('a route that answered before is reported unreachable and polled again', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const { calls, fetchImpl } = route([
    payload([aircraft()]),
    new TypeError('network down'),
    payload([aircraft()]),
  ]);
  const feeds = createLocalReceiverFeeds({ fetchImpl, now: () => 1_000_000 });
  feeds.start();
  await flush();
  t.mock.timers.tick(1_000);
  await flush();
  assert.deepEqual(
    feeds.getState().feeds.map((feed) => feed.status),
    ['unreachable', 'unreachable'],
  );
  assert.equal(feeds.getState().records.length, 1, 'recent records remain');
  t.mock.timers.tick(1_000);
  await flush();
  assert.equal(calls.length, 3);
  assert.equal(feeds.getState().feeds[0].status, 'live');
  feeds.stop();
});

test('probe asks once without polling so the Radio card can list feeds', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const { calls, fetchImpl } = route([payload([aircraft()])]);
  const feeds = createLocalReceiverFeeds({ fetchImpl, now: () => 1_000_000 });
  await Promise.all([feeds.probe(), feeds.probe()]);
  assert.equal(calls.length, 1);
  assert.equal(feeds.getState().configured, true);
  assert.equal(feeds.getState().polling, false);
  await feeds.probe();
  t.mock.timers.tick(5_000);
  await flush();
  assert.equal(calls.length, 1);
});

test('two feeds on one band keep the fresher record, whichever is listed last', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const fresh = aircraft({ lastPositionAt: 999_000, lastMessageAt: 999_500 });
  // A second 1090 feed that heard the aircraft earlier and has no position.
  const older = aircraft({
    lat: null,
    lon: null,
    lastPositionAt: null,
    lastMessageAt: 990_000,
  });
  const { fetchImpl } = route([
    payload([fresh, older], 1_000_000),
    payload([older], 1_000_000),
  ]);
  const feeds = createLocalReceiverFeeds({ fetchImpl, now: () => 1_000_000 });
  feeds.start();
  await flush();
  let [kept] = feeds.getState().records;
  assert.equal(feeds.getState().records.length, 1);
  assert.equal(kept.lastPositionAt, 999_000, 'same response');
  t.mock.timers.tick(1_000);
  await flush();
  [kept] = feeds.getState().records;
  assert.equal(kept.lastPositionAt, 999_000, 'next poll');
  assert.equal(kept.lat, 30.27);
  feeds.stop();
});

/** A route whose requests never answer until their signal aborts. */
function stalledRoute({ stallBody = false } = {}) {
  const signals = [];
  const hang = (signal) =>
    new Promise((_, reject) => {
      signal?.addEventListener('abort', () =>
        reject(new DOMException('aborted', 'AbortError')),
      );
    });
  const fetchImpl = async (url, options = {}) => {
    signals.push(options.signal);
    if (!stallBody) return hang(options.signal);
    return { ok: true, json: () => hang(options.signal) };
  };
  return { signals, fetchImpl };
}

test('a stalled feed request is abandoned at its deadline and polling continues', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  for (const stallBody of [false, true]) {
    const { signals, fetchImpl } = stalledRoute({ stallBody });
    const feeds = createLocalReceiverFeeds({
      fetchImpl,
      now: () => 1_000_000,
      requestTimeoutMs: 3_000,
    });
    feeds.start();
    await flush();
    assert.equal(signals.length, 1);
    assert.ok(signals[0], 'every request carries an abort signal');
    t.mock.timers.tick(3_000);
    await flush();
    assert.equal(signals[0].aborted, true, `aborted (stallBody ${stallBody})`);
    assert.equal(feeds.getState().configured, false, 'never answered');
    feeds.destroy();
  }
});

test('stop() aborts the request in flight so start() is never blocked by it', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const { signals, fetchImpl } = stalledRoute();
  const feeds = createLocalReceiverFeeds({ fetchImpl, now: () => 1_000_000 });
  feeds.start();
  await flush();
  feeds.stop();
  assert.equal(signals[0].aborted, true);
  feeds.start();
  await flush();
  feeds.stop();
  feeds.start();
  await flush();
  assert.equal(signals.length, 3);
  assert.deepEqual(
    signals.map((signal) => signal.aborted),
    [true, true, false],
    'no disable/enable cycle leaves an old request outstanding',
  );
  feeds.destroy();
  assert.equal(signals[2].aborted, true);
});
