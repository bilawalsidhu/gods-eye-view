import test from 'node:test';
import assert from 'node:assert/strict';
import { createBundledCableSource } from './bundledSource.js';

test('a failed bundled response releases its body', async () => {
  let released = 0;
  const source = createBundledCableSource({
    fetchImpl: async () => ({
      ok: false,
      status: 503,
      body: {
        cancel: async () => {
          released++;
        },
      },
    }),
  });
  await assert.rejects(source.fetch(), /HTTP 503/);
  assert.equal(released, 2);
});

test('cancellation during JSON parsing cannot return a late snapshot', async () => {
  const controller = new AbortController();
  const source = createBundledCableSource({
    fetchImpl: async () => ({
      ok: true,
      async json() {
        controller.abort();
        return { type: 'FeatureCollection', features: [] };
      },
    }),
  });
  await assert.rejects(source.fetch(controller.signal), { name: 'AbortError' });
});
