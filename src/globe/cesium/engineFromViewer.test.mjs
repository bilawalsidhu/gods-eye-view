import test from 'node:test';
import assert from 'node:assert/strict';
import { isGlobeEngine } from '../contract.js';
import { createFakeEngine } from '../testing/fakeEngine.js';
import { engineFromViewer, registerViewerEngine } from './engineFromViewer.js';
import { createFakeViewer } from './testing/fakeViewer.mjs';

test('a viewer without a registered engine gets one built once and cached', () => {
  const viewer = createFakeViewer();
  const engine = engineFromViewer(viewer);
  assert.equal(isGlobeEngine(engine), true);
  assert.equal(engine.kind, 'cesium');
  assert.equal(engineFromViewer(viewer), engine);
  assert.deepEqual(viewer.calls, [], 'building it changes nothing');
  assert.notEqual(engineFromViewer(createFakeViewer()), engine);
});

test('the engine registered for a viewer is the one returned', () => {
  const viewer = createFakeViewer();
  const engine = createFakeEngine();
  const unregister = registerViewerEngine(viewer, engine);
  assert.equal(engineFromViewer(viewer), engine);
  unregister();
  const built = engineFromViewer(viewer);
  assert.notEqual(built, engine);
  unregister();
  assert.equal(
    engineFromViewer(viewer),
    built,
    'a stale unregister keeps the new one',
  );
});

test('an engine passes through, and no viewer is no engine', () => {
  const engine = createFakeEngine();
  assert.equal(engineFromViewer(engine), engine);
  assert.equal(engineFromViewer(null), null);
  assert.equal(engineFromViewer(undefined), null);
});

test('isGlobeEngine tells engines from viewers', () => {
  assert.equal(isGlobeEngine(createFakeEngine()), true);
  assert.equal(isGlobeEngine(createFakeViewer()), false);
  assert.equal(isGlobeEngine(null), false);
  assert.equal(isGlobeEngine({ kind: 'cesium' }), false);
});
