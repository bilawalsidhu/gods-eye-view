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
  // Halfway between near and far: Cesium's NearFarScalar (squared distance,
  // eased by ^0.2): t = 0.25^0.2 = 0.758, scale 0.621, radius 12.4 + 3 px.
  const half = [0, 1, 20_000, 0.5];
  assert.equal(pickAt(15, half), 1, '12.4 + 3 px');
  assert.equal(pickAt(16, half), 0);
});

test('distanceScale is Cesium.NearFarScalar interpolation', async () => {
  const Cesium = await import('cesium');
  const { distanceScale } = await import('./cpuPicks.js');
  const scalar = [1000, 3.0, 8_000_000, 0.5];
  // Cesium's czm_nearFarScalar on the CPU (focusDeemphasis ports it too).
  const { nearFarScalarValueAtDistance } =
    await import('../data/focusDeemphasis.js');
  for (const distance of [0, 1000, 5000, 1e5, 2e6, 8e6, 2e7]) {
    const expected = nearFarScalarValueAtDistance(
      new Cesium.NearFarScalar(...scalar),
      distance,
    );
    assert.ok(
      Math.abs(distanceScale(scalar, distance) - expected) < 1e-12,
      `${distance} m`,
    );
  }
});

test('rectangular windows include nearby hits once and keep draw order and drill limit', () => {
  const picker = createCpuPicker({
    projector: {},
    camera: {},
    movers: () => [],
    lines: () => [],
    meshes: (at) =>
      Math.abs(at.x - 4) < 0.1 && Math.abs(at.y) < 0.1
        ? [
            {
              onTop: 0,
              order: 0,
              depth: 1,
              result: { id: 'behind', owner: 'b' },
            },
            { onTop: 1, order: 0, depth: 2, result: { id: 'top', owner: 'a' } },
          ]
        : [],
  });
  assert.deepEqual(picker({ x: 0, y: 0 }), []);
  assert.deepEqual(picker({ x: 0, y: 0 }, 1, { width: 9, height: 3 }), [
    { id: 'top', owner: 'a' },
  ]);
  assert.deepEqual(
    picker({ x: 0, y: 0 }, 8, { width: 9, height: 3 }).map((hit) => hit.id),
    ['top', 'behind'],
  );
  assert.deepEqual(picker({ x: 0, y: 0 }, 8, { width: 3, height: 9 }), []);
});
