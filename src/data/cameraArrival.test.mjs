import test from 'node:test';
import assert from 'node:assert/strict';
import { createFakeEngine } from '../globe/testing/fakeEngine.js';
import { LayerLifecycle } from './lifecycle.js';
import { cancelCameraArrival, ownCameraArrival } from './cameraArrival.js';

test('an arrival owned on the engine yields to a cancel on the engine', () => {
  const engine = createFakeEngine();
  const cancelled = [];
  // A correction releases its ownership when it stops, as the ground guard does.
  const own = (key, name) => {
    let release = () => {};
    release = ownCameraArrival(key, () => {
      cancelled.push(name);
      release();
    });
  };
  own(engine, 'first');
  cancelCameraArrival(engine);
  own(engine, 'second');
  cancelCameraArrival(engine);
  assert.deepEqual(cancelled, ['first', 'second']);
});

test('a newer arrival replaces the older one and release is idempotent', () => {
  const engine = createFakeEngine();
  const seen = [];
  const releaseOld = ownCameraArrival(engine, () => seen.push('old'));
  ownCameraArrival(engine, () => seen.push('new'));
  assert.deepEqual(seen, ['old']);
  releaseOld();
  cancelCameraArrival(engine);
  assert.deepEqual(seen, ['old', 'new']);
  cancelCameraArrival(null);
  assert.deepEqual(seen, ['old', 'new']);
});

test('disabling a layer cancels an engine arrival without a native viewer', async () => {
  const engine = createFakeEngine();
  const manager = new LayerLifecycle(null, { engine });
  manager.register({
    id: 'arrival',
    name: 'Arrival',
    init() {},
    enable() {},
    disable() {},
    update() {},
    updateInterval: -1,
  });
  let cancelled = 0;
  const release = ownCameraArrival(engine, () => {
    cancelled++;
  });
  try {
    await manager.setEnabled('arrival', false);
    assert.equal(cancelled, 1);
  } finally {
    release();
    await manager.destroyLayer('arrival');
    engine.destroy();
  }
});
