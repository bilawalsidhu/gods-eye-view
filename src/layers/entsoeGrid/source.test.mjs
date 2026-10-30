import assert from 'node:assert/strict';
import test from 'node:test';
import { createEntsoeSource } from './source.js';

const jsonResponse = (payload, init = {}) =>
  new Response(JSON.stringify(payload), {
    status: init.status ?? 200,
    headers: { 'Content-Type': 'application/json' },
  });

test('the source asks the LOCAL proxy, never an upstream URL', async () => {
  const calls = [];
  const source = createEntsoeSource({
    fetchImpl: async (url) => {
      calls.push(String(url));
      return jsonResponse({ points: [{ position: 1, value: 10 }], unit: 'MW' });
    },
  });
  await source.getSnapshot();
  assert.equal(calls.length, 1);
  assert.equal(calls[0], '/api/entsoe/load');
  assert.ok(!calls[0].includes('entsoe.eu'));
});

test('a missing token is surfaced as key-required, not as an empty snapshot', async () => {
  const source = createEntsoeSource({
    fetchImpl: async () =>
      jsonResponse({ error: 'no_key', keyRequired: true }, { status: 503 }),
  });
  await assert.rejects(source.getSnapshot(), (error) => {
    assert.equal(error.keyRequired, true);
    return /API token/.test(error.message);
  });
});

test('a rejected token is surfaced as key-rejected', async () => {
  const source = createEntsoeSource({
    fetchImpl: async () =>
      jsonResponse({ error: 'nope', keyRejected: true }, { status: 502 }),
  });
  await assert.rejects(source.getSnapshot(), (error) => {
    assert.equal(error.keyRejected, true);
    return true;
  });
});

test('a malformed payload is refused rather than shown as an empty layer', async () => {
  const source = createEntsoeSource({
    fetchImpl: async () => jsonResponse({ nope: true }),
  });
  await assert.rejects(source.getSnapshot(), /Malformed ENTSO-E response/);
});
