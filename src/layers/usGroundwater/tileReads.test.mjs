import test from 'node:test';
import assert from 'node:assert/strict';
import { readTiles } from './tileReads.js';

test('tile reads are bounded to four, ordered, and stop queuing after failure', async () => {
  let active = 0,
    peak = 0;
  const result = await readTiles([0, 1, 2, 3, 4, 5, 6, 7], async (n) => {
    peak = Math.max(peak, ++active);
    await new Promise(setImmediate);
    active--;
    return n * 2;
  });
  assert.equal(peak, 4);
  assert.deepEqual(result, [0, 2, 4, 6, 8, 10, 12, 14]);
  let started = 0;
  await assert.rejects(
    readTiles(Array(40).fill(0), async () => {
      started++;
      throw new Error('aborted');
    }),
    /aborted/,
  );
  assert.equal(started, 4);
});
