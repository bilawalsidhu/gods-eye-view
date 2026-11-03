import test from 'node:test';
import assert from 'node:assert/strict';
import { droneAirspaceProxy } from '../../server/providers/droneAirspace.js';

const feature = (id = 310, type = 'P') => ({
  properties: {
    NAME: `${type}-${id}`,
    TYPE_CODE: type,
    OBJECTID: id,
    UPPER_DESC: 'TNI',
  },
  geometry: {
    type: 'Polygon',
    coordinates: [
      [
        [-77, 38],
        [-76, 38],
        [-76, 39],
        [-77, 38],
      ],
    ],
  },
});

function install(options = {}, hook = 'configureServer') {
  let handler;
  const plugin = droneAirspaceProxy(options);
  assert.equal(typeof plugin.configureServer, 'function');
  assert.equal(typeof plugin.configurePreviewServer, 'function');
  plugin[hook]({
    middlewares: {
      use(path, callback) {
        assert.equal(path, '/api/drone-airspace');
        handler = callback;
      },
    },
  });
  return async (url = '/', method = 'GET', peer = 'local', headers = {}) => {
    const res = {
      headers: {},
      writeHead(status, headers) {
        this.status = status;
        this.headers = headers;
      },
      setHeader(name, value) {
        this.headers[name] = value;
      },
      end(body) {
        this.status ??= this.statusCode;
        this.body = JSON.parse(body);
      },
    };
    await handler(
      { url, method, headers, socket: { remoteAddress: peer } },
      res,
    );
    return res;
  };
}

for (const hook of ['configureServer', 'configurePreviewServer']) {
  test(`${hook}: paging follows offsets and normalizes the combined snapshot`, async () => {
    const calls = [];
    const request = install(
      {
        now: () => 1234,
        fetchImpl: async (url, options) => {
          calls.push(new URL(url));
          assert.ok(options.signal instanceof AbortSignal);
          assert.equal(options.redirect, 'error');
          return Response.json({
            features: [feature(calls.length)],
            exceededTransferLimit: calls.length < 3,
          });
        },
      },
      hook,
    );
    const res = await request('/?url=https://invalid.example&resultOffset=999');
    assert.equal(res.status, 200);
    assert.equal(res.body.fetchedAt, 1234);
    assert.equal(res.body.rows.length, 3);
    assert.equal(calls.length, 3);
    assert.equal(calls[0].searchParams.get('where'), "TYPE_CODE IN ('P','R')");
    assert.equal(calls[0].searchParams.get('f'), 'geojson');
    assert.equal(calls[0].searchParams.has('resultOffset'), false);
    assert.equal(calls[1].searchParams.get('resultOffset'), '1');
  });
}

/**
 * Serve one good snapshot, then let the upstream answer `bad` after the TTL:
 * the bad answer must not replace it, so the client gets the last good rows
 * marked stale, and a cold proxy answers 502 rather than caching the bad one.
 */
async function assertRejectedSnapshot(bad) {
  let now = 1000;
  let broken = false;
  let calls = 0;
  const request = install({
    now: () => now,
    fetchImpl: async () => {
      calls += 1;
      return broken ? bad(calls) : Response.json({ features: [feature(7)] });
    },
  });
  const first = await request();
  assert.equal(first.status, 200);
  broken = true;
  now += 3_600_001;
  const stale = await request();
  assert.equal(stale.status, 200);
  assert.equal(stale.headers['X-Data-Stale'], 'true');
  assert.equal(stale.body.stale, true);
  assert.equal(stale.body.fetchedAt, first.body.fetchedAt);
  assert.deepEqual(
    stale.body.rows.map((row) => row.stableId),
    ['7'],
  );
  calls = 0;
  const cold = install({ fetchImpl: async () => bad(++calls) });
  const res = await cold();
  assert.equal(res.status, 502);
  assert.equal(res.body.error, 'drone_airspace_unavailable');
}

test('an empty upstream snapshot keeps the last good one', () =>
  assertRejectedSnapshot(() => Response.json({ features: [] })));

test('a page whose every feature is invalid keeps the last good one', () =>
  assertRejectedSnapshot(() =>
    Response.json({
      features: [
        {
          ...feature(8),
          properties: { ...feature(8).properties, TYPE_CODE: 'W' },
        },
        { ...feature(9), geometry: null },
      ],
    }),
  ));

test('paging that exhausts its page limit still flagged keeps the last good one', () =>
  assertRejectedSnapshot((call) =>
    Response.json({
      features: [feature(100 + call)],
      exceededTransferLimit: true,
    }),
  ));

test('a flagged page that adds no features keeps the last good one', () =>
  assertRejectedSnapshot((call) =>
    Response.json(
      call % 2
        ? { features: [feature(100 + call)], exceededTransferLimit: true }
        : { features: [], properties: { exceededTransferLimit: true } },
    ),
  ));

test('a cached snapshot is reused until TTL, then refreshed', async () => {
  let now = 1000;
  let fetches = 0;
  const request = install({
    now: () => now,
    fetchImpl: async () => {
      fetches += 1;
      return Response.json({ features: [feature(fetches)] });
    },
  });
  const first = await request();
  now += 3_599_000;
  const cached = await request();
  now += 2000;
  const refreshed = await request();
  assert.equal(first.body.rows[0].stableId, '1');
  assert.equal(cached.body.rows[0].stableId, '1');
  assert.equal(refreshed.body.rows[0].stableId, '2');
  assert.equal(fetches, 2);
});

test('a failed refresh serves the last good snapshot as stale', async () => {
  let now = 1000;
  let fail = false;
  const request = install({
    now: () => now,
    fetchImpl: async () => {
      if (fail) return new Response('nope', { status: 503 });
      return Response.json({ features: [feature(7)] });
    },
  });
  const first = await request();
  fail = true;
  now += 3_600_001;
  const stale = await request();
  assert.equal(first.status, 200);
  assert.equal(stale.status, 200);
  assert.equal(stale.headers['X-Data-Stale'], 'true');
  assert.equal(stale.body.stale, true);
  assert.equal(stale.body.rows[0].stableId, '7');
});

test('method, unknown routes and rate limits are rejected', async () => {
  const request = install({
    fetchImpl: async () => Response.json({ features: [feature()] }),
  });
  assert.equal((await request('/', 'POST')).status, 405);
  assert.equal((await request('/nope')).status, 404);
  const limited = install({
    fetchImpl: async () => Response.json({ features: [feature()] }),
  });
  let last;
  for (let i = 0; i < 61; i++) last = await limited('/', 'GET', '10.0.0.9');
  assert.equal(last.status, 429);
});

test('a cold upstream failure is 502, not an empty snapshot', async () => {
  const request = install({
    fetchImpl: async () => new Response('nope', { status: 503 }),
  });
  const res = await request();
  assert.equal(res.status, 502);
  assert.equal(res.body.error, 'drone_airspace_unavailable');
});

test('a stale snapshot is served for at most a day, then refused', async () => {
  let now = 1_000_000_000;
  let up = true;
  const request = install({
    now: () => now,
    fetchImpl: async () => {
      if (!up) throw new Error('FAA unreachable');
      return Response.json({ features: [feature(7)] });
    },
  });
  const fresh = await request();
  assert.equal(fresh.status, 200);
  up = false;
  now += 23 * 60 * 60 * 1000;
  const stale = await request();
  assert.equal(stale.status, 200);
  assert.equal(stale.body.stale, true);
  assert.equal(stale.body.fetchedAt, fresh.body.fetchedAt);
  now += 2 * 60 * 60 * 1000;
  assert.equal((await request()).status, 502, 'a day-old snapshot is refused');
});

test('a cross-site page is refused before it spends quota or reaches FAA', async () => {
  let fetches = 0;
  const request = install({
    fetchImpl: async () => {
      fetches += 1;
      return Response.json({ features: [feature()] });
    },
  });
  const host = 'localhost:5173';
  const refused = [
    { host, 'sec-fetch-site': 'cross-site' },
    { host, origin: 'https://evil.example' },
    { host, origin: 'https://evil.example', 'sec-fetch-site': 'cross-site' },
    { host, 'x-forwarded-for': '203.0.113.9', 'sec-fetch-site': 'cross-site' },
  ];
  // More refusals than the 60/min per-client quota, all from one peer.
  for (let i = 0; i < 64; i++) {
    const headers = refused[i % refused.length];
    const res = await request('/', 'GET', '10.0.0.5', headers);
    assert.equal(res.status, 403, JSON.stringify(headers));
  }
  assert.equal(fetches, 0, 'refusals cost no upstream call');
  const app = await request('/', 'GET', '10.0.0.5', {
    host,
    origin: `http://${host}`,
    'sec-fetch-site': 'same-origin',
  });
  assert.equal(app.status, 200, 'the app keeps its full quota');
  assert.equal(fetches, 1);
});

test('the app served behind a reverse proxy still gets the zones', async () => {
  const request = install({
    fetchImpl: async () => Response.json({ features: [feature()] }),
  });
  const host = 'gev.example.com';
  const res = await request('/', 'GET', '127.0.0.1', {
    host,
    origin: `https://${host}`,
    'sec-fetch-site': 'same-origin',
    'x-forwarded-for': '203.0.113.9',
    'x-forwarded-proto': 'https',
  });
  assert.equal(res.status, 200);
  assert.equal(res.body.rows.length, 1);
});
