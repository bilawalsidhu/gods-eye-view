import assert from 'node:assert/strict';
import test from 'node:test';
import { resampleMaskedGrid } from './ifsOcean.js';

const MISSING = 9999;

/** A 4 × 3 source grid, north to south from 90°N, starting at `lo1`. */
function sourceField(values, { lo1 = 0, di = 90, dj = 90 } = {}) {
  return { values, missingValue: MISSING, ni: 4, nj: 3, lo1, la1: 90, di, dj };
}

test('a coastal point blends only its sea corners, so land never drags it toward the fill value', () => {
  // Row 1 (the equator): 0°E sea at 2 m, 90°E land, 180° sea at 4 m.
  const field = sourceField([1, 1, 1, 1, 2, MISSING, 4, MISSING, 1, 1, 1, 1]);
  const grid = resampleMaskedGrid(field, 45);
  const at = (lat, lon) => grid.values[((90 - lat) / 45) * grid.nx + lon / 45];
  assert.equal(at(0, 0), 2);
  // Halfway between 2 m sea and land: the land corner drops out of the blend.
  assert.equal(at(0, 45), 2);
  assert.ok(Number.isNaN(at(0, 90)), 'a point on land has no value');
  assert.equal(at(0, 180), 4);
  assert.equal(grid.max, 4);
  assert.equal(grid.valid, grid.nx * grid.ny - 2);
});

test('the source seam is crossed: a grid that starts at 180° lands where the longitudes say', () => {
  // Column 0 is 180°, column 2 is 0°: only 0°E holds 5 m.
  const field = sourceField([1, 1, 1, 1, 1, 1, 5, 1, 1, 1, 1, 1], { lo1: 180 });
  const grid = resampleMaskedGrid(field, 90);
  assert.equal(grid.lo1, 0);
  assert.equal(grid.values[1 * grid.nx + 0], 5, '0°E on the equator');
  assert.equal(grid.values[1 * grid.nx + 2], 1, '180° on the equator');
});

test('fill values, values under the floor and non-numbers are all missing, and a fully missing cell is NaN', () => {
  const field = sourceField([
    MISSING,
    -1,
    NaN,
    MISSING,
    MISSING,
    -1,
    NaN,
    MISSING,
    3,
    3,
    3,
    3,
  ]);
  const grid = resampleMaskedGrid(field, 90, { min: 0 });
  assert.ok(grid.values.slice(0, 2 * grid.nx).every(Number.isNaN));
  assert.ok(grid.values.slice(2 * grid.nx).every((v) => v === 3));
});

test('bad geometry is refused rather than resampled', () => {
  const ok = sourceField(new Array(12).fill(1));
  for (const bad of [
    { ...ok, values: new Array(11).fill(1) },
    { ...ok, ni: 0 },
    { ...ok, di: 0 },
    { ...ok, lo1: NaN },
    { ...ok, missingValue: Infinity },
  ])
    assert.throws(() => resampleMaskedGrid(bad, 90), /geometry/);
  assert.throws(() => resampleMaskedGrid(ok, 0.1), /geometry/);
  assert.equal(resampleMaskedGrid({ ...ok, missingValue: null }, 90).valid, 12);
});

test('signed components are kept by default, and the maximum is the largest value, not zero', () => {
  const grid = resampleMaskedGrid(
    sourceField([-1, -1, -1, -1, -2, MISSING, -0.5, -2, -1, -1, -1, -1]),
    90,
  );
  assert.equal(grid.values[1 * grid.nx + 0], -2);
  assert.equal(grid.values[1 * grid.nx + 2], -0.5);
  assert.ok(Number.isNaN(grid.values[1 * grid.nx + 1]));
  assert.equal(grid.max, -0.5);
  assert.equal(grid.valid, grid.nx * grid.ny - 1);
});
