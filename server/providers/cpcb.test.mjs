import test from 'node:test';
import assert from 'node:assert/strict';
import { cpcbProxy } from './cpcb.js';

function harness(options = {}, preview = false) {
  let handler;
  const plugin = cpcbProxy(options);
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
test('no key makes no upstream request; preview has the same route and method policy', async () => {
  const request = harness(
    { apiKey: () => '', fetchImpl: () => assert.fail() },
    true,
  );
  assert.equal((await request()).body.error, 'key_required');
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
        records: Array.from({ length: offset ? 1 : 1000 }, (_, i) => ({
          station: String(i + offset),
          api_key: 'private-test-key',
        })),
      });
    },
  });
  const results = await Promise.all([request(), request()]);
  assert.equal(urls.length, 2);
  assert.equal(results[0].body.records.length, 1001);
  assert.equal(JSON.stringify(results).includes('private-test-key'), false);
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
      return Response.json({ total: 2, records: [{ station: 'partial' }] });
    },
  });
  assert.equal((await request()).status, 502);
  assert.equal((await request()).body.error, 'upstream_unavailable');
  assert.equal(calls, 1);
});

test('stale cache is labeled after failure and expires after six hours', async () => {
  let clock = 1,
    fail = false;
  const request = harness({
    apiKey: () => 'secret',
    now: () => clock,
    fetchImpl: async () => {
      if (fail) throw new Error('secret in an upstream URL');
      return Response.json({ total: 1, records: [{ station: 'test' }] });
    },
  });
  assert.equal((await request()).body.stale, false);
  fail = true;
  clock += 21 * 60_000;
  const stale = await request();
  assert.equal(stale.body.stale, true);
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

test('proxy preserves current OGD average fields for the station normalizer', async () => {
  const request = harness({
    apiKey: () => 'test-key',
    fetchImpl: async () =>
      Response.json({
        total: 1,
        records: [{ avg_value: '42', min_value: '7', max_value: '80' }],
      }),
  });
  const response = await request();
  assert.equal(response.status, 200);
  assert.equal(response.body.records[0].avg_value, '42');
  assert.equal(response.body.records[0].min_value, '7');
  assert.equal(response.body.records[0].max_value, '80');
});
