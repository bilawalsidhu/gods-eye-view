import test from 'node:test';
import assert from 'node:assert/strict';
import { DetectionProjectionCache } from './detectionProjectionCache.js';

test('geometry reuse follows values, including in-place camera/contact mutations', () => {
  const cache = new DetectionProjectionCache();
  const frame = {
    viewProjectionMatrix: new Float64Array(16),
    cameraPosition: { x: 1, y: 2, z: 3 },
    width: 800,
    height: 600,
  };
  const object = { position: { x: 4, y: 5, z: 6 }, type: 'AIR' };
  let calls = 0;
  const project = (_, __, row) => {
    row.visible = ++calls % 2 === 1;
  };
  const read = () => {
    cache.begin(frame, 3);
    return cache.get(object, frame, project);
  };
  read();
  read();
  assert.equal(calls, 1);
  object.presentationAlpha = 0.35;
  object.metric = 'new';
  read();
  assert.equal(calls, 1, 'styling remains independent');
  for (const change of [
    () => object.position.x++,
    () => (object.skipLabel = true),
    () => (object.type = 'VEH'),
    () => (object.tier = 'transit_bus'),
    () => (object.bracketHalfWidth = 25),
    () => (object.bracketHalfHeight = 20),
    () => frame.viewProjectionMatrix[12]++,
    () => frame.cameraPosition.y++,
    () => frame.width++,
    () => frame.height++,
  ]) {
    const before = calls;
    change();
    read();
    assert.equal(calls, before + 1);
    read();
    assert.equal(calls, before + 1);
  }
  cache.begin(frame, 2);
  cache.get(object, frame, project);
  assert.equal(calls, 12, 'density changes bracket geometry');
  cache.clear();
  read();
  assert.equal(calls, 13);
});

test('contacts with the same identity retain independent geometry; culled results are cached too', () => {
  const c = new DetectionProjectionCache();
  const f = {
    viewProjectionMatrix: new Float64Array(16),
    cameraPosition: { x: 0, y: 0, z: 0 },
    width: 1,
    height: 1,
  };
  c.begin(f, 3);
  let calls = 0;
  const project = (_, __, row) => {
    calls++;
    row.visible = false;
  };
  const a = { id: 'same', position: { x: 1, y: 2, z: 3 } },
    b = { ...a };
  assert.equal(c.get(a, f, project).visible, false);
  c.get(a, f, project);
  c.get(b, f, project);
  assert.equal(calls, 2);
});
