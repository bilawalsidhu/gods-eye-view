import assert from 'node:assert/strict';
import test from 'node:test';
import { createInstallationSource } from './source.js';

const box = { south: 30.1, west: -97.9, north: 30.3, east: -97.6 };
test('mapped-site sources validate viewport bounds and preserve the exact retry key', async () => {
  const calls = [];
  const source = createInstallationSource({
    fetchImpl: async (url) => {
      calls.push(new URL(url, 'https://example.test'));
      return new Response(JSON.stringify({ elements: [], status: 'stale' }));
    },
  });
  for (const invalid of [
    null,
    { ...box, east: Infinity },
    { ...box, north: 90 },
    { ...box, south: 31 },
  ])
    await assert.rejects(
      source.getMappedSites(invalid),
      /bounded installation viewport/,
    );
  assert.equal(calls.length, 0);
  const payload = await source.getMappedSites(box, { exact: true });
  assert.equal(payload.status, 'stale');
  assert.equal(calls[0].pathname, '/api/military-installations');
  assert.equal(calls[0].searchParams.get('exact'), '1');
  assert.equal(calls[0].searchParams.get('south'), '30.10000');
});
test('malformed installation and place snapshots are never accepted as empty success', async () => {
  const source = createInstallationSource({
    fetchImpl: async () => new Response('{}'),
  });
  await assert.rejects(
    source.getMappedSites(box),
    /Malformed installation snapshot/,
  );
  await assert.rejects(
    source.searchNearby({ latitude: 30.2, longitude: -97.7, radiusM: 1000 }),
    /Malformed nearby-place snapshot/,
  );
});
test('installation response parsing respects cancellation before any follow-on search', async () => {
  const controller = new AbortController();
  const source = createInstallationSource({
    fetchImpl: async () => ({
      ok: true,
      json: async () => {
        controller.abort();
        return { elements: [] };
      },
    }),
  });
  await assert.rejects(
    source.getMappedSites(box, { signal: controller.signal }),
    { name: 'AbortError' },
  );
});

test('mapped-site sources normalize records and derive saturation from legacy cache metadata', async () => {
  const source = createInstallationSource({
    fetchImpl: async () =>
      Response.json({
        elements: [
          {
            type: 'node',
            id: 1,
            lat: 30.2,
            lon: -97.7,
            tags: { military: 'airfield', name: 'Fixture Field' },
          },
        ],
        elementCap: 1,
        status: 'stale',
        retrievedAt: '2026-01-01T00:00:00Z',
      }),
  });
  const payload = await source.getMappedSites(box);
  assert.equal(payload.records[0].name, 'Fixture Field');
  assert.equal(payload.records[0].latitude, 30.2);
  assert.equal(payload.records[0].retrievedAt, '2026-01-01T00:00:00Z');
  assert.equal(payload.saturated, true);
  assert.equal(payload.status, 'stale');
  assert.equal('elements' in payload, false);
});
