import test from 'node:test';
import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import { spawnSync } from 'node:child_process';
import { overpassProxy } from '../overpass.js';
import { sanitizeOverpassBody } from './query.js';

const form = (query) => `data=${encodeURIComponent(query)}`;

test('bracket validation rejects malformed filters without trusting their contents as bounds', () => {
  for (const query of [
    'node[',
    'node]',
    'node[[name]](around:20,1,1);out;',
    'node[name=around:20];out;',
    'node[is_in];out;',
    'node[name="(around:20,1,1)"];out;',
    'node(around:20,1,1);way[name];out;',
    'way[highway](area.a);out;',
    'node[->.a](around:20,1,1);way.a;out;',
  ]) {
    assert.equal(sanitizeOverpassBody(form(query)).ok, false, query);
  }
});

test('bounded queries preserve quoted brackets, comments, multiple tags and timeout clamping', () => {
  for (const query of [
    '[out:json][timeout:999];node[name="[Town]; ]"](around:20,1,1);out;',
    '/* [ */way[highway][name](30.1,-97.9,30.5,-97.5);out geom;',
    'is_in(30.2,-97.7)->.a;area.a[boundary="administrative"];out tags;',
    'area(3600039152)->.x;rel(pivot.x);out geom;',
  ]) {
    const result = sanitizeOverpassBody(form(query));
    assert.equal(result.ok, true, query);
    assert.equal(
      new URLSearchParams(result.body).get('data'),
      query.replace('[timeout:999]', '[timeout:30]'),
    );
  }
});

test('a burst of maximum-size unterminated filters completes within a bounded process deadline', () => {
  // A child deadline can stop synchronous regex backtracking; a test timeout in
  // the same event loop cannot. The old parser takes several seconds for this.
  const result = spawnSync(
    process.execPath,
    [
      '--input-type=module',
      '-e',
      `import { sanitizeOverpassBody } from ${JSON.stringify(new URL('./query.js', import.meta.url).href)};
       for (let i = 0; i < 20; i++) {
         if (sanitizeOverpassBody('data=node' + '['.repeat(24000)).ok) process.exit(1);
       }`,
    ],
    { timeout: 2000, encoding: 'utf8' },
  );
  assert.ifError(result.error);
  assert.equal(result.status, 0, result.stderr);
});

function handler(hook = 'configureServer') {
  let route;
  overpassProxy()[hook]({
    middlewares: {
      use(path, fn) {
        if (path === '/api/overpass') route = fn;
      },
    },
  });
  return route;
}

async function call(
  route,
  {
    headers = {},
    peer = '127.0.0.1',
    body = 'data=node[',
    forbidRead = false,
    method = 'POST',
    url = '/',
  } = {},
) {
  let reads = 0;
  const req = new Readable({
    read() {
      reads++;
      assert.equal(forbidRead, false, 'refused request must not read its body');
      this.push(Buffer.from(body));
      this.push(null);
    },
  });
  Object.assign(req, {
    method,
    url,
    headers: { host: 'localhost:4173', ...headers },
    socket: { remoteAddress: peer },
  });
  const res = {
    statusCode: 200,
    headers: {},
    setHeader(key, value) {
      this.headers[key.toLowerCase()] = value;
    },
    writeHead(status, values) {
      this.statusCode = status;
      for (const [key, value] of Object.entries(values))
        this.setHeader(key, value);
    },
    end(value) {
      this.body = value;
    },
  };
  await route(req, res);
  return { ...res, reads };
}

for (const hook of ['configureServer', 'configurePreviewServer']) {
  test(`${hook}: cross-site requests are rejected before consuming a body or fetching`, async (t) => {
    t.mock.method(globalThis, 'fetch', () =>
      assert.fail('unexpected upstream fetch'),
    );
    const route = handler(hook);
    for (const headers of [
      { origin: 'https://foreign.example', 'content-type': 'text/plain' },
      { 'sec-fetch-site': 'cross-site' },
      { 'sec-fetch-site': 'same-site' },
      { origin: 'null' },
      { 'x-forwarded-for': '127.0.0.1' },
    ]) {
      const response = await call(route, { headers, forbidRead: true });
      assert.equal(response.statusCode, 403);
      assert.equal(response.reads, 0);
      assert.equal(response.headers['cache-control'], 'no-store');
    }
  });
}

test('same-origin, LAN and non-browser requests still reach validation; GET status stays available', async () => {
  const route = handler();
  for (const headers of [
    {},
    { origin: 'http://localhost:4173', 'sec-fetch-site': 'same-origin' },
    { host: '192.168.1.10:4173', origin: 'http://192.168.1.10:4173' },
  ]) {
    const response = await call(route, { headers });
    assert.equal(response.statusCode, 400);
    assert.equal(response.reads, 1);
    assert.match(response.body, /Malformed Overpass tag filter/);
  }
  const response = await call(route, {
    method: 'GET',
    url: '/status',
    forbidRead: true,
  });
  assert.equal(response.statusCode, 200);
  assert.equal(typeof JSON.parse(response.body).configured, 'boolean');
});

test('invalid requests spend admission quota before parsing, including on an unconfigured server', async (t) => {
  let now = Date.now() + 120000;
  t.mock.method(Date, 'now', () => now);
  t.mock.method(globalThis, 'fetch', () =>
    assert.fail('unexpected upstream fetch'),
  );
  const route = handler();
  const peer = 'admission-limit-test';
  for (let i = 0; i < 300; i++) {
    assert.equal((await call(route, { peer })).statusCode, 400);
  }
  const denied = await call(route, { peer, forbidRead: true });
  assert.equal(denied.statusCode, 429);
  assert.equal(denied.reads, 0);
  assert.equal(denied.headers['retry-after'], '60');
  assert.equal((await call(route, { peer: 'other-peer' })).statusCode, 400);
  now += 60001;
  assert.equal((await call(route, { peer })).statusCode, 400);
});
