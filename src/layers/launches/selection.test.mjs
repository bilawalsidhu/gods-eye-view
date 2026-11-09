import test from 'node:test';
import assert from 'node:assert/strict';
import { createFakeEngine } from '../../globe/testing/fakeEngine.js';
import { createSelection } from './selection.js';

test('restoring a mission zoom anchor preserves the world camera pose', (t) => {
  const engine = createFakeEngine();
  t.after(() => engine.destroy());
  const state = { _engine: engine };
  const selection = createSelection({
    state,
    services: { geometry: {} },
    parts: { camera: { missionZoomPitch: () => -0.5 } },
  });
  const before = engine.camera.pose();
  selection.startMissionZoomAnchor(
    { id: 'mission', lon: 30, lat: 15 },
    200000,
    { resuming: true },
  );
  const after = engine.camera.pose();
  assert.deepEqual(after.position, before.position);
  assert.equal(after.heading, before.heading);
  assert.equal(after.pitch, before.pitch);
});
