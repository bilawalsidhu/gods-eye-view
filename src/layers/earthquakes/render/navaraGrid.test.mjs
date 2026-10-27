import test from 'node:test';
import assert from 'node:assert/strict';
import { createDiscGrid, GRID_COLS, GRID_ROWS } from './navaraGrid.js';

test('screen grid retains every overlapping feature in source order without a cell cap', () => {
  const grid = createDiscGrid(513);
  for (let i = 0; i < 513; i++) grid.bounds.set([-1, -1, 1, 1], i * 4);
  assert.equal(grid.pack(), 513 * GRID_COLS * GRID_ROWS);
  for (let i = 0; i < grid.counts.length; i++) {
    assert.equal(grid.counts[i], 513);
    assert.deepEqual(
      [...grid.indices.subarray(grid.offsets[i], grid.offsets[i] + 513)],
      Array.from({ length: 513 }, (_, i) => i),
    );
  }
  grid.bounds.fill(2);
  assert.equal(grid.pack(), 0);
  assert.equal(
    grid.counts.reduce((a, b) => a + b, 0),
    0,
  );
});

test('screen grid excludes off-screen/behind volumes and conservatively includes border cells', () => {
  const grid = createDiscGrid(4);
  grid.bounds.set([
    -1, -1, -0.9, -0.9, 2, 2, 2, 2, -2, -2, -1.1, -1.1, 0, 0, 1, 1,
  ]);
  grid.pack();
  assert.equal(grid.counts[0], 1);
  assert.equal(grid.indices[grid.offsets[0]], 0);
  const last = grid.counts.length - 1;
  assert.equal(grid.counts[last], 1);
  assert.equal(grid.indices[grid.offsets[last]], 3);
  for (let i = 0; i < grid.counts.length; i++)
    for (let k = 0; k < grid.counts[i]; k++)
      assert.ok([0, 3].includes(grid.indices[grid.offsets[i] + k]));
});
