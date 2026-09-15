import assert from 'node:assert/strict';
import test from 'node:test';
import { createGlmSource } from './source.js';

const payload = { flashes: [{ id: 'x' }] };
const response = (body, ok = true, status = 200) => ({
  ok,
  status,
  json: async () => body,
});

test('GLM source returns a valid payload', async () => {
  const source = createGlmSource({ fetchImpl: async () => response(payload) });
  assert.deepEqual(await source.getSnapshot(), payload);
});

test('GLM source reports HTTP errors', async () => {
  const source = createGlmSource({ fetchImpl: async () => response({}, false, 500) });
  await assert.rejects(source.getSnapshot(), /GLM HTTP 500/);
});

test('GLM source rejects malformed payloads', async () => {
  const source = createGlmSource({ fetchImpl: async () => response({}) });
  await assert.rejects(source.getSnapshot(), /Malformed lightning snapshot/);
});

test('GLM source checks an aborted signal before fetching', async () => {
  const controller = new AbortController();
  controller.abort();
  let called = false;
  const source = createGlmSource({ fetchImpl: async () => { called = true; } });
  await assert.rejects(source.getSnapshot({ signal: controller.signal }), { name: 'AbortError' });
  assert.equal(called, false);
});
