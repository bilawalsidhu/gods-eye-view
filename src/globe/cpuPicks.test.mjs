import test from 'node:test';
import assert from 'node:assert/strict';
import * as geo from '../geo/index.js';
import { createCpuPicker } from './cpuPicks.js';

// One sprite 10 km from the camera, drawn at window (100, 100); a click
// `offset` px to its right.
function pickAt(offset, scaleByDistance) {
  const position = geo.cartesian3.fromDegrees(0, 0, 0);
  const camera = {
    livePosition: geo.cartesian3.fromDegrees(0, 0, 10_000),
  };
  const drill = createCpuPicker({
    projector: {
      worldToWindow: (p, result = geo.cartesian2.create()) =>
        Object.assign(result, { x: 100, y: 100 }),
      horizonVisible: () => true,
    },
    camera,
    movers: () => [
      {
        options: {
          id: 'set',
          kind: 'sprite',
          pickable: true,
          sprite: { sizePx: 40, scaleByDistance },
        },
        store: {
          count: 1,
          positions: [position.x, position.y, position.z],
          shows: [1],
          scales: [1],
          pickIds: ['a'],
        },
      },
    ],
    lines: () => [],
  });
  return drill({ x: 100 + offset, y: 100 }).length;
}

test('the CPU pick radius follows scaleByDistance', () => {
  // 40 px sprite: picked within 20 + 3 px.
  assert.equal(pickAt(22), 1);
  // Shrunk to a quarter at 10 km (near 1 km ×1, far 10 km ×0.25): 5 + 3 px.
  const shrink = [1_000, 1, 10_000, 0.25];
  assert.equal(pickAt(22, shrink), 0);
  assert.equal(pickAt(7, shrink), 1);
  // Halfway between near and far: linear, as the Navara shader draws it.
  const half = [0, 1, 20_000, 0.5];
  assert.equal(pickAt(17, half), 1, '15 + 3 px');
  assert.equal(pickAt(19, half), 0);
});
