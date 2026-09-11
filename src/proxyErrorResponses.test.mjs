import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';

const source = readFileSync(new URL('../vite.config.js', import.meta.url), 'utf8');
const detail = 'fixture-secret-token /internal/example <html>';

// Execute the production middleware with isolated upstreams and cache storage.
// Top-level function closing braces start in column zero in this module.
function extract(name) {
  const start = source.search(new RegExp(`(?:export )?(?:async )?function ${name}\\(`));
  assert.ok(start >= 0, `${name} must exist`);
  const end = source.indexOf('\n}', start);
  return source.slice(start, end + 2).replace(/^export /, '');
}

function fixture(name, overrides = {}, preview = false) {
  const logs = [];
  const deps = {
    path, process: { cwd: () => '/fixture', env: {} },
    fsp: {
      readFile: async () => { throw new Error('cache absent'); },
      stat: async () => { throw new Error('cache absent'); },
      mkdir: async () => {}, writeFile: async () => {},
    },
    fetch: async () => { throw new Error(detail); },
    console: { warn: (...args) => logs.push(args.join(' ')), error: (...args) => logs.push(args.join(' ')) },
    setInterval: () => ({ unref() {} }),
    LL2_CACHE_TTL_MS: 15 * 60_000,
    parseTerrainPoints: () => [[1, 2]],
    resolveTerrainHeightRequest: async () => { throw new Error(detail); },
    ...overrides,
  };
  const helpers = ['readResponseTextCapped', 'coalesceProxyRequest', 'launchLibraryRequestHeaders'].map(extract).join('\n');
  const plugin = new Function(...Object.keys(deps), `${helpers}\n${extract(name)}\nreturn ${name}();`)(...Object.values(deps));
  let middleware;
  plugin[preview ? 'configurePreviewServer' : 'configureServer']({ middlewares: { use(_route, handler) { middleware = handler; } } });
  return {
    logs,
    async request(url = '/', method = 'GET') {
      const response = { headersSent: false, writeHead(status, headers) { Object.assign(this, { status, headers, headersSent: true }); }, end(body) { this.body = body; } };
      await middleware({ url, method }, response);
      assert.doesNotMatch(response.body, /fixture-secret-token|internal\/example|<html>/);
      assert.doesNotMatch(logs.join('\n'), /fixture-secret-token|internal\/example|<html>/);
      return response;
    },
  };
}

for (const status of [401, 429, 500]) {
  for (const preview of [false, true]) {
    test(`Launch Library ${status} stays generic in ${preview ? 'preview' : 'development'}`, async () => {
      const app = fixture('rocketLaunchesProxy', { fetch: async () => new Response(detail.repeat(1000), { status }) }, preview);
      const res = await app.request();
      assert.equal(res.status, status);
      assert.deepEqual(JSON.parse(res.body), { error: 'Launch Library 2 unavailable' });
      assert.equal(res.headers['Cache-Control'], 'no-store');
      assert.equal(res.headers['X-GEV-Cache'], 'NONE');
      assert.equal(app.logs.length, 1);
      assert.match(app.logs[0], new RegExp(`HTTP ${status}`));
      assert.ok(app.logs[0].length < 100);
    });
  }
}

for (const [label, fetch] of [
  ['network error', async () => { throw new Error(detail); }],
  ['malformed JSON', async () => new Response(detail)],
  ['invalid feed', async () => new Response('{}')],
  ['oversized response', async () => new Response(detail, { headers: { 'content-length': String(13 * 1024 * 1024) } })],
]) {
  test(`Launch Library ${label} returns 502`, async () => {
    const res = await fixture('rocketLaunchesProxy', { fetch }).request();
    assert.equal(res.status, 502);
    assert.deepEqual(JSON.parse(res.body), { error: 'Launch Library 2 unavailable' });
  });
}

test('Launch Library retains single-flight, fresh cache, stale fallback, and method guard', async () => {
  let now = Date.now();
  let calls = 0;
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  class Clock extends Date { static now() { return now; } }
  const app = fixture('rocketLaunchesProxy', {
    Date: Clock,
    fetch: async () => { calls += 1; await gate; if (calls > 1) throw new Error(detail); return new Response('{"results":[]}'); },
  });
  assert.equal((await app.request('/', 'POST')).status, 405);
  const first = app.request();
  const second = app.request();
  release();
  const pair = await Promise.all([first, second]);
  assert.deepEqual(pair.map(res => res.headers['X-GEV-Cache']).sort(), ['INFLIGHT', 'MISS']);
  assert.equal(calls, 1);
  assert.equal((await app.request()).headers['X-GEV-Cache'], 'HIT');
  now += 16 * 60_000;
  const stale = await app.request();
  assert.equal(stale.status, 200);
  assert.equal(stale.body, '{"results":[]}');
  assert.equal(stale.headers['X-GEV-Cache'], 'STALE-ERROR');
  assert.equal(calls, 2);
});

test('CelesTrak unexpected failures hide details', async () => {
  const app = fixture('celestrakProxy', { Date: { now() { throw new Error(detail); } } });
  const res = await app.request('/active');
  assert.equal(res.status, 500);
  assert.equal(res.body, 'celestrak proxy error');
  assert.equal(res.headers['x-tle-cache'], 'ERROR');
});

test('CelesTrak retains invalid-group and unavailable responses', async () => {
  const app = fixture('celestrakProxy');
  assert.equal((await app.request('/../')).status, 400);
  const res = await app.request('/active');
  assert.equal(res.status, 502);
  assert.equal(res.headers['x-tle-cache'], 'NONE');
});

test('CelesTrak retains fresh and stale TLE caches', async () => {
  let now = Date.now();
  let calls = 0;
  const app = fixture('celestrakProxy', {
    Date: { now: () => now },
    fetch: async () => { if (++calls > 1) throw new Error(detail); return new Response('1 valid-fixture-TLE'); },
  });
  assert.equal((await app.request('/active')).headers['x-tle-cache'], 'MISS');
  assert.equal((await app.request('/active')).headers['x-tle-cache'], 'HIT');
  now += 7 * 3600_000;
  const stale = await app.request('/active');
  assert.equal(stale.status, 200);
  assert.equal(stale.body, '1 valid-fixture-TLE');
  assert.equal(stale.headers['x-tle-cache'], 'STALE-ERROR');
});

test('terrain unexpected failures hide details', async () => {
  const res = await fixture('terrainHeightsProxy').request('/?points=1,2');
  assert.equal(res.status, 500);
  assert.deepEqual(JSON.parse(res.body), { error: 'terrain heights proxy error' });
});

test('terrain validation and resolver outcomes remain intact', async () => {
  const invalid = await fixture('terrainHeightsProxy', { parseTerrainPoints: () => null }).request();
  assert.equal(invalid.status, 400);
  const body = { results: [{ height: 12 }] };
  const app = fixture('terrainHeightsProxy', { resolveTerrainHeightRequest: async () => ({ status: 200, body, upstreamError: new Error(detail) }) });
  const res = await app.request('/?points=1,2');
  assert.equal(res.status, 200);
  assert.deepEqual(JSON.parse(res.body), body);
  assert.equal(app.logs.length, 1);
});

test('ADSBDB unexpected failures hide details', async () => {
  const badUrl = { toString() { throw new Error(detail); } };
  const res = await fixture('adsbdbProxy').request(badUrl);
  assert.equal(res.status, 500);
  assert.deepEqual(JSON.parse(res.body), { error: 'adsbdb proxy error' });
});

test('ADSBDB retains validation and missing-aircraft semantics', async () => {
  const app = fixture('adsbdbProxy');
  assert.equal((await app.request('/route/!')).status, 400);
  assert.equal((await app.request('/type/nope')).status, 400);
  assert.equal((await app.request('/unknown')).status, 404);
  const absent = await app.request('/type/abcdef');
  assert.equal(absent.status, 200);
  assert.deepEqual(JSON.parse(absent.body), { found: false });
});
