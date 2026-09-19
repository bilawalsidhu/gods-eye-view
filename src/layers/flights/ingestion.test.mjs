import test from 'node:test';
import assert from 'node:assert/strict';
import { createIngestion } from './ingestion.js';

function setup(source) {
  const feed = {
    _source: source,
    _activeUpdateControllers: new Set(),
    _trackingRefreshEpoch: 0,
    _lastSource: 'Fixture',
    _lastCoverage: 'local',
    _retryAt: 0,
  };
  const accepted = [];
  const labels = [];
  const restores = [];
  const { methods } = createIngestion({
    feed,
    getQuery: () => ({ latitude: 39 }),
    applySnapshot: (snapshot) => {
      accepted.push(snapshot);
      return { count: 2, ids: new Set(['abc123']) };
    },
    setSourceLabel: (label) => labels.push(label),
    applyPendingTrackingRestore: () => restores.push(true),
  });
  return { feed, accepted, labels, restores, update: methods.update };
}

test('civil acquisition rejects late completion after cancellation without publishing records', async () => {
  let release;
  const probe = setup({
    getSnapshot: () =>
      new Promise((resolve) => {
        release = resolve;
      }),
  });
  const request = probe.update(null);
  assert.equal(probe.feed._activeUpdateControllers.size, 1);
  for (const controller of probe.feed._activeUpdateControllers)
    controller.abort();
  release({ records: [] });
  await assert.rejects(request, { name: 'AbortError' });
  assert.equal(probe.accepted.length, 0);
  assert.equal(probe.restores.length, 0);
  assert.equal(probe.feed._activeUpdateControllers.size, 0);
});

test('civil acquisition publishes source time and uses a replaced source on the next request', async () => {
  let calls = 0;
  const probe = setup({
    async getSnapshot(query) {
      assert.equal(query.latitude, 39);
      calls += 1;
      return {
        records: [],
        source: 'First',
        observedAtMs: 1234,
        freshness: 'fresh',
        coverage: 'worldwide',
      };
    },
  });
  await probe.update(null);
  assert.equal(probe.feed._lastUpdate, 1234);
  assert.equal(probe.feed._count, 2);
  assert.deepEqual([...probe.feed._lastTrackingRefreshOutcome.ids], ['abc123']);
  probe.feed._source = {
    async getSnapshot() {
      return {
        records: [],
        source: 'Second',
        observedAtMs: 1250,
        freshness: 'unknown',
      };
    },
  };
  await probe.update(null);
  assert.equal(calls, 1);
  assert.equal(probe.feed._lastUpdate, 1250);
  assert.equal(probe.feed._backoff, true);
  assert.equal(probe.feed._lastError, 'Source snapshot time unavailable');
  assert.deepEqual(probe.labels, ['First', 'Second']);
  assert.equal(probe.restores.length, 2);
});

test('civil acquisition keeps a degraded proxy answer out of error, backs off a stale one with its reason and records an unavailable one', async () => {
  const snapshots = [
    {
      records: [],
      source: 'adsb.lol',
      coverage: '250nm regional fallback',
      observedAtMs: 5000,
      ageMs: 1000,
      freshness: 'current',
      stale: false,
      providerStatus: 'degraded',
      providerError:
        'OpenSky unreachable from this deployment (connect timeout) - adsb.lol regional feed',
    },
    {
      records: [],
      source: 'OpenSky Network',
      coverage: '3.0deg scene box around 30.00,-97.00',
      observedAtMs: 6000,
      ageMs: 20000,
      freshness: 'stale',
      stale: true,
      providerStatus: 'stale',
      providerError:
        'OpenSky rate limited (retry in 90s) - last-good OpenSky snapshot',
    },
  ];
  const probe = setup({
    async getSnapshot() {
      return snapshots.shift();
    },
  });
  await probe.update(null);
  assert.equal(probe.feed._providerStatus, 'degraded');
  assert.match(probe.feed._providerError, /^OpenSky unreachable/);
  assert.equal(probe.feed._lastError, null, 'current data is not an error');
  assert.equal(probe.feed._backoff, false);
  assert.equal(probe.feed._lastSource, 'adsb.lol');
  assert.equal(probe.feed._lastCoverage, '250nm regional fallback');
  await probe.update(null);
  assert.equal(probe.feed._providerStatus, 'stale');
  assert.equal(probe.feed._backoff, true);
  assert.equal(
    probe.feed._lastError,
    'OpenSky rate limited (retry in 90s) - last-good OpenSky snapshot',
  );
  assert.equal(probe.feed._lastUpdate, 6000);
  const error = Object.assign(new Error('OpenSky HTTP 503 reason'), {
    name: 'LiveSourceError',
    status: 503,
    retryAfterMs: 20000,
    source: 'OpenSky Network',
  });
  probe.feed._source = {
    async getSnapshot() {
      throw error;
    },
  };
  await probe.update(null);
  assert.equal(probe.feed._providerStatus, 'unavailable');
  assert.equal(probe.feed._providerError, 'OpenSky HTTP 503 reason');
  assert.equal(probe.feed._lastError, 'OpenSky HTTP 503 reason');
  assert.equal(probe.feed._backoff, true);
});
