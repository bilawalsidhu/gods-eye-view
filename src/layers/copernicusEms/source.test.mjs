import assert from 'node:assert/strict';
import test from 'node:test';
import { createCopernicusEmsSource } from './source.js';

const jsonResponse = (payload, init = {}) =>
  new Response(JSON.stringify(payload), {
    status: init.status ?? 200,
    headers: { 'Content-Type': 'application/json' },
  });

test('the source asks the LOCAL proxy, never an upstream URL', async () => {
  const calls = [];
  const source = createCopernicusEmsSource({
    fetchImpl: async (url) => {
      calls.push(String(url));
      return jsonResponse({ activations: [], total: 0 });
    },
  });
  await source.getSnapshot();
  assert.equal(calls.length, 1);
  assert.equal(calls[0], '/api/copernicus-ems/active');
  assert.ok(!calls[0].includes('copernicus.eu'));
});

test('a malformed payload is refused rather than shown as an empty layer', async () => {
  const source = createCopernicusEmsSource({
    fetchImpl: async () => jsonResponse({ nope: true }),
  });
  await assert.rejects(source.getSnapshot(), /Malformed activation response/);
});

test('an upstream failure is surfaced with its status', async () => {
  const source = createCopernicusEmsSource({
    fetchImpl: async () => jsonResponse({ error: 'x' }, { status: 502 }),
  });
  await assert.rejects(source.getSnapshot(), /Copernicus EMS HTTP 502/);
});
