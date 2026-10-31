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
  return async (url = '/', method = 'GET', peer = 'local') => {
    const res = {
      writeHead(status, headers) {
        this.status = status;
        this.headers = headers;
      },
      end(body) {
        this.body = JSON.parse(body);
      },
    };
    await handler({ url, method, socket: { remoteAddress: peer } }, res);
    return res;
  };
}

for (const hook of ['configureServer', 'configurePreviewServer']) {
  test(`${hook}: paging stops at five pages and normalizes the combined snapshot`, async () => {
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
            exceededTransferLimit: true,
          });
        },
      },
      hook,
    );
    const res = await request('/?url=https://invalid.example&resultOffset=999');
    assert.equal(res.status, 200);
    assert.equal(res.body.fetchedAt, 1234);
    assert.equal(res.body.rows.length, 5);
    assert.equal(calls.length, 5);
    assert.equal(calls[0].searchParams.get('where'), "TYPE_CODE IN ('P','R')");
    assert.equal(calls[0].searchParams.get('f'), 'geojson');
    assert.equal(calls[0].searchParams.has('resultOffset'), false);
    assert.equal(calls[1].searchParams.get('resultOffset'), '1');
  });
}

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
