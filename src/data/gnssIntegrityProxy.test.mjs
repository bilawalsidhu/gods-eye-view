import test from 'node:test';
import assert from 'node:assert/strict';
import {
  gnssIntegrityAnchor,
  gnssIntegrityProxy,
  gnssRetryCooldownMs,
} from '../../server/providers/gnssIntegrity.js';

const snapshot = {
  now: 4_000_000_000_000,
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
  const plugin = gnssIntegrityProxy({ monotonicNow: options.now, ...options });
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
      classifier: 'gev-nic-nacp-v2',
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

test('Retry-After accepts sane seconds or HTTP dates up to one hour', () => {
  const nowMs = Date.parse('2026-09-29T12:00:00Z');
  assert.equal(gnssRetryCooldownMs('30', nowMs), 30_000);
  assert.equal(gnssRetryCooldownMs('1', nowMs), 5_000);
  assert.equal(gnssRetryCooldownMs('3600', nowMs), 3_600_000);
  assert.equal(
    gnssRetryCooldownMs('Tue, 29 Sep 2026 13:00:00 GMT', nowMs),
    3_600_000,
  );
  assert.equal(gnssRetryCooldownMs('1e309', nowMs), 60_000);
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

test('overlapping 429s preserve the longest shared deadline', async () => {
  let clock = 0,
    calls = 0;
  const pending = [];
  const request = install({
    now: () => clock,
    fetchImpl: () => {
      calls += 1;
      return new Promise((resolve) => pending.push(resolve));
    },
  });
  const long = request('/?lat=1&lon=0'),
    short = request('/?lat=2&lon=0');
  await new Promise((resolve) => setImmediate(resolve));
  pending[0](
    new Response('', { status: 429, headers: { 'Retry-After': '3600' } }),
  );
  assert.equal((await long).headers['Retry-After'], '3600');
  clock = 1000;
  pending[1](
    new Response('', { status: 429, headers: { 'Retry-After': '5' } }),
  );
  assert.equal((await short).headers['Retry-After'], '3599');
  clock = 7000;
  assert.equal((await request('/?lat=3&lon=0')).status, 429);
  assert.equal(calls, 2);
  clock = 3_600_001;
  const resumed = request('/?lat=3&lon=0');
  await new Promise((resolve) => setImmediate(resolve));
  pending[2](Response.json(snapshot));
  assert.equal((await resumed).status, 200);
  assert.equal(calls, 3);
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
  const flood = install({ fetchImpl: async () => Response.json(snapshot) });
  let limited = 0;
  for (let i = 0; i < 40; i += 1)
    if ((await flood(`/?lat=${i}&lon=1`, 'GET', 'flood')).status === 429)
      limited += 1;
  assert.ok(limited > 0);
});

test('GERMAN: pathological retry deadlines are bounded', () => {
  const at = Date.parse('2026-10-14T12:00:00Z');
  assert.ok(gnssRetryCooldownMs('1e305', at) <= 3600000);
  assert.equal(gnssRetryCooldownMs('9999999999999999999999', at), 3600000);
  assert.equal(
    gnssRetryCooldownMs('Wed, 14 Oct 2099 12:00:00 GMT', at),
    3600000,
  );
  assert.equal(gnssRetryCooldownMs('0x10', at), 60000);
});

test('GERMAN: 5xx, network timeouts and malformed JSON share a short cooldown', async () => {
  for (const fail of [
    async () => new Response('', { status: 503 }),
    async () => {
      throw new DOMException('timeout', 'TimeoutError');
    },
    async () => new Response('bad JSON'),
  ]) {
    let clock = 0,
      calls = 0;
    const request = install({
      now: () => clock,
      fetchImpl: async () => {
        calls++;
        return fail();
      },
    });
    assert.equal((await request()).status, 502);
    clock = 14000;
    assert.equal((await request('/?lat=1&lon=1')).status, 502);
    assert.equal(calls, 1);
    clock = 15001;
    await request('/?lat=2&lon=2');
    assert.equal(calls, 2);
  }
});

test('GERMAN: source timestamp dates evidence; frozen old snapshots are rejected', async () => {
  const now = 1800000000000;
  const request = install({
    now: () => now,
    fetchImpl: async () =>
      Response.json({ ...snapshot, now: (now - 120000) / 1000 }),
  });
  const res = await request();
  assert.equal(res.body.ageMs, 120000);
  assert.equal(res.body.stale, true);
  for (const sourceNow of [(now - 1800001) / 1000, undefined, NaN]) {
    const missing = install({
      now: () => now,
      fetchImpl: async () => Response.json({ ...snapshot, now: sourceNow }),
    });
    assert.equal((await missing()).status, 502);
  }
});

test('GERMAN: cache age and cooldown remain stable across a wall-clock rollback', async () => {
  let wall = 1800000000000,
    mono = 0,
    calls = 0;
  const request = install({
    now: () => wall,
    monotonicNow: () => mono,
    fetchImpl: async () => {
      calls++;
      return calls === 1
        ? Response.json({ ...snapshot, now: wall / 1000 })
        : new Response('', { status: 429, headers: { 'Retry-After': '60' } });
    },
  });
  await request();
  wall -= 3600000;
  mono = 61000;
  const stale = await request();
  assert.equal(stale.body.ageMs, 61000);
  assert.equal(stale.body.stale, true);
  mono += 1000;
  assert.equal((await request('/?lat=1&lon=1')).headers['Retry-After'], '59');
  assert.equal(calls, 2);
});

test('GERMAN: cache hits and coalesced reads do not consume upstream admission', async () => {
  let calls = 0;
  const request = install({
    now: () => 1800000000000,
    fetchImpl: async () => {
      calls++;
      return Response.json(snapshot);
    },
  });
  for (let i = 0; i < 100; i++) assert.equal((await request()).status, 200);
  assert.equal((await request('/?lat=1&lon=1')).status, 200);
  assert.equal(calls, 2);
});

test('GERMAN: distinct concurrent upstream reads are bounded', async () => {
  const pending = [];
  const request = install({
    fetchImpl: () => new Promise((resolve) => pending.push(resolve)),
  });
  const jobs = Array.from({ length: 30 }, (_, i) =>
    request(`/?lat=${i}&lon=1`),
  );
  await new Promise((resolve) => setImmediate(resolve));
  assert.ok(pending.length <= 8);
  pending.forEach((resolve) => resolve(Response.json(snapshot)));
  const results = await Promise.all(jobs);
  assert.ok(results.some((result) => result.status === 429));
});
