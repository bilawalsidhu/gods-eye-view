import assert from 'node:assert/strict';
import test from 'node:test';
import { createDriveBcSource } from './source.js';

test('DriveBC source requests only active BC Open511 events from the fixed endpoint', async () => {
  let requested;
  const source = createDriveBcSource({
    fetchImpl: async (url, options) => {
      requested = { url, options };
      return new Response(
        JSON.stringify({ events: [{ id: 'drivebc.ca/1', status: 'ACTIVE', geography: { type: 'Point', coordinates: [-123, 49] } }] }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    },
  });
  const result = await source.getSnapshot();
  const url = new URL(requested.url);
  assert.equal(url.origin, 'https://api.open511.gov.bc.ca');
  assert.equal(url.pathname, '/events');
  assert.equal(url.searchParams.get('format'), 'json');
  assert.equal(url.searchParams.get('status'), 'ACTIVE');
  assert.equal(url.searchParams.get('limit'), '500');
  assert.equal(requested.options.redirect, 'error');
  assert.equal(result.events[0].id, 'drivebc.ca/1');
  assert.equal(result.partial, false);
});

test('DriveBC source caches briefly and labels recent fallback snapshots stale', async () => {
  let now = 1_000;
  let calls = 0;
  const source = createDriveBcSource({
    now: () => now,
    fetchImpl: async () => {
      calls += 1;
      if (calls > 1) throw new Error('offline');
      return new Response(JSON.stringify({ events: [
        { id: 'drivebc.ca/1', status: 'ACTIVE', geography: { type: 'Point', coordinates: [-123, 49] } },
      ] }), { status: 200 });
    },
  });
  assert.equal((await source.getSnapshot()).stale, false);
  now += 30_000;
  assert.equal((await source.getSnapshot()).stale, false);
  assert.equal(calls, 1);
  now += 40_000;
  assert.equal((await source.getSnapshot()).stale, true);
  assert.equal(calls, 2);
});

test('DriveBC source refuses malformed responses and exposes only sanitized errors', async () => {
  const source = createDriveBcSource({
    fetchImpl: async () => new Response(JSON.stringify({ events: 'bad' }), { status: 200 }),
  });
  await assert.rejects(source.getSnapshot(), /Malformed DriveBC/);
});

test('DriveBC source marks the capped active-event page as partial', async () => {
  const source = createDriveBcSource({
    fetchImpl: async () => new Response(
      JSON.stringify({ events: Array.from({ length: 500 }, (_, i) => ({ id: String(i) })) }),
      { status: 200 },
    ),
  });
  assert.equal((await source.getSnapshot()).partial, true);
});
