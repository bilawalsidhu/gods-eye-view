import assert from 'node:assert/strict';
import test from 'node:test';
import { ENTSOE_ZONE_PINS } from './model.js';
import { createEntsoeSource } from './source.js';

const jsonResponse = (payload, init = {}) =>
  new Response(JSON.stringify(payload), {
    status: init.status ?? 200,
    headers: { 'Content-Type': 'application/json' },
  });

test('the source asks the LOCAL proxy, once per zone, never an upstream URL', async () => {
  const calls = [];
  const source = createEntsoeSource({
    fetchImpl: async (url) => {
      calls.push(String(url));
      return jsonResponse({ points: [{ position: 1, value: 10 }], unit: 'MW' });
    },
  });
  const snapshot = await source.getSnapshot();
  assert.equal(calls.length, ENTSOE_ZONE_PINS.length);
  assert.ok(calls.every((url) => url.startsWith('/api/entsoe/load?zone=')));
  assert.ok(calls.includes('/api/entsoe/load?zone=FR'));
  assert.ok(!calls.some((url) => url.includes('entsoe.eu')));
  assert.equal(snapshot.zones.length, ENTSOE_ZONE_PINS.length);
});

test('one failing zone does not blank the others', async () => {
  const source = createEntsoeSource({
    fetchImpl: async (url) =>
      String(url).endsWith('zone=DE')
        ? jsonResponse({ error: 'upstream' }, { status: 502 })
        : jsonResponse({ points: [{ position: 1, value: 10 }], unit: 'MW' }),
  });
  const snapshot = await source.getSnapshot();
  assert.equal(snapshot.zones.length, ENTSOE_ZONE_PINS.length - 1);
  assert.ok(!snapshot.zones.some((zone) => zone.code === 'DE'));
});

test('every zone failing is an error, not an empty map', async () => {
  const source = createEntsoeSource({
    fetchImpl: async () => jsonResponse({ error: 'upstream' }, { status: 502 }),
  });
  await assert.rejects(source.getSnapshot(), /HTTP 502/);
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
