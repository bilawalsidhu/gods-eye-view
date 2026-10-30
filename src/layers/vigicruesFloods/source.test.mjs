import assert from 'node:assert/strict';
import test from 'node:test';
import { createVigicruesSource } from './source.js';

const jsonResponse = (payload, init = {}) =>
  new Response(JSON.stringify(payload), {
    status: init.status ?? 200,
    headers: { 'Content-Type': 'application/json' },
  });

test('the source asks the LOCAL proxy, never an upstream URL', async () => {
  const calls = [];
  const source = createVigicruesSource({
    fetchImpl: async (url) => {
      calls.push(String(url));
      if (String(url).includes('zones'))
        return jsonResponse({ zones: [], bbox: null });
      return jsonResponse({ stations: [], total: 0, observedAt: null });
    },
  });
  await source.getSnapshot();
  assert.equal(calls.length, 2);
  for (const call of calls) {
    assert.ok(call.startsWith('/api/vigicrues/'), call);
    assert.ok(!call.includes('vigicrues.gouv.fr'));
  }
});

test('a malformed station payload is refused', async () => {
  const source = createVigicruesSource({
    fetchImpl: async (url) =>
      String(url).includes('zones')
        ? jsonResponse({ zones: [], bbox: null })
        : jsonResponse({ nope: true }),
  });
  await assert.rejects(source.getSnapshot(), /Malformed station response/);
});

test('a malformed zone payload is refused', async () => {
  const source = createVigicruesSource({
    fetchImpl: async (url) =>
      String(url).includes('zones')
        ? jsonResponse({ nope: true })
        : jsonResponse({ stations: [], total: 0, observedAt: null }),
  });
  await assert.rejects(source.getSnapshot(), /Malformed warning-zone response/);
});

test('an upstream failure is surfaced with its status', async () => {
  const source = createVigicruesSource({
    fetchImpl: async () => jsonResponse({ error: 'x' }, { status: 502 }),
  });
  await assert.rejects(source.getSnapshot(), /Vigicrues HTTP 502/);
});
