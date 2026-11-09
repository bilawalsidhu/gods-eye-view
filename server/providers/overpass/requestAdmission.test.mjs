import test from 'node:test';
import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import { spawnSync } from 'node:child_process';
import { overpassProxy } from '../overpass.js';
import { _overpassCache } from './cache.js';
import { sanitizeOverpassBody } from './query.js';

const form = (query) => `data=${encodeURIComponent(query)}`;

// The limiters are module-level, so every test that spends admission mocks a
// clock a full day past the previous one in execution order: no test can see
// another's window, whatever order (or randomization) they run in. A new
// test that reaches admission must call it too: earlier tests leave
// timestamps days ahead of the real clock, and those still count.
let clockBase = Date.now() + 86_400_000;
function freshClock(t) {
  clockBase += 86_400_000;
  const clock = { now: clockBase };
  t.mock.method(Date, 'now', () => clock.now);
  return clock;
}

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
  // Whitespace inside the directive is clamped too, not passed through.
  const spaced = sanitizeOverpassBody(
    form('[out:json][ timeout : 999 ];node(around:20,1,1);out;'),
  );
  assert.equal(spaced.ok, true);
  assert.equal(
    new URLSearchParams(spaced.body).get('data'),
    '[out:json][timeout:30];node(around:20,1,1);out;',
  );
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
      // Forwarding headers do not launder a cross-site request.
      { 'x-forwarded-for': '10.0.0.9', 'sec-fetch-site': 'cross-site' },
      {
        'x-forwarded-proto': 'https',
        origin: 'http://localhost:4173',
        'sec-fetch-site': 'same-origin',
      },
    ]) {
      const response = await call(route, { headers, forbidRead: true });
      assert.equal(response.statusCode, 403);
      assert.equal(response.reads, 0);
      assert.equal(response.headers['cache-control'], 'no-store');
    }
  });
}

test('same-origin, LAN, proxied and non-browser requests still reach validation; GET status stays available', async (t) => {
  freshClock(t);
  const route = handler();
  for (const headers of [
    {},
    { origin: 'http://localhost:4173', 'sec-fetch-site': 'same-origin' },
    { host: '192.168.1.10:4173', origin: 'http://192.168.1.10:4173' },
    // The README's reverse-proxy deployment: Overpass is keyless, so the
    // forwarding headers the proxy adds are admitted (as for terrain heights).
    {
      host: 'globe.example.lan',
      origin: 'https://globe.example.lan',
      'sec-fetch-site': 'same-origin',
      'x-forwarded-for': '203.0.113.7',
      'x-forwarded-proto': 'https',
      'x-forwarded-host': 'globe.example.lan',
    },
    { 'x-forwarded-for': '127.0.0.1' },
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
  const clock = freshClock(t);
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
  clock.now += 60_001;
  assert.equal((await call(route, { peer })).statusCode, 400);
});

test('the 900/min global window spans non-loopback peers only; loopback keeps its own window', async (t) => {
  const clock = freshClock(t);
  t.mock.method(globalThis, 'fetch', () =>
    assert.fail('unexpected upstream fetch'),
  );
  const route = handler();
  for (const peer of ['10.0.0.1', '10.0.0.2', '10.0.0.3']) {
    for (let i = 0; i < 300; i++) {
      assert.equal((await call(route, { peer })).statusCode, 400, peer);
    }
  }
  const starved = await call(route, { peer: '10.0.0.4', forbidRead: true });
  assert.equal(starved.statusCode, 429, 'global window is full for LAN peers');
  assert.equal(starved.reads, 0);
  for (const peer of ['127.0.0.1', '::1', '::ffff:127.0.0.1']) {
    const owner = await call(route, { peer });
    assert.equal(owner.statusCode, 400, `${peer} is admitted past the global`);
    assert.equal(owner.reads, 1);
  }
  clock.now += 60_001;
  assert.equal((await call(route, { peer: '10.0.0.4' })).statusCode, 400);
});

test('IPv6 peers share a /64 admission bucket and IPv4-mapped peers fold to IPv4', async (t) => {
  const clock = freshClock(t);
  t.mock.method(globalThis, 'fetch', () =>
    assert.fail('unexpected upstream fetch'),
  );
  const route = handler();
  for (let i = 0; i < 300; i++) {
    assert.equal(
      (await call(route, { peer: `2001:db8:1:2::${(i % 200) + 1}` }))
        .statusCode,
      400,
    );
  }
  const rotated = await call(route, {
    peer: '2001:db8:1:2:ffff:ffff:ffff:9',
    forbidRead: true,
  });
  assert.equal(rotated.statusCode, 429, 'a rotating host stays in one bucket');
  assert.equal(
    (await call(route, { peer: '2001:db8:1:3::1' })).statusCode,
    400,
  );
  for (let i = 0; i < 300; i++) {
    assert.equal(
      (await call(route, { peer: '::ffff:10.1.1.1' })).statusCode,
      400,
    );
  }
  const unmapped = await call(route, { peer: '10.1.1.1', forbidRead: true });
  assert.equal(unmapped.statusCode, 429, 'mapped and bare IPv4 share a bucket');
  clock.now += 60_001;
  assert.equal((await call(route, { peer: '10.1.1.1' })).statusCode, 400);
});

test('cache hits spend admission budget but not the 90/min upstream budget', async (t) => {
  const clock = freshClock(t);
  const prior = process.env.OVERPASS_UPSTREAMS;
  process.env.OVERPASS_UPSTREAMS = 'https://overpass.example/api/interpreter';
  t.after(() => {
    if (prior === undefined) delete process.env.OVERPASS_UPSTREAMS;
    else process.env.OVERPASS_UPSTREAMS = prior;
    _overpassCache.delete(hitKey);
  });
  let fetches = 0;
  t.mock.method(globalThis, 'fetch', async () => {
    fetches++;
    // Not data: nothing is cached or written to disk by this test.
    return new Response('upstream unavailable', { status: 503 });
  });
  const hit = 'node(around:20,1,1);out;';
  const hitKey = `data=${encodeURIComponent(hit)}`;
  _overpassCache.set(hitKey, {
    status: 200,
    body: '{"elements":[]}',
    contentType: 'application/json',
    endpoint: 'https://overpass.example/api/interpreter',
    cachedAt: clock.now,
  });
  const route = handler();
  const peer = '10.7.7.7';
  // More cache hits than the upstream limiter would allow per peer.
  for (let i = 0; i < 100; i++) {
    const response = await call(route, { peer, body: form(hit) });
    assert.equal(response.statusCode, 200);
    assert.equal(response.headers['x-overpass-cache'], 'HIT');
  }
  assert.equal(fetches, 0);
  const miss = await call(route, {
    peer,
    body: form('node(around:20,2,2);out;'),
  });
  assert.equal(fetches, 1, 'the first miss still reaches upstream');
  assert.notEqual(miss.statusCode, 429);
  for (let i = 0; i < 199; i++) {
    assert.equal(
      (await call(route, { peer, body: form(hit) })).statusCode,
      200,
    );
  }
  const exhausted = await call(route, {
    peer,
    body: form(hit),
    forbidRead: true,
  });
  assert.equal(exhausted.statusCode, 429, 'hits spent the admission window');
  assert.equal(exhausted.reads, 0);
});

test('a local reverse proxy cannot spend the direct-loopback reserve; owner cache hits survive it', async (t) => {
  const clock = freshClock(t);
  const prior = process.env.OVERPASS_UPSTREAMS;
  process.env.OVERPASS_UPSTREAMS = 'https://overpass.example/api/interpreter';
  const hit = 'node(around:20,3,3);out;';
  const hitKey = `data=${encodeURIComponent(hit)}`;
  t.after(() => {
    if (prior === undefined) delete process.env.OVERPASS_UPSTREAMS;
    else process.env.OVERPASS_UPSTREAMS = prior;
    _overpassCache.delete(hitKey);
  });
  t.mock.method(globalThis, 'fetch', () =>
    assert.fail('unexpected upstream fetch'),
  );
  _overpassCache.set(hitKey, {
    status: 200,
    body: '{"elements":[]}',
    contentType: 'application/json',
    endpoint: 'https://overpass.example/api/interpreter',
    cachedAt: clock.now,
  });
  const route = handler();
  // The proxy connects over loopback; a rotating forwarded client address
  // must not mint fresh buckets, so all 300 land in one socket-keyed bucket.
  for (const proxyPeer of ['127.0.0.1', '::1', '::ffff:127.0.0.1']) {
    const proxied = (i) => ({
      peer: proxyPeer,
      headers: { 'x-forwarded-for': `203.0.113.${i % 250}` },
      body: form(hit),
    });
    for (let i = 0; i < 300; i++) {
      assert.equal((await call(route, proxied(i))).statusCode, 200, proxyPeer);
    }
    const refused = await call(route, { ...proxied(300), forbidRead: true });
    assert.equal(refused.statusCode, 429, `${proxyPeer} proxy bucket is full`);
    assert.equal(refused.reads, 0);
    for (const peer of ['127.0.0.1', '::1']) {
      const owner = await call(route, { peer, body: form(hit) });
      assert.equal(owner.statusCode, 200, `direct ${peer} is still admitted`);
      assert.equal(owner.headers['x-overpass-cache'], 'HIT');
    }
    clock.now += 60_001;
    assert.equal((await call(route, proxied(0))).statusCode, 200);
  }
});

test('proxied loopback traffic draws on the shared remote global window', async (t) => {
  const clock = freshClock(t);
  t.mock.method(globalThis, 'fetch', () =>
    assert.fail('unexpected upstream fetch'),
  );
  const route = handler();
  for (const peer of ['10.0.0.1', '10.0.0.2']) {
    for (let i = 0; i < 300; i++) {
      assert.equal((await call(route, { peer })).statusCode, 400, peer);
    }
  }
  for (let i = 0; i < 300; i++) {
    assert.equal(
      (await call(route, { headers: { via: '1.1 proxy' } })).statusCode,
      400,
    );
  }
  const starved = await call(route, { peer: '10.0.0.3', forbidRead: true });
  assert.equal(starved.statusCode, 429, 'proxied requests counted globally');
  assert.equal((await call(route, {})).statusCode, 400, 'owner unaffected');
});

test("a local proxy has its own upstream bucket, so its misses cannot spend the owner's", async (t) => {
  freshClock(t);
  const prior = process.env.OVERPASS_UPSTREAMS;
  process.env.OVERPASS_UPSTREAMS = 'https://overpass.example/api/interpreter';
  t.after(() => {
    if (prior === undefined) delete process.env.OVERPASS_UPSTREAMS;
    else process.env.OVERPASS_UPSTREAMS = prior;
  });
  // Not data: nothing is cached, so every request below is a miss.
  t.mock.method(
    globalThis,
    'fetch',
    async () => new Response('upstream unavailable', { status: 503 }),
  );
  const route = handler();
  const miss = form('node(around:20,4,4);out;');
  // The upstream limiter's own refusal is the only miss without this header.
  const passedLimiter = (response) =>
    response.headers['x-overpass-cache'] !== undefined;
  const proxied = { peer: '127.0.0.1', headers: { via: '1.1 proxy' } };
  for (let i = 0; i < 90; i++) {
    const response = await call(route, { ...proxied, body: miss });
    assert.equal(passedLimiter(response), true, `proxied miss ${i}`);
  }
  const spent = await call(route, { ...proxied, body: miss });
  assert.equal(spent.statusCode, 429);
  assert.equal(passedLimiter(spent), false, 'the proxy bucket is spent');
  const owner = await call(route, { peer: '127.0.0.1', body: miss });
  assert.equal(passedLimiter(owner), true, 'the owner keeps its own bucket');
});
