import test from 'node:test';
import assert from 'node:assert/strict';
import { createFakeEngine } from '../globe/testing/fakeEngine.js';
import {
  cameraSensitivityClaims,
  claimCameraSensitivity,
  releaseCameraSensitivity,
} from './cameraSensitivity.js';

test('claims on a globe engine set its camera sensitivity and share one ledger', () => {
  const engine = createFakeEngine();
  assert.equal(claimCameraSensitivity(engine, 'traffic', 0.05), 0.05);
  assert.equal(engine.camera.percentageChanged, 0.05);
  // The engine and its camera are the same claimant.
  assert.equal(
    claimCameraSensitivity(engine.camera, 'installations', 0.01),
    0.01,
  );
  assert.deepEqual(cameraSensitivityClaims(engine), [
    'traffic',
    'installations',
  ]);
  assert.equal(releaseCameraSensitivity(engine, 'installations'), 0.05);
  assert.equal(releaseCameraSensitivity(engine.camera, 'traffic'), 0.5);
  assert.equal(engine.camera.percentageChanged, 0.5);
  assert.deepEqual(cameraSensitivityClaims(engine), []);
});

test("a Cesium engine's claims share one ledger and set its viewer's camera", async () => {
  const { createFakeViewer } =
    await import('../globe/cesium/testing/fakeViewer.mjs');
  const { createCesiumEngine } =
    await import('../globe/cesium/createCesiumEngine.js');
  const viewer = createFakeViewer();
  const engine = createCesiumEngine(viewer, { requestRender: () => {} });
  try {
    claimCameraSensitivity(engine.camera, 'traffic', 0.05);
    claimCameraSensitivity(engine, 'transit', 0.05);
    // One ledger: both claims are on it, and releasing one keeps the other.
    assert.deepEqual(cameraSensitivityClaims(engine).sort(), [
      'traffic',
      'transit',
    ]);
    releaseCameraSensitivity(engine, 'transit');
    assert.equal(viewer.camera.percentageChanged, 0.05);
    releaseCameraSensitivity(engine.camera, 'traffic');
    assert.equal(viewer.camera.percentageChanged, 0.5);
  } finally {
    engine.destroy();
  }
});
