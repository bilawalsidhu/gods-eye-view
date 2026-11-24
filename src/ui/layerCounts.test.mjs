import test from 'node:test';
import assert from 'node:assert/strict';
import { createPinia } from 'pinia';
import {
  configureApplicationServices,
  getConfiguredLayerCounts,
  getLayerCountsServiceBinding,
  LAYER_COUNTS_TIMEOUT_MS,
} from '../services/application.js';
import { createApplicationRequestServices } from '../services/requests.js';
import {
  countAgeMs,
  createLayerCounts,
  LAYER_COUNTS_REFETCH_MS,
} from './layerCounts.js';
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
  function owner(getCounts, sourceOptions = {}) {
    return createLayerCounts({
      getCounts,
      readState: () => store.state,
      writeState: store.publish,
      readShown: () => live.shown,
      now: () => live.at,
      ...sourceOptions,
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
      { layerId: 'flights', count: 8500, at: 9 },
      { layerId: 'flights', count: 8600 },
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

test('the returned server clock calibrates the displayed age without changing the observation timestamp', async () => {
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
  assert.equal(row.at, observation);
  assert.equal(countAgeMs(row, live.at), 60_000);
  assert.equal(countAgeMs(row, live.at + 120_000), 180_000);
  assert.equal(countAgeMs({ at: live.at - 5000 }, live.at), 5000);
  assert.equal(countAgeMs({ at: null }, live.at), null);

  // A later response with the same row can carry a different clock offset.
  live.at = fromServer + 2 * 60 * 60_000;
  counts.update(layersOn);
  await counts.update(empty);
  const recalibrated = store.state.counts.satellites;
  assert.equal(recalibrated.at, observation);
  assert.equal(countAgeMs(recalibrated, live.at), 60_000);
});

test('a throttled count retries on an eligible entry after Retry-After, including after an aborted retry', async () => {
  const { store, live, owner } = harness();
  const waiting = Promise.withResolvers();
  const replies = [
    () => Response.json(satellites(1272, 1)),
    () =>
      new Response('rate limited', {
        status: 429,
        headers: { 'Retry-After': '60' },
      }),
    ({ signal }) => {
      waiting.resolve(signal);
      return new Promise((_, reject) =>
        signal.addEventListener('abort', () => reject(signal.reason), {
          once: true,
        }),
      );
    },
    () => Response.json(satellites(1300, 2)),
  ];
  let requests = 0;
  const services = createApplicationRequestServices({
    fetchImpl: async (_url, options) => replies[requests++](options),
  });
  const counts = owner(services.layerCounts.getCounts);
  live.shown = true;
  await counts.update(empty);
  const known = store.state.counts;
  const enter = () => {
    counts.update(layersOn);
    return counts.update(empty);
  };
  live.at += LAYER_COUNTS_REFETCH_MS;
  await enter();
  assert.equal(store.state.counts, known);
  live.at += 59_999;
  await enter();
  assert.equal(requests, 2);
  live.at++;
  counts.update(empty);
  assert.equal(requests, 2, 'staying in the view does not poll');

  const pending = enter();
  const signal = await waiting.promise;
  counts.update(hidden);
  assert.equal(signal.aborted, true);
  await pending;
  await counts.update(empty);
  assert.equal(requests, 4);
  assert.equal(store.state.counts.satellites.count, 1300);
});

test('a late throttle from a replaced count adapter does not delay the next eligible entry', async (t) => {
  const { store, live, owner } = harness();
  const oldRequest = Promise.withResolvers();
  const rateLimit = Object.assign(new Error('Layer counts unavailable (429)'), {
    retryAfterMs: 9_000_000,
  });
  let firstCall = true;
  t.after(
    configureApplicationServices({
      layerCounts: {
        getCounts() {
          if (!firstCall) return oldRequest.promise;
          firstCall = false;
          return Promise.reject(rateLimit);
        },
      },
    }),
  );
  await assert.rejects(
    getConfiguredLayerCounts(),
    (error) => error === rateLimit,
  );

  const counts = owner(getConfiguredLayerCounts);
  live.shown = true;
  const pending = counts.update(empty);
  let replacementCalls = 0;
  t.after(
    configureApplicationServices({
      layerCounts: {
        async getCounts() {
          replacementCalls++;
          return satellites(1300, 2);
        },
      },
    }),
  );
  oldRequest.reject(rateLimit);
  await pending;

  live.at += LAYER_COUNTS_REFETCH_MS;
  counts.update(layersOn);
  await counts.update(empty);
  assert.equal(replacementCalls, 1);
  assert.equal(store.state.counts.satellites.count, 1300);
  assert.equal(store.state.retryAt, undefined);
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

test('a binding change aborts the old provider without blocking the new read', async (t) => {
  const { store, live, owner } = harness();
  const previous = Promise.withResolvers();
  const sourceA = t.mock.fn(() => previous.promise);
  const releaseA = configureApplicationServices({
    layerCounts: { getCounts: sourceA },
  });
  t.after(releaseA);
  const counts = owner(getConfiguredLayerCounts, {
    readSourceBinding: getLayerCountsServiceBinding,
    bindSource: store.bindSource,
  });
  t.after(() => counts.stop());
  live.shown = true;
  const oldRequest = counts.update(empty);
  assert.equal(sourceA.mock.callCount(), 1);

  const sourceB = t.mock.fn(async () => satellites(42, 2));
  t.after(
    configureApplicationServices({ layerCounts: { getCounts: sourceB } }),
  );
  releaseA();
  await counts.update(empty);
  assert.equal(sourceA.mock.calls[0].arguments[0].signal.aborted, true);
  assert.equal(sourceB.mock.callCount(), 1);
  assert.equal(store.state.counts.satellites.count, 42);

  previous.resolve(satellites(7, 1));
  await oldRequest;
  assert.equal(store.state.counts.satellites.count, 42);
  assert.equal(store.state.lastAttemptAt, 0, 'the start times need not differ');
});

test('a provider abort can hide the Inspector before the replacement starts', async () => {
  const { store, live, owner } = harness();
  const previous = Promise.withResolvers();
  const sourceA = ({ signal }) => {
    signal.addEventListener(
      'abort',
      () => {
        live.shown = false;
      },
      { once: true },
    );
    return previous.promise;
  };
  let replacementReads = 0;
  const sourceB = () => {
    replacementReads++;
    return satellites(42, 2);
  };
  let source = sourceA;
  const counts = owner((request) => source(request), {
    readSourceBinding: () => source,
    bindSource: store.bindSource,
  });

  live.shown = true;
  const oldRequest = counts.update(empty);
  assert.equal(store.state.lastAttemptAt, 0);
  source = sourceB;
  live.at = 100;
  await counts.update(empty);
  assert.equal(replacementReads, 0);
  assert.deepEqual(store.state, { counts: {}, lastAttemptAt: null });

  live.shown = true;
  await counts.update(empty);
  previous.resolve(satellites(7, 1));
  await oldRequest;
  assert.equal(replacementReads, 1);
  assert.equal(store.state.lastAttemptAt, 100);
  assert.equal(store.state.counts.satellites.count, 42);
});

test('a provider abort can deliver a newer layer sample before the replacement starts', async () => {
  const { store, live, owner } = harness();
  const previous = Promise.withResolvers();
  let replacementReads = 0;
  const sourceB = () => {
    replacementReads++;
    return satellites(42, 2);
  };
  let source = ({ signal }) => {
    signal.addEventListener('abort', () => counts.update(layersOn), {
      once: true,
    });
    return previous.promise;
  };
  const counts = owner((request) => source(request), {
    readSourceBinding: () => source,
    bindSource: store.bindSource,
  });

  live.shown = true;
  const oldRequest = counts.update(empty);
  source = sourceB;
  await counts.update(empty);
  assert.equal(replacementReads, 0);
  assert.equal(store.state.lastAttemptAt, null);

  await counts.update(empty);
  previous.resolve(satellites(7, 1));
  await oldRequest;
  assert.equal(replacementReads, 1);
  assert.equal(store.state.counts.satellites.count, 42);
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
