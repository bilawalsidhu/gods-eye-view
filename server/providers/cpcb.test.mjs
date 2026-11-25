import test from 'node:test';
import assert from 'node:assert/strict';
import { cpcbProxy } from './cpcb.js';

const NOW = Date.parse('2026-10-18T06:30:00Z');
/** One OGD row, published at NOW (12:00 IST). */
const ogdRow = (patch = {}) => ({
  country: 'India',
  state: 'Delhi',
  city: 'Delhi',
  station: 'Test station',
  latitude: '28.6',
  longitude: '77.2',
  pollutant_id: 'PM2.5',
  avg_value: '42',
  last_update: '18-10-2026 12:00:00',
  ...patch,
});

function harness(options = {}, preview = false) {
  let handler;
  const plugin = cpcbProxy({ now: () => NOW, ...options });
  const installed = plugin[
    preview ? 'configurePreviewServer' : 'configureServer'
  ]({
    middlewares: {
      use(path, fn) {
        assert.equal(path, '/api/air-quality/india');
        handler = fn;
        return () =>
          assert.fail('Connect app must not become a Vite post-hook');
      },
    },
  });
  assert.equal(installed, undefined);
  return async (method = 'GET', url = '/') => {
    let status,
      body,
      next = false;
    await handler(
      { method, url },
      {
        setHeader() {},
        writeHead(s) {
          status = s;
        },
        end(s) {
          body = JSON.parse(s);
        },
      },
      () => {
        next = true;
      },
    );
    return { status, body, next };
  };
}
test('no key makes no upstream request and answers 428; preview has the same route and method policy', async () => {
  const request = harness(
    { apiKey: () => '', fetchImpl: () => assert.fail() },
    true,
  );
  const missing = await request();
  assert.equal(missing.status, 428);
  assert.equal(missing.body.error, 'no_key');
  assert.equal((await request('POST')).status, 405);
  assert.equal((await request('GET', '/other')).next, true);
});

test('pagination, coalescing and cache: credentials and arbitrary upstream fields never reach clients', async () => {
  const urls = [];
  const request = harness({
    apiKey: () => 'private-test-key',
    fetchImpl: async (url) => {
      urls.push(url);
      const offset = Number(url.searchParams.get('offset'));
      return Response.json({
        total: 1001,
        records: Array.from({ length: offset ? 1 : 1000 }, (_, i) =>
          ogdRow({ station: String(i + offset), api_key: 'private-test-key' }),
        ),
      });
    },
  });
  const results = await Promise.all([request(), request()]);
  assert.equal(urls.length, 2);
  assert.equal(results[0].body.schemaVersion, 1);
  assert.equal(results[0].body.readings.length, 1001);
  assert.equal(results[0].body.stations, undefined);
  assert.equal(JSON.stringify(results).includes('private-test-key'), false);
  assert.equal(JSON.stringify(results).includes('api_key'), false);
  assert.equal(urls[0].origin, 'https://api.data.gov.in');
  assert.equal(urls[0].searchParams.get('api-key'), 'private-test-key');
  await request();
  assert.equal(urls.length, 2);
});

test('incomplete pages fail atomically and failures are throttled and sanitized', async () => {
  let calls = 0;
  const request = harness({
    apiKey: () => 'secret',
    fetchImpl: async () => {
      calls++;
      return Response.json({ total: 2, records: [ogdRow()] });
    },
  });
  assert.equal((await request()).status, 502);
  assert.equal((await request()).body.error, 'upstream_unavailable');
  assert.equal(calls, 1);
});

test('stale cache is labeled after failure and expires after six hours', async () => {
  let clock = NOW,
    fail = false;
  const request = harness({
    apiKey: () => 'secret',
    now: () => clock,
    fetchImpl: async () => {
      if (fail) throw new Error('secret in an upstream URL');
      return Response.json({ total: 1, records: [ogdRow()] });
    },
  });
  assert.equal((await request()).body.stale, false);
  fail = true;
  clock += 21 * 60_000;
  const stale = await request();
  assert.equal(stale.body.stale, true);
  assert.equal(stale.body.readings.length, 1);
  assert.equal(JSON.stringify(stale).includes('secret'), false);
  clock += 6 * 60 * 60_000;
  assert.equal((await request()).status, 502);
});

test('oversized upstream responses and redirects are not accepted', async () => {
  const request = harness({
    apiKey: () => 'secret',
    fetchImpl: async (_url, options) => {
      assert.equal(options.redirect, 'error');
      assert.ok(options.signal);
      return new Response('{}', { headers: { 'content-length': '99999999' } });
    },
  });
  assert.equal((await request()).status, 502);
});

test('the snapshot carries the current OGD avg_value as the reading value', async () => {
  const request = harness({
    apiKey: () => 'test-key',
    fetchImpl: async () =>
      Response.json({
        total: 1,
        records: [ogdRow({ min_value: '7', max_value: '80' })],
      }),
  });
  const response = await request();
  assert.equal(response.status, 200);
  const [reading] = response.body.readings;
  assert.equal(reading.provider, 'cpcb');
  assert.equal(reading.parameter, 'PM2.5');
  assert.equal(reading.value, 42);
  assert.equal(reading.observedMs, NOW);
});

test('a key OGD rejects is answered as rejected, without the key', async () => {
  for (const status of [401, 403]) {
    let clock = NOW;
    let reject = true;
    const request = harness({
      apiKey: () => 'secret-key',
      now: () => clock,
      fetchImpl: async () =>
        reject
          ? new Response('Invalid key secret-key', { status })
          : Response.json({ total: 1, records: [ogdRow()] }),
    });
    const rejected = await request();
    assert.equal(rejected.status, status);
    assert.equal(rejected.body.error, 'key_rejected');
    assert.equal(JSON.stringify(rejected).includes('secret'), false);
    // Still rejected during the retry pause; a good refresh clears it.
    assert.equal((await request()).status, status);
    reject = false;
    clock += 61_000;
    assert.equal((await request()).status, 200);
  }
});

test('a renamed average field keeps the last good snapshot instead of a fresh empty one', async () => {
  let clock = NOW,
    renamed = false;
  const request = harness({
    apiKey: () => 'secret',
    now: () => clock,
    fetchImpl: async () =>
      Response.json({
        total: 1,
        records: [
          renamed
            ? ogdRow({ avg_value: undefined, average_value: '42' })
            : ogdRow(),
        ],
      }),
  });
  assert.equal((await request()).body.readings.length, 1);
  renamed = true;
  clock += 21 * 60_000;
  const after = await request();
  assert.equal(after.status, 200);
  assert.equal(after.body.stale, true);
  assert.equal(after.body.readings.length, 1);
});
