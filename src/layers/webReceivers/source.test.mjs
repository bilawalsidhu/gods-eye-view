import test from 'node:test';
import assert from 'node:assert/strict';
import { createWebReceiversSource } from './source.js';

test('the source reads the same-origin catalog route and nothing else', async () => {
  const calls = [];
  const body = { receivers: [], updatedAt: '2026-09-23T10:00:00.000Z' };
  const source = createWebReceiversSource({
    fetchImpl: async (path, options) => {
      calls.push({ path, options });
      return new Response(JSON.stringify(body));
    },
  });
  const controller = new AbortController();
  assert.deepEqual(
    await source.getCatalog({ signal: controller.signal }),
    body,
  );
  assert.deepEqual(
    calls.map((call) => call.path),
    ['/api/web-receivers/catalog'],
  );
  assert.equal(calls[0].options.signal, controller.signal);
  assert.equal(calls[0].options.headers.Accept, 'application/json');
});

test('a refused catalog carries the broker message and its degraded flag', async () => {
  const source = createWebReceiversSource({
    fetchImpl: async () =>
      new Response(
        JSON.stringify({ error: 'directory is down', degraded: true }),
        { status: 503 },
      ),
  });
  await assert.rejects(source.getCatalog(), (error) => {
    assert.equal(error.message, 'directory is down');
    assert.equal(error.degraded, true);
    return true;
  });
  const bare = createWebReceiversSource({
    fetchImpl: async () => new Response('', { status: 502 }),
  });
  await assert.rejects(bare.getCatalog(), /returned 502/);
});

test('cancellation is honoured before and after the body is read', async () => {
  const aborted = new AbortController();
  aborted.abort();
  const source = createWebReceiversSource({
    fetchImpl: async () => {
      throw new Error('must not fetch');
    },
  });
  await assert.rejects(source.getCatalog({ signal: aborted.signal }), {
    name: 'AbortError',
  });
  const controller = new AbortController();
  const late = createWebReceiversSource({
    fetchImpl: async () => ({
      ok: true,
      json: async () => {
        controller.abort();
        return { receivers: [] };
      },
    }),
  });
  await assert.rejects(late.getCatalog({ signal: controller.signal }), {
    name: 'AbortError',
  });
});
