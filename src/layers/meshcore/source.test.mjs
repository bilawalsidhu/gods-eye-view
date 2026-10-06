import test from 'node:test';
import assert from 'node:assert/strict';
import { createMeshcoreSource } from './source.js';

test('a malformed successful response is never accepted as an empty node snapshot', async () => {
  for (const payload of [{}, { nodes: null }, { nodes: {} }]) {
    const source = createMeshcoreSource({
      fetchImpl: async () => ({ ok: true, json: async () => payload }),
    });
    await assert.rejects(source.getSnapshot(), /Malformed MeshCore snapshot/);
  }
});

test('a non-OK upstream status surfaces as an HTTP error, not a parse error', async () => {
  const source = createMeshcoreSource({
    fetchImpl: async () => ({
      ok: false,
      status: 502,
      json: async () => {
        throw new SyntaxError('not json');
      },
    }),
  });
  await assert.rejects(source.getSnapshot(), /MeshCore HTTP 502/);
});

test('response-body completion honors cancellation without replacing records', async () => {
  const abort = new AbortController();
  const source = createMeshcoreSource({
    fetchImpl: async () => ({
      ok: true,
      json: async () => {
        abort.abort();
        return { nodes: [] };
      },
    }),
  });
  await assert.rejects(source.getSnapshot({ signal: abort.signal }), {
    name: 'AbortError',
  });
});

test('a valid snapshot is returned as-is', async () => {
  const payload = {
    fetchedAt: 1,
    stale: false,
    count: 1,
    nodes: [{ id: 'a' }],
  };
  const source = createMeshcoreSource({
    fetchImpl: async () => ({ ok: true, json: async () => payload }),
  });
  assert.deepEqual(await source.getSnapshot(), payload);
});
