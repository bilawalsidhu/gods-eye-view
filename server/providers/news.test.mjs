import test from 'node:test';
import assert from 'node:assert/strict';
import { newsOrigin, newsProxy } from './news.js';
import { createKeyedNews } from './news/keyed.js';

/** Mount the proxy on a fake middleware stack and call it like Connect does. */
function mount(options) {
  let handler = null;
  newsProxy(options).configureServer({
    middlewares: {
      use(prefix, fn) {
        assert.equal(prefix, '/api/news');
        handler = fn;
      },
    },
  });
  return async (url, method = 'GET', headers = {}) => {
    const res = {
      destroyed: false,
      status: 0,
      headers: {},
      body: '',
      writeHead(status, headers) {
        this.status = status;
        this.headers = headers;
      },
      setHeader(name, value) {
        this.headers[name] = value;
      },
      end(body) {
        if (this.statusCode) this.status = this.statusCode;
        this.body = body;
      },
    };
    await handler({ url, method, headers }, res);
    return { ...res, json: res.body ? JSON.parse(res.body) : null };
  };
}

test('the origin must be a plain http(s) origin', () => {
  assert.equal(
    newsOrigin('http://news.example:8080'),
    'http://news.example:8080',
  );
  assert.equal(
    newsOrigin('https://news.example/base/'),
    'https://news.example',
  );
  for (const bad of [
    undefined,
    '',
    '  ',
    'ftp://x',
    'http://u:p@x',
    'http://x/?a=1',
    'http://x/#f',
    'not a url',
  ])
    assert.equal(newsOrigin(bad), null, String(bad));
});

test('without GEV_NEWS_ORIGIN Core answers itself: Conflicts from GDELT, Local saying it needs its key', async () => {
  const hosts = [];
  const fetchImpl = async (url) => {
    hosts.push(new URL(String(url)).host);
    throw new Error('offline');
  };
  const call = mount({
    origin: () => null,
    fetchImpl,
    keyed: createKeyedNews({ env: () => ({}), fetchImpl, log: () => {} }),
  });
  // GDELT's exports need no key; offline, the read fails like any upstream.
  const hotspots = await call('/hotspots');
  assert.equal(hotspots.status, 502);
  assert.deepEqual(hotspots.json, { error: 'news_upstream_error' });
  const local = await call('/feed?hotspot=all&at=31.95,35.93');
  assert.equal(local.status, 503);
  assert.deepEqual(local.json, { error: 'no_key', key: 'worldnewsapi' });
  // The area is read from the bundled countries, with no key.
  const area = await call('/outline?at=31.95,35.93&v=4');
  assert.equal(area.status, 200);
  assert.equal(area.json.area.name, 'Jordan');
  // The client's allowlist still holds.
  assert.equal((await call('/feed?side=UA')).status, 400);
  assert.ok(hosts.length > 0);
  assert.ok(hosts.every((host) => host === 'data.gdeltproject.org'));
});

test('forwards only the client routes, by GET, and relays the JSON', async () => {
  const calls = [];
  const call = mount({
    origin: () => 'https://news.example',
    fetchImpl: async (url, init) => {
      calls.push({ url: String(url), init });
      return new Response('{"reports":[],"nextBefore":null}', { status: 200 });
    },
  });
  const ok = await call('/feed?hotspot=all&limit=60&today=1&events=1');
  assert.equal(ok.status, 200);
  assert.deepEqual(ok.json, { reports: [], nextBefore: null });
  assert.equal(ok.headers['Cache-Control'], 'no-store');
  assert.equal(
    calls[0].url,
    'https://news.example/api/news/feed?hotspot=all&limit=60&today=1&events=1',
  );
  assert.equal(calls[0].init.redirect, 'error');
  assert.ok(calls[0].init.signal instanceof AbortSignal);

  for (const url of [
    '/air-alerts',
    '/feed?side=UA',
    '/feed?limit=9999',
    '/../admin',
    '/hotspots?x=1',
  ]) {
    const refused = await call(url);
    assert.equal(refused.status, 400, url);
  }
  const post = await call('/hotspots', 'POST');
  assert.equal(post.status, 405);
  assert.equal(post.headers.Allow, 'GET');
  assert.equal(calls.length, 1);
});

test('upstream failures, bad JSON and timeouts become bounded errors', async () => {
  const failing = mount({
    origin: () => 'https://news.example',
    fetchImpl: async () => new Response('down', { status: 500 }),
  });
  const down = await failing('/hotspots');
  assert.equal(down.status, 502);
  assert.deepEqual(down.json, { error: 'news_upstream_error', status: 500 });

  const garbled = mount({
    origin: () => 'https://news.example',
    fetchImpl: async () => new Response('<html>', { status: 200 }),
  });
  assert.equal((await garbled('/hotspots')).status, 502);

  const slow = mount({
    origin: () => 'https://news.example',
    timeoutMs: 10,
    // AbortSignal.timeout does not hold the event loop open: the hanging
    // fetch does, until its signal aborts, so the run cannot end before it.
    fetchImpl: (_url, { signal }) =>
      new Promise((_, reject) => {
        const alive = setTimeout(() => {}, 60_000);
        signal.addEventListener('abort', () => {
          clearTimeout(alive);
          reject(signal.reason);
        });
      }),
  });
  const timedOut = await slow('/hotspots');
  assert.equal(timedOut.status, 504);
  assert.deepEqual(timedOut.json, { error: 'news_unavailable' });
});

test('a GEV_NEWS_ORIGIN that is no plain origin is warned of once, and Core answers itself', async () => {
  const logs = [];
  const asked = [];
  const call = mount({
    env: () => ({ GEV_NEWS_ORIGIN: 'https://user:secret@news.example' }),
    log: (line) => logs.push(line),
    fetchImpl: async () => assert.fail('nothing is forwarded'),
    keyed: {
      answer: async (path) => {
        asked.push(path);
        return { status: 200, body: { reports: [], nextBefore: null } };
      },
    },
  });
  assert.equal((await call('/feed?hotspot=all')).status, 200);
  assert.equal((await call('/feed?hotspot=all')).status, 200);
  assert.deepEqual(asked, ['/feed', '/feed']);
  assert.equal(logs.length, 1);
  assert.doesNotMatch(logs[0], /secret|news\.example/);
});

test('a built-in answer that throws is a 502, logged in one line without addresses', async () => {
  const logs = [];
  const call = mount({
    env: () => ({}),
    log: (line) => logs.push(line),
    keyed: {
      answer: async () => {
        throw new TypeError('bad https://api.example/?key=abc\nmore');
      },
    },
  });
  const failed = await call('/hotspots');
  assert.equal(failed.status, 502);
  assert.deepEqual(failed.json, { error: 'news_unavailable' });
  assert.equal(logs.length, 1);
  assert.match(logs[0], /TypeError/);
  assert.doesNotMatch(logs[0], /key=abc|\n/);
});

test('a host that serves news only from its own server turns the built-in backend off', async () => {
  let fetches = 0;
  const call = mount({
    origin: () => null,
    builtIn: false,
    fetchImpl: async () => {
      fetches++;
      throw new Error('unexpected');
    },
  });
  for (const url of [
    '/hotspots',
    '/feed?hotspot=all',
    '/outline?at=31.95,35.93&v=4',
  ]) {
    const answer = await call(url);
    assert.equal(answer.status, 503, url);
    assert.deepEqual(answer.json, {
      error: 'news_not_configured',
      unavailable: true,
      retryable: false,
    });
  }
  assert.equal(fetches, 0);
});

test('a request line that is no URL is a 400, not a crash', async () => {
  const call = mount({
    origin: () => null,
    keyed: { answer: async () => assert.fail('nothing is answered') },
  });
  // `GET /api/news//[`: Connect strips the mount prefix and leaves `//[`.
  const bad = await call('//[');
  assert.equal(bad.status, 400);
  assert.deepEqual(bad.json, { error: 'invalid_news_request' });
});

test('cross-site and proxied requests are refused before anything is read', async () => {
  let answered = 0;
  const call = mount({
    origin: () => null,
    keyed: {
      answer: async () => {
        answered++;
        return { status: 200, body: { reports: [], nextBefore: null } };
      },
    },
  });
  const host = 'localhost:5173';
  for (const headers of [
    { host, origin: 'https://evil.example' },
    { host, origin: 'null' },
    { host, 'sec-fetch-site': 'cross-site' },
    { host, 'x-forwarded-for': '203.0.113.9' },
  ]) {
    const refused = await call('/feed?hotspot=all', 'GET', headers);
    assert.equal(refused.status, 403, JSON.stringify(headers));
  }
  assert.equal(answered, 0);
  for (const headers of [
    { host },
    { host, origin: `http://${host}`, 'sec-fetch-site': 'same-origin' },
  ]) {
    const passed = await call('/feed?hotspot=all', 'GET', headers);
    assert.equal(passed.status, 200, JSON.stringify(headers));
  }
  assert.equal(answered, 2);
});

test("a news server's key and configuration states are relayed as they are", async () => {
  for (const body of [
    { error: 'no_key', key: 'worldnewsapi' },
    { error: 'key_rejected', key: 'worldnewsapi' },
    { error: 'key_quota', key: 'worldnewsapi' },
    { error: 'news_not_configured', unavailable: true, retryable: false },
  ]) {
    const call = mount({
      origin: () => 'https://news.example',
      fetchImpl: async () =>
        new Response(JSON.stringify(body), { status: 503 }),
    });
    const relayed = await call('/feed?hotspot=all&at=31.95,35.93');
    assert.equal(relayed.status, 503, body.error);
    assert.deepEqual(relayed.json, body);
  }
  // Any other 503 stays a bounded upstream error.
  const other = mount({
    origin: () => 'https://news.example',
    fetchImpl: async () =>
      new Response('{"error":"maintenance","detail":"x"}', { status: 503 }),
  });
  const down = await other('/hotspots');
  assert.equal(down.status, 502);
  assert.deepEqual(down.json, { error: 'news_upstream_error', status: 503 });
});
