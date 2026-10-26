import test from 'node:test';
import assert from 'node:assert/strict';
import {
  GRAVITY_GRID,
  GRAVITY_NO_DATA,
  assertGravitySourceGrid,
  gravityCell,
  gravitySolutions,
  gravityValueCm,
  quantizeGravity,
  reduceGravityBlock,
} from '../../server/providers/gravity/grid.js';
import { convertGravityNetcdf } from '../../server/providers/gravity/convert.js';

const CELLS = GRAVITY_GRID.nx * GRAVITY_GRID.ny;

test('solutions are keyed by their first day, so overlapping windows stay distinct', () => {
  // October 2011 as CSR ships it: a calendar month and a mid-month window.
  const days = (iso) => (Date.parse(iso) - Date.UTC(2002, 0, 1)) / 86_400_000;
  const solutions = gravitySolutions([
    days('2011-10-01'),
    days('2011-11-01'),
    days('2011-10-16'),
    days('2011-11-16'),
  ]);
  assert.deepEqual(solutions, [
    { id: '2011-10-01', start: '2011-10-01', end: '2011-11-01' },
    { id: '2011-10-16', start: '2011-10-16', end: '2011-11-16' },
  ]);
  assert.throws(() => gravitySolutions([5, 1]), /Invalid/);
  assert.throws(() => gravitySolutions([10, 20, 5, 30]), /order/);
  assert.throws(() => gravitySolutions([]), /Invalid/);
});

test('values are stored in half centimetres and no-data survives the round trip', () => {
  assert.equal(quantizeGravity(12.3), 25);
  assert.equal(gravityValueCm(quantizeGravity(-1748.6)), -1748.5);
  assert.equal(quantizeGravity(NaN), GRAVITY_NO_DATA);
  assert.equal(gravityValueCm(GRAVITY_NO_DATA), null);
  assert.equal(quantizeGravity(1e9), 32767);
});

test('blocks average 4 x 4 cells, put north first and start the row at 180°W', () => {
  const cube = new Int16Array(CELLS).fill(GRAVITY_NO_DATA);
  // Southernmost 4 source rows, first 8 source columns (0-2°E): two output cells.
  const values = new Float32Array(4 * 8);
  for (let r = 0; r < 4; r++)
    for (let c = 0; c < 8; c++)
      values[r * 8 + c] = c < 4 ? 10 : r === 0 ? NaN : 3;
  reduceGravityBlock(cube, values, {
    time0: 0,
    times: 1,
    row0: 0,
    rows: 4,
    col0: 0,
    cols: 8,
  });
  const southRow = GRAVITY_GRID.ny - 1;
  // 0.5°E is output column 180; NaN cells are left out of the mean.
  assert.equal(gravityValueCm(cube[southRow * 360 + 180]), 10);
  assert.equal(gravityValueCm(cube[southRow * 360 + 181]), 3);
  assert.equal(cube[southRow * 360 + 179], GRAVITY_NO_DATA);
  assert.throws(
    () =>
      reduceGravityBlock(cube, new Float32Array(3 * 8), {
        time0: 0,
        times: 1,
        row0: 1,
        rows: 3,
        col0: 0,
        cols: 8,
      }),
    /aligned/,
  );
});

test('a position maps to the one-degree cell that holds it', () => {
  assert.deepEqual(gravityCell(68.2, -17.4), {
    row: 21,
    col: 162,
    lat: 68.5,
    lon: -17.5,
  });
  assert.equal(gravityCell(-90, 179.99).row, GRAVITY_GRID.ny - 1);
  assert.equal(gravityCell(10, 190).lon, -169.5, '190°E is 170°W');
  assert.equal(gravityCell(91, 0), null);
  assert.equal(gravityCell(null, 0), null);
});

test('the source grid is checked before anything is reduced', () => {
  const lat = Float32Array.from({ length: 720 }, (_, i) => -89.875 + i / 4);
  const lon = Float32Array.from({ length: 1440 }, (_, i) => 0.125 + i / 4);
  assert.doesNotThrow(() => assertGravitySourceGrid(lat, lon));
  assert.throws(
    () => assertGravitySourceGrid(lat.slice().reverse(), lon),
    /Unexpected/,
  );
  assert.throws(() => assertGravitySourceGrid(lat, lon.slice(1)), /Unexpected/);
});

test('conversion reads chunk-aligned tiles and fills every solution', async () => {
  const times = 3;
  const lat = Float32Array.from({ length: 720 }, (_, i) => -89.875 + i / 4);
  const lon = Float32Array.from({ length: 1440 }, (_, i) => 0.125 + i / 4);
  const reads = [];
  // Each source value is its solution number, so every output cell must be too.
  const field = {
    shape: [times, 720, 1440],
    metadata: { chunks: [2, 103, 206] },
    slice([[t0, t1], [r0, r1], [c0, c1]]) {
      reads.push([t0, t1, r0, r1, c0, c1]);
      const out = new Float32Array((t1 - t0) * (r1 - r0) * (c1 - c0));
      const plane = (r1 - r0) * (c1 - c0);
      for (let t = 0; t < t1 - t0; t++)
        out.fill(t0 + t, t * plane, (t + 1) * plane);
      return out;
    },
  };
  const datasets = {
    lwe_thickness: field,
    lat: { value: lat },
    lon: { value: lon },
    time_bounds: { value: [0, 30, 31, 60, 61, 91] },
  };
  let closed = false;
  const h5wasm = {
    File: class {
      get(name) {
        return datasets[name];
      }
      close() {
        closed = true;
      }
    },
  };
  const { solutions, cube } = await convertGravityNetcdf('x.nc', { h5wasm });
  assert.equal(solutions.length, times);
  assert.equal(cube.length, times * CELLS);
  for (let t = 0; t < times; t++)
    assert.ok(
      cube
        .subarray(t * CELLS, (t + 1) * CELLS)
        .every((v) => gravityValueCm(v) === t),
    );
  // Tiles of four chunks: 412 rows and 824 columns, never past the edge.
  assert.ok(
    reads.every(
      ([, , r0, r1, c0, c1]) =>
        r0 % 412 === 0 && c0 % 824 === 0 && r1 <= 720 && c1 <= 1440,
    ),
  );
  assert.equal(reads.length, 2 * 2 * 2);
  assert.ok(closed);
});
