import test from 'node:test';
import assert from 'node:assert/strict';
import { enhanceSnapshotPixels } from './cameraSnapshotEnhancement.js';
test('local filter changes a copy, preserves original/alpha and reports completion', async () => {
  const source = new Uint8ClampedArray(4 * 50 * 4).fill(100),
    before = source.slice(),
    progress = [];
  const result = await enhanceSnapshotPixels(source, 4, 50, {
    progress: (v) => progress.push(v),
    yieldTask: async () => {},
  });
  assert.deepEqual(source, before);
  assert.notEqual(result[20], source[20]);
  assert.equal(result[23], 100);
  assert.equal(progress.at(-1), 100);
  assert.ok(progress.every((v, i) => i === 0 || v >= progress[i - 1]));
});
test('cancel during a yielded chunk discards pending result and leaves source untouched', async () => {
  const source = new Uint8ClampedArray(4 * 80 * 4).fill(100),
    before = source.slice(),
    controller = new AbortController();
  let yields = 0;
  await assert.rejects(
    enhanceSnapshotPixels(source, 4, 80, {
      signal: controller.signal,
      yieldTask: async () => {
        if (++yields === 2) controller.abort();
      },
    }),
    { name: 'AbortError' },
  );
  assert.deepEqual(source, before);
  assert.equal(yields, 2);
});
test('already canceled operation does no processing', async () => {
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(
    enhanceSnapshotPixels(new Uint8ClampedArray(16), 2, 2, {
      signal: controller.signal,
    }),
    { name: 'AbortError' },
  );
});
