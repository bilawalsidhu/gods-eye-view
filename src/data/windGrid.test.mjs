import test from 'node:test';
import assert from 'node:assert/strict';
import { resampleWindGrid } from '../../server/providers/wind/grid.js';

test('resamples and wraps a wind grid', () => {
  const r = resampleWindGrid({ ni: 4, nj: 3, lo1: 0, la1: 90, di: 90, dj: 90, u: [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11], v: new Array(12).fill(1), dx: 90, dy: 90 });
  assert.deepEqual([r.nx, r.ny], [4, 3]);
  assert.equal(r.u[0], 0); assert.equal(r.u[3], 3); assert.equal(r.u[4], 4);
});
