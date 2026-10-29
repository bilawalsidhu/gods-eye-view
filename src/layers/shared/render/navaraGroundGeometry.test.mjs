import test from 'node:test';
import assert from 'node:assert/strict';
import { PerspectiveCamera } from 'three';
import { groundClipBounds } from './navaraGroundGeometry.js';

test('ground volumes wholly outside a screen edge do not enter the candidate grid', () => {
  const camera = new PerspectiveCamera(60, 1.6, 1, 1000);
  const frame = { radius: 1, floor: -1, ceiling: 1 };
  for (const [x, y] of [
    [100, 0],
    [-100, 0],
    [0, 100],
    [0, -100],
  ]) {
    const view = new Float64Array([x, y, -10, 1, 0, 0, 0, 1, 0, 0, 0, 1]);
    assert.deepEqual(
      [
        ...groundClipBounds(
          frame,
          view,
          camera.projectionMatrix,
          new Float64Array(4),
        ),
      ],
      [2, 2, 2, 2],
      `offscreen volume at ${x}, ${y}`,
    );
  }
});
