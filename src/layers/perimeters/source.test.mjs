import test from 'node:test';
import assert from 'node:assert/strict';
import { createWfigsPerimeterSource } from './source.js';

const ring = [
  [-108.1, 35.2],
  [-108.0, 35.2],
  [-108.0, 35.3],
  [-108.1, 35.2],
];
const validPayload = {
  features: [
    {
      id: 1,
      geometry: { type: 'Polygon', coordinates: [ring] },
      properties: { attr_UniqueFireIdentifier: '2026-NMGNF-000123' },
    },
  ],
};

test('a successful response yields normalized perimeter rows', async () => {
  let requested;
  const source = createWfigsPerimeterSource({
    fetchImpl: async (url) => {
      requested = String(url);
      return { ok: true, json: async () => validPayload };
    },
  });
  const rows = await source.getSnapshot();
  assert.equal(rows.length, 1);
  assert.equal(rows[0].stableId, '2026-NMGNF-000123');
  assert.match(requested, /f=geojson/);
});

test('a truncated response pages until the feed is complete', async () => {
  const pageRing = (id) => ({
    id,
    geometry: { type: 'Polygon', coordinates: [ring] },
    properties: { attr_UniqueFireIdentifier: `fire-${id}` },
  });
  const requests = [];
  const source = createWfigsPerimeterSource({
    fetchImpl: async (url) => {
      requests.push(new URL(String(url)).searchParams.get('resultOffset'));
      const page = requests.length;
      return {
        ok: true,
        json: async () =>
          page < 3
            ? {
                features: [pageRing(page)],
                properties: { exceededTransferLimit: true },
              }
            : { features: [pageRing(page)] },
      };
    },
  });
  const rows = await source.getSnapshot();
  assert.deepEqual(
    rows.map((row) => row.stableId),
    ['fire-1', 'fire-2', 'fire-3'],
  );
  assert.deepEqual(requests, [null, '1', '2']);
});

test('an upstream failure surfaces its HTTP status', async () => {
  const source = createWfigsPerimeterSource({
    fetchImpl: async () => ({ ok: false, status: 503 }),
  });
  await assert.rejects(source.getSnapshot(), /WFIGS HTTP 503/);
});

test('a malformed successful response is never accepted as an empty snapshot', async () => {
  for (const payload of [{}, { features: null }, { features: {} }]) {
    const source = createWfigsPerimeterSource({
      fetchImpl: async () => ({ ok: true, json: async () => payload }),
    });
    await assert.rejects(source.getSnapshot(), /Malformed perimeter snapshot/);
  }
});

test('response-body completion honors cancellation without replacing records', async () => {
  const abort = new AbortController();
  const source = createWfigsPerimeterSource({
    fetchImpl: async () => ({
      ok: true,
      json: async () => {
        abort.abort();
        return validPayload;
      },
    }),
  });
  await assert.rejects(source.getSnapshot({ signal: abort.signal }), {
    name: 'AbortError',
  });
});
