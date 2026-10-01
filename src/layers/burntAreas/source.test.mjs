import assert from 'node:assert/strict';
import test from 'node:test';
import { createEffisBurntAreasSource } from './source.js';

test('T2: getSnapshot fetches, validates, and returns normalized rows', async () => {
  const source = createEffisBurntAreasSource({
    fetchImpl: async () => ({
      ok: true,
      json: async () => ({
        areas: [
          {
            id: 'ba-1',
            lon: 10,
            lat: 45,
            polygon: [
              [10, 45],
              [10.1, 45],
              [10.1, 45.1],
              [10, 45],
            ],
          },
        ],
      }),
    }),
  });
  const rows = await source.getSnapshot({});
  assert.equal(rows.length, 1);
  assert.equal(rows[0].stableId, 'ba-1');
});

test('T2: getSnapshot throws on a non-OK response', async () => {
  const source = createEffisBurntAreasSource({
    fetchImpl: async () => ({ ok: false, status: 503 }),
  });
  await assert.rejects(source.getSnapshot({}), /503/);
});

test('T2: getSnapshot honors abort signal', async () => {
  const abort = new AbortController();
  abort.abort();
  const source = createEffisBurntAreasSource({
    fetchImpl: async () => ({ ok: true, json: async () => ({ areas: [] }) }),
  });
  await assert.rejects(source.getSnapshot({ signal: abort.signal }), {
    name: 'AbortError',
  });
});
