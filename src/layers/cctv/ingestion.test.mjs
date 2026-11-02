import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createIngestion } from './ingestion.js';

function setup() {
  const record = { camera: { id: 'a' } };
  const state = {
    _enabled: true,
    _activeCameraId: 'a',
    _tilesReadyReenqueued: true,
    _records: [record],
  };
  const calls = { health: 0, notify: 0, queues: [] };
  const parts = {
    rendering: { refreshHorizonCulling: () => false },
    model: { projectionTilesReady: () => true },
    ground: { isGroundResolved: () => false },
    geometryQueue: {
      geometryWorkingSet: () => state._records,
      enqueueGeometryRefresh: (records) => calls.queues.push(records),
    },
    health: {
      async syncHealthState() {
        calls.health++;
      },
    },
    navigation: { maybeAutoHop() {} },
    presentation: {
      notifyListeners() {
        calls.notify++;
      },
    },
  };
  const layer = createIngestion({ state, parts }).methods;
  return { state, parts, calls, layer, record };
}

test('CCTV health-only ticks update the panel without claiming scene changes', async () => {
  const h = setup();
  for (let i = 0; i < 3; i++)
    assert.deepEqual(await h.layer.update(), { changed: false });
  assert.equal(h.calls.health, 3);
  assert.equal(h.calls.notify, 3);
  assert.ok(h.state._lastUpdate > 0);
});

test('CCTV completion refresh publishes geometry work exactly once', async () => {
  const h = setup();
  h.state._tilesReadyReenqueued = false;
  assert.deepEqual(await h.layer.update(), { changed: true });
  assert.deepEqual(h.calls.queues, [[h.record]]);
  assert.deepEqual(await h.layer.update(), { changed: false });
  assert.equal(h.calls.queues.length, 1);
});

test('a ready surface with no unresolved records does not claim geometry work', async () => {
  const h = setup();
  h.state._tilesReadyReenqueued = false;
  h.parts.ground.isGroundResolved = () => true;
  assert.deepEqual(await h.layer.update(), { changed: false });
  assert.equal(h.calls.queues.length, 0);
});

test('CCTV auto-hop still publishes its changed active camera', async () => {
  const h = setup();
  h.parts.navigation.maybeAutoHop = () => {
    h.state._activeCameraId = 'b';
  };
  assert.deepEqual(await h.layer.update(), { changed: true });
  assert.deepEqual(await h.layer.update(), { changed: false });
});

test('disabled CCTV does no polling or presentation work', async () => {
  const h = setup();
  h.state._enabled = false;
  await h.layer.update();
  assert.equal(h.calls.health + h.calls.notify + h.calls.queues.length, 0);
});
