import test from 'node:test';
import assert from 'node:assert/strict';
import { createCloudsSource } from './source.js';

const response = (body, ok = true, status = 200) => ({
  ok,
  status,
  json: async () => body,
});

test('cloud source returns a manifest', async () => {
  const payload = { sources: [] };
  assert.deepEqual(
    await createCloudsSource({
      fetchImpl: async () => response(payload),
    }).getSnapshot(),
    payload,
  );
});

test('cloud source reports HTTP errors', async () => {
  await assert.rejects(
    createCloudsSource({
      fetchImpl: async () => response({}, false, 500),
    }).getSnapshot(),
    /Clouds HTTP 500/,
  );
});

test('cloud source rejects malformed JSON and manifests', async () => {
  await assert.rejects(
    createCloudsSource({
      fetchImpl: async () => ({
        ok: true,
        json: async () => {
          throw new Error();
        },
      }),
    }).getSnapshot(),
    /Malformed cloud manifest/,
  );
  await assert.rejects(
    createCloudsSource({ fetchImpl: async () => response({}) }).getSnapshot(),
    /Malformed cloud manifest/,
  );
});

test('cloud source checks an already aborted signal', async () => {
  const controller = new AbortController();
  controller.abort();
  let fetched = false;
  await assert.rejects(
    createCloudsSource({
      fetchImpl: async () => {
        fetched = true;
      },
    }).getSnapshot({ signal: controller.signal }),
  );
  assert.equal(fetched, false);
});
