import test from 'node:test';
import assert from 'node:assert/strict';
import { createFakeEngine } from '../globe/testing/fakeEngine.js';
import { registerViewerEngine } from '../globe/cesium/engineFromViewer.js';
import { cancelCameraArrival, ownCameraArrival } from './cameraArrival.js';

test('an arrival owned on the engine yields to a cancel through its viewer', () => {
  const engine = createFakeEngine();
  const viewer = {};
  const unregister = registerViewerEngine(viewer, engine);
  const cancelled = [];
  // A correction releases its ownership when it stops, as the ground guard does.
  const own = (key, name) => {
    let release = () => {};
    release = ownCameraArrival(key, () => {
      cancelled.push(name);
      release();
    });
  };
  own(engine, 'engine-owned');
  cancelCameraArrival(viewer);
  own(viewer, 'viewer-owned');
  cancelCameraArrival(engine);
  assert.deepEqual(cancelled, ['engine-owned', 'viewer-owned']);
  unregister();
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
