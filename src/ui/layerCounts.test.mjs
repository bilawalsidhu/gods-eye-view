import test from 'node:test';
import assert from 'node:assert/strict';
import { createPinia } from 'pinia';
import {
  configureApplicationServices,
  getConfiguredLayerCounts,
  LAYER_COUNTS_TIMEOUT_MS,
} from '../services/application.js';
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

test('only positive counts for the allowed layers are retained with their timestamps', async () => {
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
    flights: { count: 8700, at: 10 },
    satellites: { count: 1272, at: 10 },
    'ais-live-vessels': { count: 9, at: null },
  });
});

test('the returned server clock calibrates the displayed age on the local clock', async () => {
  const { store, live, owner } = harness();
  const fromServer = 6 * 60 * 60_000;
  const observation = fromServer - 60_000;
  const counts = owner(() => ({
    ...satellites(1272, observation),
    now: fromServer,
  }));
  live.shown = true;
  live.at = fromServer - 2 * 60 * 60_000;
  await counts.update(empty);
  const row = store.state.counts.satellites;
  assert.equal(row.count, 1272);
  assert.equal(row.at, live.at - 60_000);

  // A later response with the same row can carry a different clock offset.
  live.at = fromServer + 2 * 60 * 60_000;
  counts.update(layersOn);
  await counts.update(empty);
  const recalibrated = store.state.counts.satellites;
  assert.equal(recalibrated.at, live.at - 60_000);
});

test('a complete response withdraws omitted and zero counts', async () => {
  const { store, live, owner } = harness();
  let response = {
    counts: [
      { layerId: 'local-firms', count: 42, at: 1 },
      { layerId: 'flights', count: 900, at: 1 },
      { layerId: 'cctv', count: 5, at: 1 },
    ],
  };
  const counts = owner(() => response);
  live.shown = true;
  await counts.update(empty);
  assert.equal(store.state.counts['local-firms'].count, 42);

  live.at += LAYER_COUNTS_REFETCH_MS;
  response = {
    counts: [
      { layerId: 'flights', count: 950, at: 2 },
      { layerId: 'cctv', count: 0, at: 2 },
    ],
  };
  counts.update(layersOn);
  await counts.update(empty);
  assert.deepEqual(store.state.counts, {
    flights: { count: 950, at: 2 },
  });
});

test('a later satellite snapshot can have more IDs and an older contributing timestamp', async () => {
  const { store, live, owner } = harness();
  const hour = 60 * 60_000;
  let response = satellites(2, 4 * hour);
  const counts = owner(() => response);
  live.shown = true;
  live.at = 5 * hour;
  await counts.update(empty);
  assert.equal(store.state.counts.satellites.count, 2);

  // Restoring an older CelesTrak group adds an ID and lowers the source timestamp.
  response = satellites(3, 2 * hour);
  live.at += LAYER_COUNTS_REFETCH_MS;
  counts.update(layersOn);
  await counts.update(empty);
  assert.deepEqual(store.state.counts.satellites, {
    count: 3,
    at: 2 * hour,
  });

  const dated = store.state.counts;
  response = satellites(4, null);
  live.at += LAYER_COUNTS_REFETCH_MS;
  counts.update(layersOn);
  await counts.update(empty);
  assert.equal(
    store.state.counts,
    dated,
    'an undated row does not replace a dated one',
  );
});

test('a malformed response does not retire cached counts', async () => {
  const { store, live, owner } = harness();
  let response = satellites(1272, 1);
  const counts = owner(() => response);
  live.shown = true;
  await counts.update(empty);
  const before = store.state.counts;

  response = { counts: [null] };
  live.at += LAYER_COUNTS_REFETCH_MS;
  counts.update(layersOn);
  await counts.update(empty);
  assert.equal(store.state.counts, before);
});

test('a failed request keeps the known counts and its cooldown', async () => {
  const { store, live, owner } = harness();
  let asks = 0;
  const counts = owner(async () => {
    if (++asks === 1) return satellites(900, 1);
    throw new TypeError('offline');
  });
  live.shown = true;
  await counts.update(empty);
  const saved = store.state.counts;
  live.at += LAYER_COUNTS_REFETCH_MS;
  counts.update(layersOn);
  await counts.update(empty);
  counts.update(hidden);
  counts.update(empty);
  assert.equal(asks, 2);
  assert.equal(store.state.lastAttemptAt, live.at);
  assert.equal(store.state.counts, saved);
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

test('stop aborts in-flight work without changing server totals or touching the next owner', async () => {
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
  store.publish({
    ...store.state,
    counts: { satellites: { count: 900, at: 1 } },
  });
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
  assert.deepEqual(store.state.counts, {
    satellites: { count: 1300, at: 50 },
  });
  assert.equal(store.state.lastAttemptAt, 1);
});
