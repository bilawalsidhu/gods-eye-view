import test from 'node:test';
import assert from 'node:assert/strict';
import { isGlobeEngine } from '../contract.js';
import { createFakeEngine } from '../testing/fakeEngine.js';
import { engineFromViewer, registerViewerEngine } from './engineFromViewer.js';
import { createFakeViewer } from './testing/fakeViewer.mjs';

test('a viewer without a registered engine has none: nothing is built', () => {
  const viewer = createFakeViewer();
  assert.equal(engineFromViewer(viewer), null);
  assert.deepEqual(viewer.calls, []);
});

test('the engine registered for a viewer is returned until it is unregistered', () => {
  const viewer = createFakeViewer();
  const engine = createFakeEngine();
  const unregister = registerViewerEngine(viewer, engine);
  assert.equal(engineFromViewer(viewer), engine);
  unregister();
  assert.equal(engineFromViewer(viewer), null, 'a torn-down viewer has none');
  const next = createFakeEngine();
  registerViewerEngine(viewer, next);
  unregister();
  assert.equal(
    engineFromViewer(viewer),
    next,
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
