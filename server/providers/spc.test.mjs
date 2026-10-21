import test from 'node:test';
import assert from 'node:assert/strict';
import { spcOutlooksProxy } from './spc.js';
import {
  NOW,
  feature,
  collection,
} from '../../src/layers/spc/fixtures.test-support.mjs';
import {
  SPC_BODY_LIMIT,
  SPC_REFRESH_MS,
  SPC_MAX_AGE_MS,
} from '../../src/layers/spc/records.js';

function install(options = {}, hook = 'configureServer') {
  let handler;
  spcOutlooksProxy({ now: () => NOW, ...options })[hook]({
    middlewares: {
      use(path, callback) {
        assert.equal(path, '/api/spc-outlooks');
        handler = callback;
      },
    },
  });
  return async (url = '/day1-categorical', method = 'GET', peer = 'test') => {
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

for (const hook of ['configureServer', 'configurePreviewServer'])
  test(`${hook}: four fixed products, GeoJSON/WGS84, no caller-controlled query`, async () => {
    const calls = [];
    const request = install(
      {
        fetchImpl: async (url, options) => {
          calls.push(new URL(url));
          assert.equal(options.redirect, 'error');
          assert.ok(options.signal instanceof AbortSignal);
          return Response.json(collection());
        },
      },
      hook,
    );
    for (const product of [
      'day1-categorical',
      'day1-tornado',
      'day2-categorical',
      'day2-tornado',
    ])
      assert.equal((await request(`/${product}`)).status, 200);
    assert.deepEqual(
      calls.map((url) => url.pathname.split('/').at(-2)),
      ['1', '3', '9', '11'],
    );
    for (const url of calls) {
      assert.equal(url.origin, 'https://mapservices.weather.noaa.gov');
      assert.equal(url.searchParams.get('f'), 'geojson');
      assert.equal(url.searchParams.get('outSR'), '4326');
    }
    for (const path of [
      '/',
      '/day3-tornado',
      '//day1-tornado',
      '/day1-tornado/extra',
      '/%64ay1-tornado',
    ])
      assert.equal((await request(path)).status, 404);
    assert.equal(
      (await request('/day1-tornado?url=https://bad.example')).status,
      400,
    );
    assert.equal((await request('/day1-tornado', 'POST')).status, 405);
    assert.equal(calls.length, 4);
  });

test('fresh cache, TTL refresh, bounded stale fallback and failure backoff/retry', async () => {
  let clock = NOW,
    calls = 0,
    fail = false;
  const request = install({
    now: () => clock,
    fetchImpl: async () => {
      calls++;
      if (fail) throw new Error('private');
      return Response.json(collection(feature()));
    },
  });
  const first = await request();
  assert.deepEqual((await request()).body, first.body);
  assert.equal(calls, 1);
  clock += SPC_REFRESH_MS;
  fail = true;
  const stale = await request();
  assert.equal(stale.body.stale, true);
  assert.equal(stale.body.fetchedAt, NOW);
  assert.equal(stale.headers['X-Data-Stale'], 'true');
  await request();
  assert.equal(calls, 2, 'failure backoff avoids retry storms');
  clock += 30_000;
  fail = false;
  assert.equal((await request()).body.stale, undefined);
  assert.equal(calls, 3);
  fail = true;
  clock += SPC_MAX_AGE_MS;
  assert.equal((await request()).status, 502);
});

test('expired cache is never served as stale context', async () => {
  let clock = Date.parse('2026-10-22T11:59:00Z'),
    fail = false;
  const request = install({
    now: () => clock,
    fetchImpl: async () => {
      if (fail) throw new Error('private');
      return Response.json(collection(feature()));
    },
  });
  assert.equal((await request()).status, 200);
  clock += 300_000;
  fail = true;
  assert.equal((await request()).status, 502);
});

test('concurrent requests coalesce and failures clear in-flight ownership', async () => {
  let release,
    calls = 0;
  const pending = new Promise((resolve) => {
    release = resolve;
  });
  const request = install({
    fetchImpl: async () => {
      calls++;
      await pending;
      return Response.json(collection());
    },
  });
  const responses = [request(), request(), request()];
  await new Promise(setImmediate);
  assert.equal(calls, 1);
  release();
  assert.ok((await Promise.all(responses)).every((r) => r.status === 200));
});

test('HTTP/ArcGIS/geometry/JSON errors are sanitized, not cached as empty; retries recover', async () => {
  for (const response of [
    () => new Response('private', { status: 503 }),
    () => Response.json({ error: { message: 'private' } }),
    () => Response.json(collection(feature({}, null))),
    () => new Response('{invalid'),
  ]) {
    let clock = NOW,
      calls = 0;
    const request = install({
      now: () => clock,
      fetchImpl: async () =>
        ++calls === 1 ? response() : Response.json(collection()),
    });
    assert.deepEqual((await request()).body, {
      error: 'spc_outlooks_unavailable',
    });
    await request();
    assert.equal(calls, 1);
    clock += 30_000;
    assert.equal((await request()).status, 200);
    assert.equal(calls, 2);
  }
});

test('response body caps cover declared and streamed sizes and stalled bodies time out', async () => {
  for (const declared of [true, false]) {
    let cancelled = false;
    const request = install({
      fetchImpl: async () =>
        new Response(
          new ReadableStream({
            pull(c) {
              c.enqueue(new Uint8Array(1024 * 1024));
            },
            cancel() {
              cancelled = true;
            },
          }),
          {
            headers: declared
              ? { 'Content-Length': String(SPC_BODY_LIMIT + 1) }
              : {},
          },
        ),
    });
    assert.equal((await request()).status, 502);
    assert.equal(cancelled, true);
  }
  const keepAlive = setTimeout(() => {}, 1000);
  try {
    const request = install({
      timeoutMs: 10,
      fetchImpl: async (_url, { signal }) =>
        new Promise((_resolve, reject) =>
          signal.addEventListener('abort', () => reject(signal.reason), {
            once: true,
          }),
        ),
    });
    assert.equal((await request()).status, 502);
    let cancelled = false;
    const body = install({
      timeoutMs: 10,
      fetchImpl: async () =>
        new Response(
          new ReadableStream({
            start() {},
            cancel() {
              cancelled = true;
            },
          }),
        ),
    });
    assert.equal((await body()).status, 502);
    assert.equal(cancelled, true);
  } finally {
    clearTimeout(keepAlive);
  }
});

test('per-client rate limiting applies even to cached products', async () => {
  const request = install({
    fetchImpl: async () => Response.json(collection()),
  });
  for (let i = 0; i < 60; i++) assert.equal((await request()).status, 200);
  const limited = await request();
  assert.equal(limited.status, 429);
  assert.ok(limited.headers['Retry-After']);
  assert.equal(
    (await request('/day1-categorical', 'GET', 'other')).status,
    200,
  );
});
