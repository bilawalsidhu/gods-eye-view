import test from 'node:test';
import assert from 'node:assert/strict';
import { decodeFieldGrid } from './fieldDecode.js';

const grid = { nx: 2, ny: 1 };
test('decodeFieldGrid splits exact component regions and rejects bad lengths or values', () => {
  const [u, v] = decodeFieldGrid(
    grid,
    new Uint8Array(Float32Array.from([1, 2, 3, 4]).buffer),
  );
  assert.deepEqual([...u], [1, 2]);
  assert.deepEqual([...v], [3, 4]);
  const [, , c] = decodeFieldGrid(
    grid,
    new Uint8Array(Float32Array.from([1, 2, 3, 4, 5, 6]).buffer),
    3,
  );
  assert.deepEqual([...c], [5, 6]);
  assert.throws(() => decodeFieldGrid(grid, new Uint8Array(12)), /Malformed/);
  assert.throws(
    () =>
      decodeFieldGrid(
        grid,
        new Uint8Array(Float32Array.from([1, NaN, 3, 4]).buffer),
      ),
    /Malformed/,
  );
  // A finite sentinel is a value, not a malformation.
  assert.doesNotThrow(() =>
    decodeFieldGrid(
      grid,
      new Uint8Array(Float32Array.from([-9999, -9999, 3, 4]).buffer),
    ),
  );
  // Unaligned views are copied, never reinterpreted at the wrong offset.
  const padded = new Uint8Array(17);
  padded.set(new Uint8Array(Float32Array.from([1, 2, 3, 4]).buffer), 1);
  assert.deepEqual([...decodeFieldGrid(grid, padded.subarray(1))[0]], [1, 2]);
});
