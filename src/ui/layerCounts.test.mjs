import test from 'node:test';
import assert from 'node:assert/strict';
import { createPinia } from 'pinia';
import {
  configureApplicationServices,
  getConfiguredLayerCounts,
} from '../services/application.js';
import { LAYER_COUNTS_TIMEOUT_MS } from '../services/layerCountService.js';
import { createLayerCounts, LAYER_COUNTS_REFETCH_MS } from './layerCounts.js';
import { useLayerCountsStore } from './stores/layerCounts.js';

const hidden = { shown: false, nothingOn: true };
const empty = { shown: true, nothingOn: true };
const layersOn = { shown: true, nothingOn: false };
const satellites = (count, at) => ({
  counts: [{ layerId: 'satellites', count, at }],
});

function harness() {
  const store = useLayerCountsStore(createPinia());
  const live = { shown: false, at: 0 };
  function owner(getCounts) {
    return createLayerCounts({
      getCounts,
      readState: () => store.state,
      writeState: store.publish,
      readShown: () => live.shown,
      now: () => live.at,
    });
  }
  return { store, live, owner };
}

test('one request per eligible entry, with a half-hour cooldown across owners on the same app', async () => {
  const { store, live, owner } = harness();
  let asks = 0;
  const getCounts = () => {
    asks++;
    return satellites(1272, 1);
  };
  const first = owner(getCounts);
  first.update(hidden);
  assert.equal(asks, 0);
  live.shown = true;
  first.update(layersOn);
  assert.equal(asks, 0);
  await first.update(empty);
  assert.equal(asks, 1);
  assert.equal(store.state.counts.satellites.count, 1272);
  assert.equal(store.state.lastAttemptAt, 0);
  first.stop();

  const second = owner(getCounts);
  live.at = LAYER_COUNTS_REFETCH_MS - 1;
  second.update(empty);
  assert.equal(asks, 1, 'the app keeps the cooldown after replacing controls');
  live.at++;
  second.update(empty);
  assert.equal(
    asks,
    1,
    'a pulse in the same eligible view cannot start a request',
  );
  second.update(layersOn);
  await second.update(empty);
  assert.equal(asks, 2);
  assert.deepEqual(useLayerCountsStore(createPinia()).state, {
    counts: {},
    lastAttemptAt: null,
  });
});

test('counts keep their source and timestamp; only allowed cached and nominal worldwide totals get tiles', async () => {
  const { store, live, owner } = harness();
  const body = {
    counts: [
      { layerId: 'traffic', count: 50, at: 10 },
      { layerId: 'flights', count: 8700, at: 10 },
      { layerId: 'satellites', count: 1272, at: 10 },
      { layerId: 'ais-live-vessels', count: 9, at: null },
      { layerId: 'cctv', count: 0, at: 10 },
    ],
  };
  const counts = owner(() => body);
  live.shown = true;
  await counts.update(empty);
  assert.deepEqual(store.state.counts, {
    flights: { count: 8700, at: 10, live: false },
    satellites: { count: 1272, at: 10, live: false },
    'ais-live-vessels': { count: 9, at: null, live: false },
  });
  const nominal = { id: 'flights', tone: 'nominal' };
  const prior = store.state;
  counts.update(layersOn);
  counts.note([
    { ...nominal, worldTotal: 9000, updatedAt: null },
    { ...nominal, worldTotal: 9000, updatedAt: 9 },
    { ...nominal, worldTotal: null, updatedAt: 30 },
    { ...nominal, tone: 'loading', worldTotal: 9000, updatedAt: 30 },
    { ...nominal, id: 'traffic', worldTotal: 9000, updatedAt: 30 },
  ]);
  assert.equal(store.state, prior);
  counts.note([{ ...nominal, worldTotal: 9100, updatedAt: 30 }]);
  assert.deepEqual(store.state.counts.flights, {
    count: 9100,
    at: 30,
    live: true,
  });

  live.at += LAYER_COUNTS_REFETCH_MS;
  body.counts = [
    { layerId: 'flights', count: 9300, at: 30 },
    { layerId: 'flights', count: 8700, at: 10 },
    { layerId: 'flights', count: 8500 },
  ];
  const noted = store.state.counts;
  await counts.update(empty);
  assert.equal(
    store.state.counts,
    noted,
    'cache results must be newer than an existing live count',
  );
  live.shown = false;
  counts.note([{ ...nominal, worldTotal: 9200, updatedAt: 40 }]);
  assert.equal(
    store.state.counts,
    noted,
    'live visibility fences notes before the watcher',
  );
});

test('a failed request keeps the known counts and its cooldown', async () => {
  const { store, live, owner } = harness();
  let asks = 0;
  const counts = owner(async () => {
    asks++;
    throw new TypeError('offline');
  });
  live.shown = true;
  counts.update(layersOn);
  counts.note([
    { id: 'satellites', tone: 'nominal', worldTotal: 900, updatedAt: 1 },
  ]);
  await counts.update(empty);
  counts.update(hidden);
  counts.update(empty);
  assert.equal(asks, 1);
  assert.equal(store.state.lastAttemptAt, 0);
  assert.equal(store.state.counts.satellites.count, 900);
});

test('hide releases the old request immediately; a late answer cannot touch the replacement', async () => {
  const { store, live, owner } = harness();
  const asks = [];
  const counts = owner(
    ({ signal }) => new Promise((resolve) => asks.push({ signal, resolve })),
  );
  live.shown = true;
  const first = counts.update(empty);
  live.shown = false;
  counts.update(hidden);
  assert.ok(asks[0].signal.aborted);
  assert.equal(store.state.lastAttemptAt, null);
  live.shown = true;
  live.at++;
  const second = counts.update(empty);
  counts.update(layersOn);
  assert.equal(asks.length, 2);
  asks[0].resolve(satellites(1272, 100));
  await first;
  assert.deepEqual(store.state, { counts: {}, lastAttemptAt: 1 });
  assert.equal(asks[1].signal.aborted, false);
  asks[1].resolve(satellites(1300, 50));
  await second;
  assert.equal(store.state.counts.satellites.count, 1300);
});

test('a completion that observes a coalesced hide admits one replacement on the next visible sample', async () => {
  const { store, live, owner } = harness();
  const asks = [];
  const counts = owner(
    ({ signal }) => new Promise((resolve) => asks.push({ signal, resolve })),
  );
  live.shown = true;
  const first = counts.update(empty);
  live.shown = false;
  asks[0].resolve(satellites(1272, 100));
  await first;
  assert.ok(asks[0].signal.aborted);
  assert.deepEqual(store.state, { counts: {}, lastAttemptAt: null });
  assert.equal(asks.length, 1, 'the callback never starts a new ask');
  live.shown = true;
  const retry = counts.update(empty);
  counts.update(empty);
  assert.equal(asks.length, 2);
  asks[1].resolve(satellites(1300, 50));
  await retry;
  assert.equal(store.state.counts.satellites.count, 1300);
});

test('the configured deadline releases a noncooperating request and preserves its cooldown', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const { store, live, owner } = harness();
  const asks = [];
  t.after(
    configureApplicationServices({
      layerCounts: {
        getCounts: ({ signal }) =>
          new Promise((resolve) => asks.push({ signal, resolve })),
      },
    }),
  );
  const counts = owner(getConfiguredLayerCounts);
  live.shown = true;
  const first = counts.update(empty);
  assert.equal(asks.length, 1);
  t.mock.timers.tick(LAYER_COUNTS_TIMEOUT_MS - 1);
  assert.equal(asks[0].signal.aborted, false);
  t.mock.timers.tick(1);
  await first;
  assert.equal(asks[0].signal.reason.name, 'TimeoutError');
  assert.deepEqual(store.state, { counts: {}, lastAttemptAt: 0 });
  counts.update(layersOn);
  counts.update(empty);
  assert.equal(asks.length, 1);

  live.at += LAYER_COUNTS_REFETCH_MS;
  counts.update(layersOn);
  const retry = counts.update(empty);
  assert.equal(asks.length, 2, 'the timed-out attempt is no longer active');
  asks[1].resolve(satellites(1300, 50));
  await retry;
  asks[0].resolve(satellites(1272, 100));
  await Promise.resolve();
  assert.equal(store.state.counts.satellites.count, 1300);
});

test('hiding after the count deadline fires keeps the completed attempt cooldown', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const { store, live, owner } = harness();
  let asks = 0;
  const counts = owner(getConfiguredLayerCounts);
  t.after(
    configureApplicationServices({
      layerCounts: {
        getCounts({ signal }) {
          asks++;
          signal.addEventListener(
            'abort',
            () => {
              live.shown = false;
              counts.update(hidden);
            },
            { once: true },
          );
          return new Promise(() => {});
        },
      },
    }),
  );
  live.shown = true;
  const pending = counts.update(empty);
  t.mock.timers.tick(LAYER_COUNTS_TIMEOUT_MS);
  await pending;
  assert.deepEqual(store.state, { counts: {}, lastAttemptAt: 0 });
  live.shown = true;
  counts.update(empty);
  assert.equal(asks, 1);
});

test('stopping during count reservation prevents the adapter from starting', () => {
  let snapshot = { counts: {}, lastAttemptAt: null };
  let asks = 0;
  const counts = createLayerCounts({
    getCounts: () => {
      asks++;
    },
    readState: () => snapshot,
    writeState(next) {
      snapshot = next;
      if (next.lastAttemptAt !== null) counts.stop();
    },
    readShown: () => true,
  });
  counts.update(empty);
  assert.equal(asks, 0);
  assert.equal(snapshot.lastAttemptAt, null);
});

test('stop aborts in-flight work without changing live totals or touching the next owner', async () => {
  const { store, live, owner } = harness();
  let resolve;
  let signal;
  const first = owner((request) => {
    signal = request.signal;
    return new Promise((finish) => {
      resolve = finish;
    });
  });
  live.shown = true;
  first.update(layersOn);
  first.note([
    { id: 'satellites', tone: 'nominal', worldTotal: 900, updatedAt: 1 },
  ]);
  const request = first.update(empty);
  first.stop();
  assert.ok(signal.aborted);
  assert.equal(store.state.lastAttemptAt, null);
  assert.equal(store.state.counts.satellites.count, 900);

  live.at++;
  const second = owner(() => satellites(1300, 50));
  await second.update(empty);
  resolve(satellites(1272, 100));
  await request;
  first.update(empty);
  first.note([
    { id: 'satellites', tone: 'nominal', worldTotal: 917, updatedAt: 60 },
  ]);
  assert.deepEqual(store.state, {
    counts: { satellites: { count: 1300, at: 50, live: false } },
    lastAttemptAt: 1,
  });
});
