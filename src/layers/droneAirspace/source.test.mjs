import test from 'node:test';
import assert from 'node:assert/strict';
import { createDroneAirspaceSource } from './source.js';
import { normalizeDroneAirspaceSnapshot } from './records.js';
import { droneAirspaceProxy } from '../../../server/providers/droneAirspace.js';

const ring = [
  [-77.04, 38.89],
  [-77.03, 38.89],
  [-77.03, 38.9],
  [-77.04, 38.89],
];
const validPayload = {
  features: [
    {
      id: 310,
      geometry: { type: 'Polygon', coordinates: [ring] },
      properties: {
        NAME: 'P-56',
        TYPE_CODE: 'P',
        OBJECTID: 310,
      },
    },
  ],
};

test('a successful response yields normalized zone rows', async () => {
  let requested;
  const source = createDroneAirspaceSource({
    fetchImpl: async (url) => {
      requested = String(url);
      return Response.json({
        rows: normalizeDroneAirspaceSnapshot(validPayload),
      });
    },
  });
  const rows = await source.getSnapshot();
  assert.equal(rows.length, 1);
  assert.equal(rows[0].stableId, '310');
  assert.equal(requested, '/api/drone-airspace');
});

test('a truncated response pages until the feed is complete', async () => {
  const pageRing = (id) => ({
    id,
    geometry: { type: 'Polygon', coordinates: [ring] },
    properties: { NAME: `P-${id}`, TYPE_CODE: 'P', OBJECTID: id },
  });
  const requests = [];
  let handler;
  const plugin = droneAirspaceProxy({
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
    ['1', '2', '3'],
  );
  assert.deepEqual(requests, [null, '1', '2']);
});

test('an upstream failure surfaces its HTTP status', async () => {
  const source = createDroneAirspaceSource({
    fetchImpl: async () => ({ ok: false, status: 503 }),
  });
  await assert.rejects(source.getSnapshot(), /FAA SUA HTTP 503/);
});

test('a malformed successful response is never accepted as an empty snapshot', async () => {
  for (const payload of [{}, { rows: null }, { rows: {} }]) {
    const source = createDroneAirspaceSource({
      fetchImpl: async () => Response.json(payload),
    });
    await assert.rejects(
      source.getSnapshot(),
      /Malformed drone airspace snapshot/,
    );
  }
});
