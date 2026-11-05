import test from 'node:test';
import assert from 'node:assert/strict';
import { newsOrigin, newsProxy } from './news.js';

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
  return async (url, method = 'GET') => {
    const res = {
      destroyed: false,
      status: 0,
      headers: {},
      body: '',
      writeHead(status, headers) {
        this.status = status;
        this.headers = headers;
      },
      end(body) {
        this.body = body;
      },
    };
    await handler({ url, method }, res);
    return { ...res, json: res.body ? JSON.parse(res.body) : null };
  };
}

test('the origin must be a plain http(s) origin', () => {
  assert.equal(newsOrigin('https://news.example'), 'https://news.example');
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

test('without GEV_NEWS_ORIGIN every route answers not configured and nothing is fetched', async () => {
  let fetches = 0;
  const call = mount({
    origin: () => null,
    fetchImpl: async () => {
      fetches++;
      throw new Error('unexpected');
    },
  });
  const response = await call('/hotspots');
  assert.equal(response.status, 503);
  assert.deepEqual(response.json, {
    error: 'news_not_configured',
    unavailable: true,
    retryable: false,
  });
  assert.equal(fetches, 0);
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
    fetchImpl: (_url, { signal }) =>
      new Promise((_, reject) =>
        signal.addEventListener('abort', () => reject(signal.reason)),
      ),
  });
  const timedOut = await slow('/hotspots');
  assert.equal(timedOut.status, 504);
  assert.deepEqual(timedOut.json, { error: 'news_unavailable' });
});
