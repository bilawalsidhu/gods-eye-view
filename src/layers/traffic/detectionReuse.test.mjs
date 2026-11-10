import test from 'node:test';
import assert from 'node:assert/strict';
import { createControls } from './controls.js';

test('traffic detection reuses records while following positions, recycled identities and live tiers', () => {
  const point = { position: { x: 1, y: 2, z: 3 } };
  const dot = { id: 1, point, bucket: 'jam' };
  const state = {
    _enabled: true,
    _showDots: true,
    _dots: [dot],
    _liveMode: true,
  };
  const { methods } = createControls({
    state,
    services: {},
    parts: {},
    source: {},
  });
  const first = methods.getDetectableObjects()[0];
  assert.equal(first.id, 'VEH-0001');
  assert.ok(first.tier);
  assert.equal(methods.getDetectableObjects()[0], first);
  point.position.x = 42;
  assert.equal(methods.getDetectableObjects()[0].position.x, 42);
  point.position = { x: 4, y: 5, z: 6 };
  dot.id = 99;
  state._liveMode = false;
  const recycled = methods.getDetectableObjects()[0];
  assert.equal(recycled, first);
  assert.equal(recycled.id, 'VEH-0099');
  assert.equal(recycled.position, point.position);
  assert.equal(recycled.tier, undefined, 'no stale live color in simulation');
  state._showDots = false;
  assert.deepEqual(methods.getDetectableObjects(), []);
});
