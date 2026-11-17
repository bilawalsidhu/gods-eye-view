import test from 'node:test';
import assert from 'node:assert/strict';
import { createWfigsPerimeterSource } from './source.js';
import { normalizeFirePerimeterSnapshot } from './records.js';
import { firePerimetersProxy } from '../../../server/providers/firePerimeters.js';

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
      return Response.json({
        rows: normalizeFirePerimeterSnapshot(validPayload),
      });
    },
  });
  const rows = await source.getSnapshot();
  assert.equal(rows.length, 1);
  assert.equal(rows[0].stableId, '2026-NMGNF-000123');
  assert.equal(requested, '/api/fire-perimeters');
});

test('a truncated response pages until the feed is complete', async () => {
  const pageRing = (id) => ({
    id,
    geometry: { type: 'Polygon', coordinates: [ring] },
    properties: { attr_UniqueFireIdentifier: `fire-${id}` },
  });
  const requests = [];
  let handler;
  const plugin = firePerimetersProxy({
    fetchImpl: async (url) => {
      requests.push(new URL(String(url)).searchParams.get('resultOffset'));
      const page = requests.length;
      return Response.json({
        features: [pageRing(page)],
        properties: { exceededTransferLimit: page < 3 },
      });
    },
  });
  plugin.configureServer({
    middlewares: {
      use: (_path, callback) => {
        handler = callback;
      },
    },
  });
  let payload;
  await handler(
    { url: '/', method: 'GET' },
    {
      writeHead(status) {
        assert.equal(status, 200);
      },
      end(body) {
        payload = JSON.parse(body);
      },
    },
  );
  const rows = payload.rows;
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
  for (const payload of [{}, { rows: null }, { rows: {} }]) {
    const source = createWfigsPerimeterSource({
      fetchImpl: async () => Response.json(payload),
    });
    await assert.rejects(source.getSnapshot(), /Malformed perimeter snapshot/);
  }
});

test('response-body completion honors cancellation without replacing records', async () => {
  const abort = new AbortController();
  const source = createWfigsPerimeterSource({
    fetchImpl: async () => ({
      ok: true,
      headers: new Headers(),
      text: async () => {
        abort.abort();
        return JSON.stringify({
          rows: normalizeFirePerimeterSnapshot(validPayload),
        });
      },
    }),
  });
  await assert.rejects(source.getSnapshot({ signal: abort.signal }), {
    name: 'AbortError',
  });
});

test('a failed refresh serves the last snapshot marked stale for a day, then refuses', async () => {
  let clock = 1_000_000_000;
  let up = true;
  const plugin = firePerimetersProxy({
    now: () => clock,
    fetchImpl: async () => {
      if (!up) throw new Error('WFIGS unreachable');
      return Response.json(validPayload);
    },
  });
  let handler;
  plugin.configureServer({
    middlewares: { use: (_path, callback) => (handler = callback) },
  });
  const ask = async () => {
    const reply = {};
    await handler(
      { url: '/', method: 'GET', socket: { remoteAddress: '127.0.0.1' } },
      {
        writeHead(status, headers) {
          reply.status = status;
          reply.staleHeader = headers?.['X-Data-Stale'] === 'true';
        },
        end(body) {
          reply.body = JSON.parse(body);
        },
      },
    );
    return reply;
  };
  const fresh = await ask();
  assert.equal(fresh.status, 200);
  assert.equal(fresh.body.stale, undefined);
  up = false;
  clock += 23 * 60 * 60 * 1000;
  const stale = await ask();
  assert.equal(stale.status, 200);
  assert.equal(stale.staleHeader, true);
  assert.equal(stale.body.stale, true);
  assert.equal(stale.body.fetchedAt, fresh.body.fetchedAt);
  clock += 2 * 60 * 60 * 1000;
  assert.equal((await ask()).status, 502, 'a day-old snapshot is not served');
});

test('the snapshot detail carries the proxy staleness and fetch time', async () => {
  const fetchedAt = Date.UTC(2026, 9, 25, 12);
  const source = createWfigsPerimeterSource({
    fetchImpl: async () => Response.json({ rows: [], stale: true, fetchedAt }),
  });
  assert.deepEqual(await source.getSnapshotDetail(), {
    rows: [],
    stale: true,
    fetchedAt,
  });
  assert.deepEqual(await source.getSnapshot(), []);
});

test('getSnapshot works when taken off its source object', async () => {
  const { getSnapshot } = createWfigsPerimeterSource({
    fetchImpl: async () => Response.json({ rows: [] }),
  });
  assert.deepEqual(await getSnapshot(), []);
});
