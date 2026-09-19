import test from 'node:test';
import assert from 'node:assert/strict';
import { createIngestion, createMilitaryFeed } from './ingestion.js';
function setup(source, getQuery) {
  const feed = createMilitaryFeed(source);
  const accepted = [];
  const labels = [];
  const restores = [];
  const { methods } = createIngestion({
    feed,
    ...(getQuery ? { getQuery } : {}),
    applySnapshot: (snapshot) => {
      accepted.push(snapshot);
      return { count: 1, ids: new Set(['aaa001']) };
    },
    setSourceLabel: (label) => labels.push(label),
    applyPendingTrackingRestore: () => restores.push(true),
  });
  return { feed, accepted, labels, restores, update: methods.update };
}

test('military acquisition cancels late replies without publishing or restoring tracking', async () => {
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

test('military acquisition keeps the degraded source reason and respects retry admission', async () => {
  let calls = 0;
  const probe = setup({
    async getSnapshot() {
      calls++;
      return {
        records: [],
        source: 'Fixture',
        observedAtMs: 1234,
        freshness: 'stale',
        stale: true,
        reason: 'Upstream refreshing',
      };
    },
  });
  await probe.update(null);
  assert.equal(probe.feed._lastUpdate, 1234);
  assert.equal(probe.feed._lastError, 'Upstream refreshing');
  assert.equal(probe.feed._backoff, true);
  assert.deepEqual(probe.labels, ['Fixture']);
  probe.feed._retryAt = Date.now() + 60000;
  await probe.update(null);
  assert.equal(calls, 1);
  assert.equal(probe.restores.length, 1);
  assert.equal(
    probe.feed._lastTrackingRefreshOutcome.status,
    'source-unavailable',
  );
});

test('military acquisition passes the scene query through and records the proxy status and coverage', async () => {
  const queries = [];
  const snapshots = [
    {
      records: [],
      source: 'adsb.fi',
      coverage: '600nm around 30,-97',
      observedAtMs: 4000,
      freshness: 'current',
      stale: false,
      providerStatus: 'degraded',
      providerError: 'adsb.lol HTTP 502 - adsb.fi feed',
    },
    {
      records: [],
      source: 'adsb.lol',
      coverage: 'military upstream snapshot',
      observedAtMs: 5000,
      freshness: 'stale',
      stale: true,
      reason: 'adsb.lol rate limited (retry in 20s) - last-good adsb.lol list',
      providerStatus: 'stale',
      providerError:
        'adsb.lol rate limited (retry in 20s) - last-good adsb.lol list',
    },
  ];
  const viewer = { camera: {} };
  const probe = setup(
    {
      async getSnapshot(query) {
        queries.push(query);
        return snapshots.shift();
      },
    },
    (received) => {
      assert.equal(received, viewer);
      return { latitude: 30, longitude: -97, radiusNm: 600 };
    },
  );
  assert.equal(probe.feed._lastCoverage, 'military upstream snapshot');
  assert.equal(probe.feed._providerStatus, null);
  await probe.update(viewer);
  assert.deepEqual(queries, [{ latitude: 30, longitude: -97, radiusNm: 600 }]);
  assert.equal(probe.feed._providerStatus, 'degraded');
  assert.equal(probe.feed._providerError, 'adsb.lol HTTP 502 - adsb.fi feed');
  assert.equal(probe.feed._lastCoverage, '600nm around 30,-97');
  assert.equal(probe.feed._lastError, null, 'current data is not an error');
  assert.equal(probe.feed._backoff, false);
  assert.deepEqual(probe.labels, ['adsb.fi']);
  await probe.update(viewer);
  assert.equal(probe.feed._providerStatus, 'stale');
  assert.equal(probe.feed._backoff, true);
  assert.match(probe.feed._lastError, /^adsb\.lol rate limited/);
  assert.equal(probe.feed._lastUpdate, 5000);
  const plain = setup({
    async getSnapshot(query) {
      queries.push(query);
      return {
        records: [],
        source: 'Fixture',
        observedAtMs: 1,
        freshness: 'current',
      };
    },
  });
  await plain.update(null);
  assert.deepEqual(queries.at(-1), {}, 'no query builder → empty query');
});
