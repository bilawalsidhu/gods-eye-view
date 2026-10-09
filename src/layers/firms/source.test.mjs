import test from 'node:test';
import assert from 'node:assert/strict';
import { createFirmsSource } from './source.js';

test('a malformed successful response is never accepted as an empty fire snapshot', async () => {
  for (const payload of [{}, { fires: null }, { fires: {} }]) {
    const source = createFirmsSource({
      fetchImpl: async () => ({ ok: true, json: async () => payload }),
    });
    await assert.rejects(source.getSnapshot(), /Malformed fire snapshot/);
  }
});
test('missing optional key is a normal state; other HTTP failures remain errors', async () => {
  const keyless = createFirmsSource({
    fetchImpl: async () => ({
      ok: true,
      status: 200,
      json: async () => ({ keyRequired: true }),
    }),
  });
  assert.deepEqual(await keyless.getSnapshot(), { keyRequired: true });

  // Continue to recognize the old response while cached deployments roll
  // forward, without masking unrelated 5xx or authorization failures.
  const legacyKeyless = createFirmsSource({
    fetchImpl: async () => ({
      ok: false,
      status: 503,
      json: async () => ({ error: 'no_key' }),
    }),
  });
  assert.deepEqual(await legacyKeyless.getSnapshot(), { keyRequired: true });

  for (const status of [401, 403, 429, 500, 503]) {
    const source = createFirmsSource({
      fetchImpl: async () => ({
        ok: false,
        status,
        json: async () => ({ error: 'upstream_failure' }),
      }),
    });
    await assert.rejects(
      source.getSnapshot(),
      new RegExp(`FIRMS HTTP ${status}`),
    );
  }
});
test('response-body completion honors cancellation without replacing records', async () => {
  const abort = new AbortController();
  const source = createFirmsSource({
    fetchImpl: async () => ({
      ok: true,
      json: async () => {
        abort.abort();
        return { fires: [] };
      },
    }),
  });
  await assert.rejects(source.getSnapshot({ signal: abort.signal }), {
    name: 'AbortError',
  });
});
