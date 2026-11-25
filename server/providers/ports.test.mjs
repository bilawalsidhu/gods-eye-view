import test from 'node:test';
import assert from 'node:assert/strict';
import { portsProxy, wpiPageUrl } from './ports.js';

const NOW = 1_800_000_000_000;
const PORT = (index) => ({
  type: 'Feature',
  geometry: { type: 'Point', coordinates: [-3, 51] },
  properties: {
    objectid: index,
    wpinumber: index,
    main_port_name: `Port ${index}`,
    wpi_cc: 'GB',
    fac_container: index % 2 ? 'Yes' : null,
  },
});

function makeHandler(options) {
  let handler = null;
  portsProxy(options).configureServer({
    middlewares: {
      use(path, value) {
        assert.equal(path, '/api/ports');
        handler = value;
      },
    },
  });
  return handler;
}

function call(handler, { method = 'GET', url = '/', peer = '127.0.0.8' } = {}) {
  return new Promise((resolve, reject) => {
    const result = { status: null, headers: null, raw: null, json: null };
    const res = {
      writeHead(status, headers) {
        result.status = status;
        result.headers = headers;
      },
      end(text) {
        result.raw = text;
        result.json = text ? JSON.parse(text) : null;
        resolve(result);
      },
    };
    Promise.resolve(
      handler({ method, url, socket: { remoteAddress: peer } }, res),
    ).catch(reject);
  });
}

test('WPI query is ordered, bounded, and never asks for arbitrary fields', () => {
  const url = new URL(wpiPageUrl(2000, 500));
  assert.equal(url.searchParams.get('orderByFields'), 'objectid ASC');
  assert.equal(url.searchParams.get('resultOffset'), '2000');
  assert.equal(url.searchParams.get('resultRecordCount'), '500');
  assert.equal(url.searchParams.get('outSR'), '4326');
  assert.equal(url.searchParams.get('f'), 'geojson');
  assert.ok(!url.searchParams.get('outFields').includes('publication_url'));
  assert.throws(() => wpiPageUrl(-1), RangeError);
  assert.throws(() => wpiPageUrl(0, 1001), RangeError);
});

test('fetches ordered pages and includes distinct mirror/retrieval dates', async () => {
  const calls = [];
  const handler = makeHandler({
    now: () => NOW,
    fetchImpl: async (raw) => {
      const url = new URL(raw);
      calls.push(url);
      if (!url.pathname.endsWith('/query')) {
        return Response.json({
          id: 17,
          objectIdField: 'objectid',
          editingInfo: { lastEditDate: 1_776_674_191_094 },
        });
      }
      const offset = Number(url.searchParams.get('resultOffset'));
      const features =
        offset === 0
          ? Array.from({ length: 1000 }, (_, i) => PORT(i + 1))
          : offset === 1000
            ? [PORT(1001), PORT(1002)]
            : [];
      return Response.json({ type: 'FeatureCollection', features });
    },
  });
  const first = await call(handler);
  assert.equal(first.status, 200);
  assert.equal(first.json.records.length, 1002);
  assert.equal(first.json.complete, true);
  assert.equal(first.json.partial, false);
  assert.equal(first.json.retrievedAt, NOW);
  assert.equal(first.json.mirrorLastEditAt, 1_776_674_191_094);
  assert.equal(first.json.ngaPublicationDate, null);
  assert.equal(calls.length, 3);
  const second = await call(handler);
  assert.equal(second.json.records.length, 1002);
  assert.equal(calls.length, 3, 'daily cache prevents repeated upstream reads');
});

test('rejects duplicated or descending objectids rather than silently merging', async () => {
  const handler = makeHandler({
    now: () => NOW,
    fetchImpl: async (raw) => {
      const url = new URL(raw);
      if (!url.pathname.endsWith('/query')) return Response.json({});
      return Response.json({
        type: 'FeatureCollection',
        features: [PORT(2), PORT(1)],
      });
    },
  });
  const output = await call(handler);
  assert.equal(output.status, 502);
  assert.equal(output.json.error, 'wpi_unavailable');
});

test('bad WPI rows are skipped and counted, the snapshot is still served', async () => {
  const row = (objectid, wpinumber, name) => ({
    ...PORT(objectid),
    properties: {
      ...PORT(objectid).properties,
      wpinumber,
      main_port_name: name,
    },
  });
  const handler = makeHandler({
    now: () => NOW,
    fetchImpl: async (raw) => {
      const url = new URL(raw);
      if (!url.pathname.endsWith('/query')) return Response.json({});
      return Response.json({
        type: 'FeatureCollection',
        features: [
          row(1, 400, 'Seydisfjordur'),
          row(2, 401, 'Second'),
          row(3, 400, 'Seydhisfjordhur'),
          row(4, 49454.5, 'Kattupalli Port'),
          row(5, 'bad', 'Malformed'),
          row(6, 402, 'Third'),
        ],
      });
    },
  });
  const output = await call(handler);
  assert.equal(output.status, 200);
  assert.deepEqual(
    output.json.records.map((r) => r.id),
    ['wpi:400', 'wpi:401', 'wpi:402'],
  );
  assert.equal(output.json.skipped.total, 3);
  assert.equal(output.json.skipped.duplicateId, 1);
  assert.equal(output.json.skipped.fractionalId, 1);
  assert.equal(output.json.skipped.malformedId, 1);
});

test('a snapshot with zero valid rows is still rejected', async () => {
  const handler = makeHandler({
    now: () => NOW,
    fetchImpl: async (raw) => {
      const url = new URL(raw);
      if (!url.pathname.endsWith('/query')) return Response.json({});
      return Response.json({
        type: 'FeatureCollection',
        features: [{ ...PORT(1), properties: { objectid: 1, wpinumber: 1.5 } }],
      });
    },
  });
  const output = await call(handler);
  assert.equal(output.status, 502);
});

test('a truncated full-page series is marked partial, never complete', async () => {
  const handler = makeHandler({
    now: () => NOW,
    fetchImpl: async (raw) => {
      const url = new URL(raw);
      if (!url.pathname.endsWith('/query')) return Response.json({});
      const offset = Number(url.searchParams.get('resultOffset'));
      return Response.json({
        type: 'FeatureCollection',
        features: Array.from({ length: 1000 }, (_, j) => PORT(offset + j + 1)),
      });
    },
  });
  const output = await call(handler);
  assert.equal(output.status, 200);
  assert.equal(output.json.records.length, 8000);
  assert.equal(output.json.complete, false);
  assert.equal(output.json.partial, true);
  assert.equal(output.headers['X-Data-Partial'], 'true');
});

test('stale snapshot is bounded and never silently reported as fresh', async () => {
  let clock = NOW;
  let failure = false;
  const handler = makeHandler({
    now: () => clock,
    refreshMs: 1000,
    retryMs: 10,
    staleMs: 5000,
    fetchImpl: async (raw) => {
      if (failure) throw new Error('offline');
      if (!new URL(raw).pathname.endsWith('/query')) return Response.json({});
      return Response.json({
        type: 'FeatureCollection',
        features: [PORT(9)],
      });
    },
  });
  assert.equal((await call(handler)).json.stale, false);
  clock += 2500;
  failure = true;
  const stale = await call(handler);
  assert.equal(stale.status, 200);
  assert.equal(stale.json.stale, true);
  assert.equal(stale.headers['X-Data-Stale'], 'true');
  clock += 7000;
  assert.equal((await call(handler)).status, 502);
});

test('only GET on exact route, no request-controlled upstream URL', async () => {
  const handler = makeHandler({
    fetchImpl: async () => {
      throw Error('no');
    },
  });
  assert.equal((await call(handler, { method: 'POST' })).status, 405);
  assert.equal((await call(handler, { url: '/evil' })).status, 404);
});
