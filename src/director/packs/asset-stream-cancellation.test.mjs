import test from 'node:test';
import assert from 'node:assert/strict';
import { createAssetDirectorySource } from './source.js';
test('cancellation during the terminating read cannot return a scene asset', async () => {
  for (const cancel of [true, false]) {
    const controller = new AbortController();
    let reads = 0,
      cancelled = 0,
      released = 0;
    const source = createAssetDirectorySource({
      baseUrl: 'https://fixture.example/assets/',
      fetchImpl: async () => ({
        ok: true,
        headers: new Headers({ 'content-type': 'application/octet-stream' }),
        body: {
          getReader() {
            return {
              async read() {
                reads++;
                if (reads === 1)
                  return { done: false, value: new Uint8Array([1, 2]) };
                if (cancel) controller.abort();
                return { done: true };
              },
              async cancel() {
                cancelled++;
              },
              releaseLock() {
                released++;
              },
            };
          },
        },
      }),
    });
    const pending = source({ path: 'scene.bin', signal: controller.signal });
    if (cancel) await assert.rejects(pending, { name: 'AbortError' });
    else assert.deepEqual([...(await pending).bytes], [1, 2]);
    assert.equal(cancelled, 1);
    assert.equal(released, 1);
  }
});

test('cancellation during reader cleanup cannot return a scene asset', async () => {
  const controller = new AbortController();
  const reason = new DOMException('scene changed', 'AbortError');
  let released = 0;
  const source = createAssetDirectorySource({
    baseUrl: 'https://fixture.example/assets/',
    fetchImpl: async () => ({
      ok: true,
      headers: new Headers(),
      body: {
        getReader() {
          let reads = 0;
          return {
            async read() {
              reads++;
              return reads === 1
                ? { done: false, value: new Uint8Array([1]) }
                : { done: true };
            },
            async cancel() {
              controller.abort(reason);
            },
            releaseLock() {
              released++;
            },
          };
        },
      },
    }),
  });
  await assert.rejects(
    source({ path: 'scene.bin', signal: controller.signal }),
    (error) => error === reason,
  );
  assert.equal(released, 1);
});
