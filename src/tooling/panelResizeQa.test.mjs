import assert from 'node:assert/strict';
import test from 'node:test';
import {
  driftedEdges,
  growthDelta,
  handlePoint,
  MIN_SIZE,
  pinnedEdges,
  STORAGE_KEY,
} from '../../scripts/qa-panel-resize.mjs';
import { RESIZE_DIRECTIONS } from '../ui/panelResize.js';

test('the harness targets the key and minimums the controls use', () => {
  assert.equal(STORAGE_KEY, 'godsEyeView.v8.panelPos.cctv-panel');
  assert.deepEqual(MIN_SIZE, { width: 300, height: 160 });
});

test('pinned edges are exactly the sides a direction does not name', () => {
  assert.deepEqual(pinnedEdges('n'), ['bottom', 'right', 'left']);
  assert.deepEqual(pinnedEdges('se'), ['top', 'left']);
  assert.deepEqual(pinnedEdges('nw'), ['bottom', 'right']);
  for (const dir of RESIZE_DIRECTIONS)
    assert.equal(pinnedEdges(dir).length, 4 - dir.length);
});

test('growth deltas push each named edge outward', () => {
  assert.deepEqual(growthDelta('n', 40), { dx: 0, dy: -40 });
  assert.deepEqual(growthDelta('e', 40), { dx: 40, dy: 0 });
  assert.deepEqual(growthDelta('sw', 40), { dx: -40, dy: 40 });
  assert.deepEqual(growthDelta('se', 40), { dx: 40, dy: 40 });
});

test('handle points land inside the strip or corner for every direction', () => {
  const rect = { left: 100, top: 200, width: 400, height: 300 };
  rect.right = rect.left + rect.width;
  rect.bottom = rect.top + rect.height;
  assert.deepEqual(handlePoint(rect, 'n'), { x: 300, y: 201 });
  assert.deepEqual(handlePoint(rect, 'w'), { x: 101, y: 350 });
  assert.deepEqual(handlePoint(rect, 'se'), { x: 496, y: 496 });
  assert.deepEqual(handlePoint(rect, 'nw'), { x: 104, y: 204 });
  for (const dir of RESIZE_DIRECTIONS) {
    const { x, y } = handlePoint(rect, dir);
    assert.ok(x >= rect.left && x <= rect.right, `${dir} x inside`);
    assert.ok(y >= rect.top && y <= rect.bottom, `${dir} y inside`);
  }
});

test('drift detection reports only pinned edges that moved', () => {
  const before = { left: 100, top: 100, width: 400, height: 300 };
  const grewEast = { left: 100, top: 100, width: 440, height: 300 };
  assert.deepEqual(driftedEdges(before, grewEast, 'e'), []);
  const slidWest = { left: 60, top: 100, width: 440, height: 300 };
  assert.deepEqual(driftedEdges(before, slidWest, 'e'), ['left']);
  assert.deepEqual(driftedEdges(before, slidWest, 'w'), []);
  const wobble = { left: 101, top: 100, width: 439, height: 300 };
  assert.deepEqual(driftedEdges(before, wobble, 'e'), []);
});
