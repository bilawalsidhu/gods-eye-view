import test from 'node:test';
import assert from 'node:assert/strict';
import {
  gnssIntegrityAnchor,
  gnssIntegrityProxy,
  gnssRetryCooldownMs,
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
      ageMs: 0,
      anchor: { lat: 50, lon: 20 },
      radiusNm: 250,
      classifier: 'gev-nic-nacp-v1',
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
  const cached = await request();
  assert.equal(calls, 1);
  assert.equal(cached.body.fetchedAt, 0);
  assert.equal(
    cached.body.ageMs,
    59_000,
    'a cached answer reports its age on the server clock',
  );
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
  assert.equal(
    stale.body.fetchedAt,
    0,
    'a stale answer keeps the time it was observed',
  );
  assert.equal(stale.body.ageMs, 120_000);
  assert.equal(stale.headers['X-Data-Stale'], 'true');
  const missing = await request('/?lat=-10&lon=-10');
  assert.equal(missing.status, 502);
  assert.deepEqual(missing.body, { error: 'gnss_integrity_unavailable' });
});

test('a stale snapshot older than the layer window is no longer served', async () => {
  let clock = 0;
  let fail = false;
  const request = install({
    now: () => clock,
    fetchImpl: async () =>
      fail ? new Response('down', { status: 503 }) : Response.json(snapshot),
  });
  await request();
  fail = true;
  clock = 30 * 60_000;
  assert.equal((await request()).status, 200);
  clock = 30 * 60_000 + 1;
  const expired = await request();
  assert.equal(expired.status, 502);
  assert.deepEqual(expired.body, { error: 'gnss_integrity_unavailable' });
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
        headers: { 'retry-after': '90' },
      });
    },
  });
  const first = await request();
  assert.equal(first.status, 429);
  assert.equal(first.headers['Retry-After'], '90');
  clock = 30_500;
  const cooling = await request('/?lat=1&lon=1');
  assert.equal(cooling.status, 429);
  // The browser is told the remaining shared cooldown, rounded up.
  assert.equal(cooling.headers['Retry-After'], '60');
  assert.equal(calls, 1);
  clock = 91_000;
  await request('/?lat=2&lon=2');
  assert.equal(calls, 2);
});

test('Retry-After accepts seconds or an HTTP date, clamped to 5 s – 120 s', () => {
  const nowMs = Date.parse('2026-09-29T12:00:00Z');
  assert.equal(gnssRetryCooldownMs('30', nowMs), 30_000);
  assert.equal(gnssRetryCooldownMs('1', nowMs), 5_000);
  assert.equal(gnssRetryCooldownMs('3600', nowMs), 120_000);
  assert.equal(
    gnssRetryCooldownMs('Tue, 29 Sep 2026 12:00:45 GMT', nowMs),
    45_000,
  );
  // Garbage, a past date or no header fall back to the default minute.
  assert.equal(gnssRetryCooldownMs('soon', nowMs), 60_000);
  assert.equal(
    gnssRetryCooldownMs('Tue, 29 Sep 2026 11:00:00 GMT', nowMs),
    60_000,
  );
  assert.equal(gnssRetryCooldownMs(null, nowMs), 60_000);
});

test('a cached anchor keeps serving its last snapshot as stale during a cooldown', async () => {
  let clock = 0;
  let limited = false;
  let calls = 0;
  const request = install({
    now: () => clock,
    fetchImpl: async () => {
      calls += 1;
      return limited
        ? new Response('slow down', { status: 429 })
        : Response.json(snapshot);
    },
  });
  await request();
  limited = true;
  clock = 61_000;
  // Another anchor trips the shared cooldown…
  assert.equal((await request('/?lat=5&lon=5')).status, 429);
  clock = 62_000;
  // …and the cached anchor is answered from cache without an upstream call.
  const stale = await request();
  assert.equal(stale.status, 200);
  assert.equal(stale.body.stale, true);
  assert.equal(stale.body.rows.length, 1);
  assert.equal(calls, 2);
});

test('an oversized upstream body is refused as 502 without being parsed', async () => {
  const request = install({
    fetchImpl: async () =>
      new Response('{}', {
        headers: { 'content-length': String(9 * 1024 * 1024) },
      }),
  });
  const res = await request();
  assert.equal(res.status, 502);
  assert.deepEqual(res.body, { error: 'gnss_integrity_unavailable' });
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
