import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fsp } from 'node:fs';
import { terrainHeightsProxy } from 'gods-eye-view/server/providers/terrain';
import { tomtomProxy } from 'gods-eye-view/server/providers/traffic';
import { firmsProxy } from 'gods-eye-view/server/providers/firms';
import { gbfsProxy } from 'gods-eye-view/server/providers/gbfs';
import { localProviderPlugins } from '../../server/providers/local.js';

function install(plugin) {
  const routes = new Map();
  plugin.configureServer({
    middlewares: {
      use(route, handler) {
        routes.set(route, handler);
      },
    },
  });
  assert.equal(routes.size, 1);
  return async (url = '/', method = 'GET') => {
    const res = {
      headersSent: false,
      writeHead(status, headers) {
        Object.assign(this, { status, headers, headersSent: true });
      },
      end(body) {
        this.body = body;
      },
    };
    await [...routes.values()][0]({ url, method }, res);
    return res;
  };
}
function isolate(t, env = {}) {
  for (const [name, value] of Object.entries(env)) {
    const previous = process.env[name];
    t.after(() => {
      if (previous === undefined) delete process.env[name];
      else process.env[name] = previous;
    });
    process.env[name] = value;
  }
  t.mock.method(fsp, 'readFile', async () => {
    throw Error('no disk cache');
  });
  t.mock.method(fsp, 'stat', async () => {
    throw Error('no disk cache');
  });
  t.mock.method(fsp, 'mkdir', async () => {});
  t.mock.method(fsp, 'writeFile', async () => {});
  t.mock.method(globalThis, 'setInterval', () => ({ unref() {} }));
  t.mock.method(console, 'warn', () => {});
}
const json = (res) => JSON.parse(res.body);

test('standalone composition mounts every extracted provider exactly once without acquisition', (t) => {
  t.mock.method(globalThis, 'fetch', () => {
    throw Error('construction must not fetch');
  });
  const plugins = localProviderPlugins();
  for (const factory of [
    terrainHeightsProxy,
    tomtomProxy,
    firmsProxy,
    gbfsProxy,
  ])
    assert.equal(plugins.filter((p) => p.name === factory().name).length, 1);
});

test('terrain middleware chunks missing points and reconstructs repeated/reordered requests from cache', async (t) => {
  isolate(t);
  let calls = 0;
  const sizes = [];
  t.mock.method(globalThis, 'fetch', async (raw) => {
    calls++;
    const url = new URL(raw);
    assert.equal(url.origin, 'https://terrain.reearth.land');
    const points = url.searchParams
      .get('points')
      .split(';')
      .map((p) => p.split(',').map(Number));
    sizes.push(points.length);
    return Response.json({
      results: points.map(([lon]) => ({ ellipsoid: lon + 100 })),
    });
  });
  const request = install(terrainHeightsProxy());
  const points = Array.from({ length: 257 }, (_, i) => `${i / 100},1`);
  const res = await request('/?points=' + points.join(';'));
  assert.equal(res.status, 200);
  // Tracks UPSTREAM_CHUNK in server/providers/terrain.js (64): 257 points
  // split into four full chunks and a remainder.
  assert.deepEqual(sizes, [64, 64, 64, 64, 1]);
  const reordered = await request('/?points=2.56,1;0,1;2.56,1');
  assert.deepEqual(json(reordered), {
    results: [{ ellipsoid: 102.56 }, { ellipsoid: 100 }, { ellipsoid: 102.56 }],
  });
  // Five chunks for the first batch; the reordered request is fully cached.
  assert.equal(calls, 5);
  assert.equal((await request('/?points=invalid')).status, 400);
  assert.equal(
    (await request('/?points=' + Array(2001).fill('0,1').join(';'))).status,
    500,
  );
  // Rejected requests add no upstream calls: still the five from the first batch.
  assert.equal(calls, 5);
});

test('terrain middleware migrates valid legacy disk points without fabricating omitted heights', async (t) => {
  isolate(t);
  t.mock.method(fsp, 'readFile', async () =>
    JSON.stringify({
      '1,2;3,4': { at: Date.now(), results: [{ ellipsoid: 77 }] },
    }),
  );
  let calls = 0;
  t.mock.method(globalThis, 'fetch', async (raw) => {
    calls++;
    assert.equal(new URL(raw).searchParams.get('points'), '3.00000,4.00000');
    return Response.json({ results: [{ ellipsoid: 88 }] });
  });
  const res = await install(terrainHeightsProxy())('/?points=3,4;1,2');
  assert.deepEqual(json(res), {
    results: [{ ellipsoid: 88 }, { ellipsoid: 77 }],
  });
  assert.equal(calls, 1);
});

test('traffic middleware preserves keyless mode, caching, stale budget fallback and UTC rollover', async (t) => {
  isolate(t, { TOMTOM_API_KEY: '', TOMTOM_DAILY_TILE_BUDGET: '1' });
  let now = Date.UTC(2026, 8, 12, 12);
  t.mock.method(Date, 'now', () => now);
  let calls = 0;
  t.mock.method(globalThis, 'fetch', async (raw) => {
    calls++;
    assert.equal(new URL(raw).searchParams.get('key'), 'fixture-key');
    return new Response(new Uint8Array([1, 2, 3]));
  });
  const request = install(tomtomProxy());
  assert.equal(json(await request('/status')).hasKey, false);
  assert.equal((await request('/flow/8/1/1.pbf')).status, 503);
  assert.equal((await request('/flow/7/1/1.pbf')).status, 400);
  assert.equal(calls, 0);
  process.env.TOMTOM_API_KEY = 'fixture-key';
  assert.equal(
    (await request('/flow/8/1/1.pbf')).headers['x-tomtom-cache'],
    'MISS',
  );
  assert.equal(
    (await request('/flow/8/1/1.pbf')).headers['x-tomtom-cache'],
    'HIT',
  );
  assert.equal(json(await request('/status')).dailyCount, 1);
  assert.equal(calls, 1);
  now += 120001;
  assert.equal(
    (await request('/flow/8/1/1.pbf')).headers['x-tomtom-cache'],
    'STALE-BUDGET',
  );
  assert.equal((await request('/flow/8/2/1.pbf')).status, 429);
  assert.equal(calls, 1);
  now += 86400000;
  assert.equal(json(await request('/status')).dailyCount, 0);
  assert.equal(
    (await request('/flow/8/1/1.pbf')).headers['x-tomtom-cache'],
    'MISS',
  );
  assert.equal(calls, 2);
});

test('FIRMS retains a large successful source during partial failure and filters stale data at serve time', async (t) => {
  isolate(t, { FIRMS_MAP_KEY: '' });
  let now = Date.UTC(2026, 8, 12, 12);
  t.mock.method(Date, 'now', () => now);
  let calls = 0;
  const header = 'latitude,longitude,acq_date,acq_time,confidence,frp\n';
  const csv = header + '30,-97,2026-09-12,1200,h,10\n'.repeat(130001);
  t.mock.method(globalThis, 'fetch', async (raw) => {
    calls++;
    const url = new URL(raw);
    assert.equal(url.hostname, 'firms.modaps.eosdis.nasa.gov');
    if (url.pathname.includes('mapkey_status'))
      return Response.json({
        current_transactions: 3,
        transaction_limit: 5000,
      });
    return url.pathname.includes('VIIRS_NOAA20')
      ? new Response(csv)
      : new Response('offline', { status: 503 });
  });
  const request = install(firmsProxy());
  assert.equal((await request()).status, 503);
  assert.equal(json(await request('/status')).hasKey, false);
  assert.equal(calls, 0);
  process.env.FIRMS_MAP_KEY = 'fixture-key';
  const first = json(await request());
  assert.equal(first.count, 130001);
  assert.equal(first.sources.filter((s) => s.ok).length, 1);
  assert.equal(calls, 3);
  assert.equal(json(await request()).count, 130001);
  assert.equal(calls, 3);
  assert.deepEqual(json(await request('/status')).transactions, {
    used: 3,
    limit: 5000,
  });
  now += 25 * 3600000;
  t.mock.method(
    globalThis,
    'fetch',
    async () => new Response('offline', { status: 503 }),
  );
  const stale = json(await request());
  assert.equal(stale.stale, true);
  assert.equal(stale.count, 0);
});

test('GBFS keeps host/path/method guards, response caps and distinct information/status cache headers', async (t) => {
  let calls = 0;
  t.mock.method(globalThis, 'fetch', async (raw) => {
    calls++;
    assert.equal(new URL(raw).hostname, 'gbfs.lyft.com');
    return Response.json({ data: { stations: [] } });
  });
  const request = install(gbfsProxy());
  const target = (p) => '/' + encodeURIComponent('https://gbfs.lyft.com/' + p);
  assert.equal(
    (await request(target('station_status.json'), 'POST')).status,
    405,
  );
  assert.equal(
    (
      await request(
        '/' + encodeURIComponent('https://example.com/station_status.json'),
      )
    ).status,
    403,
  );
  assert.equal((await request(target('gbfs.json'))).status, 400);
  assert.equal((await request('/%zz')).status, 400);
  assert.equal(calls, 0);
  assert.equal(
    (await request(target('station_information.json'))).headers[
      'Cache-Control'
    ],
    'public, max-age=300',
  );
  assert.equal(
    (await request(target('station_status.json'))).headers['Cache-Control'],
    'no-store',
  );
  t.mock.method(
    globalThis,
    'fetch',
    async () =>
      new Response('x', {
        headers: { 'content-length': String(6 * 1024 * 1024) },
      }),
  );
  assert.equal((await request(target('station_status.json'))).status, 502);
});

test('terrain middleware retains successful chunks around a failure and retries only missing points', async (t) => {
  isolate(t);
  const requests = [];
  let fail = true;
  t.mock.method(globalThis, 'fetch', async (raw) => {
    const points = new URL(raw).searchParams
      .get('points')
      .split(';')
      .map((p) => p.split(',').map(Number));
    requests.push(points);
    if (fail && points[0][0] === 0.64) return new Response('', { status: 400 });
    return Response.json({
      results: points.map(([lon]) => ({ ellipsoid: lon + 100 })),
    });
  });
  const request = install(terrainHeightsProxy());
  const points = Array.from({ length: 130 }, (_, i) => `${i / 100},1`);
  const url = '/?points=' + points.join(';');
  assert.equal((await request(url)).status, 502);
  assert.deepEqual(
    requests.map((p) => p.length),
    [64, 64, 2],
  );
  fail = false;
  const recovered = await request(url);
  assert.equal(recovered.status, 200);
  assert.deepEqual(
    requests[3],
    Array.from({ length: 64 }, (_, i) => [(i + 64) / 100, 1]),
  );
  assert.deepEqual(
    json(recovered).results,
    Array.from({ length: 130 }, (_, i) => ({ ellipsoid: i / 100 + 100 })),
  );
  assert.equal(requests.length, 4);
});
