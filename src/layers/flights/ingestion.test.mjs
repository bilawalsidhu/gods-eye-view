import test from 'node:test';
import assert from 'node:assert/strict';
import { bindRenderer } from '../../render/rendererOf.js';
import { createIngestion } from './ingestion.js';
import { flightQuery } from './index.js';

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

test('the feed is asked for the flights around the camera port’s ground point', () => {
  let pose = { lon: -97.04, lat: 32.9, height: 9000 };
  const viewer = {};
  const unbind = bindRenderer(viewer, { camera: { pose: () => pose } });
  try {
    assert.deepEqual(flightQuery(viewer), {
      latitude: 32.9,
      longitude: -97.04,
    });
    pose = { lon: NaN, lat: NaN, height: NaN };
    assert.deepEqual(flightQuery(viewer), {}, 'no ground point: no area');
    pose = { lon: -97.04, lat: NaN, height: 9000 };
    assert.deepEqual(flightQuery(viewer), {}, 'half a ground point: none');
  } finally {
    unbind();
  }
});

test('with no viewer or camera the query names no area', () => {
  assert.deepEqual(flightQuery(null), {});
  assert.deepEqual(flightQuery(undefined), {});
  assert.deepEqual(flightQuery({}), {}, 'a viewer with no camera');
  assert.deepEqual(
    flightQuery({ isDestroyed: () => true, camera: {} }),
    {},
    'a destroyed viewer',
  );
});
