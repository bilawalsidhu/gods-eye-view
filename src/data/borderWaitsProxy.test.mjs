import test from 'node:test';
import assert from 'node:assert/strict';
import { borderWaitsProxy } from '../../server/providers/borderWaits.js';
import { cbpPort } from '../layers/borderWaits/fixture.mjs';

function install(options = {}, hook = 'configureServer') {
  let handler;
  const plugin = borderWaitsProxy({ warn() {}, ...options });
  assert.equal(plugin.name, 'border-waits');
  assert.equal(typeof plugin.configureServer, 'function');
  assert.equal(typeof plugin.configurePreviewServer, 'function');
  plugin[hook]({
    middlewares: {
      use(path, callback) {
        assert.equal(path, '/api/border-waits');
        handler = callback;
      },
    },
  });
  return async (url = '/', method = 'GET') => {
    const res = {
      writeHead(status, headers) {
        this.status = status;
        this.headers = headers;
      },
      end(body) {
        this.body = JSON.parse(body);
      },
    };
    await handler({ url, method, socket: { remoteAddress: 'local' } }, res);
    return res;
  };
}

for (const hook of ['configureServer', 'configurePreviewServer']) {
  test(`${hook}: fetches only CBP's document and serves normalized rows`, async () => {
    const calls = [];
    const request = install(
      {
        now: () => 1234,
        fetchImpl: async (url, options) => {
          calls.push(url);
          assert.ok(options.signal instanceof AbortSignal);
          assert.equal(options.redirect, 'error');
          return Response.json([cbpPort(), cbpPort({ port_number: '999901' })]);
        },
      },
      hook,
    );
    const res = await request('/?url=https://invalid.example');
    assert.equal(res.status, 200);
    assert.deepEqual(calls, ['https://bwt.cbp.gov/api/bwtnew']);
    assert.equal(res.headers['Cache-Control'], 'no-store');
    assert.equal(res.body.fetchedAt, 1234);
    assert.deepEqual(
      res.body.rows.map(({ id }) => id),
      ['380001'],
    );
    assert.deepEqual(res.body.unlocated, ['999901']);
    assert.equal(res.body.stale, undefined);
  });
}

test('one upstream request serves every viewer for five minutes', async () => {
  let clock = 0;
  let calls = 0;
  const request = install({
    now: () => clock,
    fetchImpl: async () => {
      calls++;
      return Response.json([cbpPort()]);
    },
  });
  await Promise.all([request(), request(), request()]);
  assert.equal(calls, 1, 'concurrent requests share one fetch');
  clock = 299_999;
  await request();
  assert.equal(calls, 1);
  clock = 300_000;
  await request();
  assert.equal(calls, 2);
});

test('an unreachable or malformed CBP keeps serving the last snapshot, marked stale', async () => {
  let clock = 0;
  let mode = 'ok';
  const request = install({
    now: () => clock,
    fetchImpl: async () => {
      if (mode === 'down') throw new Error('connect ETIMEDOUT');
      if (mode === 'error') return new Response('busy', { status: 503 });
      if (mode === 'malformed') return Response.json({ ports: [] });
      return Response.json([cbpPort()]);
    },
  });
  assert.equal((await request()).status, 200);
  for (const failure of ['down', 'error', 'malformed']) {
    mode = failure;
    clock += 300_000;
    const res = await request();
    assert.equal(res.status, 200, failure);
    assert.equal(res.headers['X-Data-Stale'], 'true', failure);
    assert.equal(res.body.stale, true, failure);
    assert.equal(res.body.fetchedAt, 0, failure);
    assert.deepEqual(
      res.body.rows.map(({ id }) => id),
      ['380001'],
    );
  }
  mode = 'ok';
  clock += 300_000;
  const recovered = await request();
  assert.equal(recovered.body.stale, undefined);
  assert.equal(recovered.body.fetchedAt, clock);
});

test('without a snapshot a failure is a 502 that does not leak upstream detail', async () => {
  const request = install({
    fetchImpl: async () => {
      throw new Error('getaddrinfo ENOTFOUND bwt.cbp.gov');
    },
  });
  const res = await request();
  assert.equal(res.status, 502);
  assert.deepEqual(res.body, { error: 'border_waits_unavailable' });
});

test('only GET on the root route is served', async () => {
  let calls = 0;
  const request = install({
    fetchImpl: async () => {
      calls++;
      return Response.json([cbpPort()]);
    },
  });
  const post = await request('/', 'POST');
  assert.equal(post.status, 405);
  assert.equal(post.headers.Allow, 'GET');
  assert.equal((await request('/ports/380001')).status, 404);
  assert.equal(calls, 0);
});

test('a crossing without a location is logged once, not on every refresh', async () => {
  let clock = 0;
  const warnings = [];
  const request = install({
    now: () => clock,
    warn: (message) => warnings.push(message),
    fetchImpl: async () =>
      Response.json([cbpPort(), cbpPort({ port_number: '999901' })]),
  });
  await request();
  clock += 300_000;
  await request();
  assert.deepEqual(warnings, [
    '[BorderWaits] No location for CBP crossings: 999901',
  ]);
});
