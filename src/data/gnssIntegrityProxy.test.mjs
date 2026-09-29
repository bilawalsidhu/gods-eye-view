import test from 'node:test';
import assert from 'node:assert/strict';
import {
  gnssIntegrityAnchor,
  gnssIntegrityProxy,
} from '../../server/providers/gnssIntegrity.js';

const snapshot = {
  now: 1,
  ac: [
    {
      hex: '4ca7b5',
      type: 'adsb_icao',
      version: 2,
      alt_baro: 36000,
      lat: 50.1,
      lon: 19.9,
      nic: 0,
      nac_p: 0,
      seen_pos: 1,
      flight: 'RYR1AB  ',
      r: 'EI-ABC',
    },
    { hex: '000001', type: 'mlat', lat: 50, lon: 20, nic: 0, nac_p: 0 },
  ],
};

function install(options = {}, hook = 'configureServer') {
  let handler;
  const plugin = gnssIntegrityProxy(options);
  assert.equal(plugin.name, 'gnss-integrity');
  plugin[hook]({
    middlewares: {
      use(path, callback) {
        assert.equal(path, '/api/gnss-integrity');
        handler = callback;
      },
    },
  });
  return async (url = '/?lat=50&lon=20', method = 'GET', peer = 'local') => {
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

test('anchors snap to whole degrees and reject missing or out-of-range values', () => {
  assert.deepEqual(gnssIntegrityAnchor('/?lat=50.44&lon=19.51'), {
    lat: 50,
    lon: 20,
  });
  assert.equal(gnssIntegrityAnchor('/?lat=91&lon=0'), null);
  assert.equal(gnssIntegrityAnchor('/?lat=0&lon=-181'), null);
  assert.equal(gnssIntegrityAnchor('/?lat=0'), null);
  assert.equal(gnssIntegrityAnchor('/?lat=abc&lon=1'), null);
});

for (const hook of ['configureServer', 'configurePreviewServer']) {
  test(`${hook}: fetches the fixed adsb.lol origin and returns only integrity facts`, async () => {
    const calls = [];
    const request = install(
      {
        now: () => 1234,
        fetchImpl: async (url, options) => {
          calls.push(url);
          assert.ok(options.signal instanceof AbortSignal);
          assert.equal(options.redirect, 'error');
          return Response.json(snapshot);
        },
      },
      hook,
    );
    const res = await request(
      '/?lat=50.2&lon=19.8&url=https://invalid.example',
    );
    assert.equal(res.status, 200);
    assert.deepEqual(calls, ['https://api.adsb.lol/v2/lat/50/lon/20/dist/250']);
    assert.deepEqual(res.body, {
      fetchedAt: 1234,
      anchor: { lat: 50, lon: 20 },
      radiusNm: 250,
      rows: [
        {
          hex: '4ca7b5',
          lat: 50.1,
          lon: 19.9,
          nic: 0,
          nacp: 0,
          gpsLost: false,
          degraded: true,
        },
      ],
    });
    assert.equal(res.headers['Cache-Control'], 'no-store');
  });
}

test('snapshots are cached per anchor and concurrent reads share one upstream call', async () => {
  let clock = 0;
  let calls = 0;
  const request = install({
    now: () => clock,
    fetchImpl: async () => {
      calls += 1;
      return Response.json(snapshot);
    },
  });
  await Promise.all([request(), request('/?lat=50.3&lon=20.2')]);
  assert.equal(calls, 1);
  clock = 59_000;
  await request();
  assert.equal(calls, 1);
  clock = 61_000;
  await request();
  assert.equal(calls, 2);
  await request('/?lat=10&lon=10');
  assert.equal(calls, 3);
});

test('an upstream failure serves the last snapshot as stale, else 502', async () => {
  let clock = 0;
  let fail = false;
  const request = install({
    now: () => clock,
    fetchImpl: async () =>
      fail ? new Response('down', { status: 503 }) : Response.json(snapshot),
  });
  await request();
  fail = true;
  clock = 120_000;
  const stale = await request();
  assert.equal(stale.status, 200);
  assert.equal(stale.body.stale, true);
  assert.equal(stale.headers['X-Data-Stale'], 'true');
  const missing = await request('/?lat=-10&lon=-10');
  assert.equal(missing.status, 502);
  assert.deepEqual(missing.body, { error: 'gnss_integrity_unavailable' });
});

test('an upstream 429 starts a cooldown with no further upstream calls', async () => {
  let clock = 0;
  let calls = 0;
  const request = install({
    now: () => clock,
    fetchImpl: async () => {
      calls += 1;
      return new Response('slow down', {
        status: 429,
        headers: { 'retry-after': '120' },
      });
    },
  });
  assert.equal((await request()).status, 502);
  const cooling = await request('/?lat=1&lon=1');
  assert.equal(cooling.status, 429);
  assert.equal(calls, 1);
  clock = 121_000;
  await request('/?lat=2&lon=2');
  assert.equal(calls, 2);
});

test('the route rejects other methods, paths, bad anchors, a malformed feed and floods', async () => {
  const request = install({
    fetchImpl: async () => Response.json({ nope: true }),
  });
  assert.equal((await request('/', 'POST')).status, 405);
  assert.equal((await request('/other?lat=1&lon=1')).status, 404);
  assert.equal((await request('/?lat=1')).status, 400);
  assert.equal((await request('/?lat=1&lon=1')).status, 502);
  let limited = 0;
  for (let i = 0; i < 40; i += 1)
    if ((await request('/?lat=1&lon=1', 'GET', 'flood')).status === 429)
      limited += 1;
  assert.ok(limited > 0);
});
