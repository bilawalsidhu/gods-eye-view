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
