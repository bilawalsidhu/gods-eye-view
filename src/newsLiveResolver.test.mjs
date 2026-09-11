// /api/news/live: input validation and live-page parsing, with fetch stubbed.
//
// Run with: npm test   (node --test)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { newsLiveResolver } from '../vite.config.js';

function installRoutes() {
  const routes = new Map();
  newsLiveResolver().configureServer({ middlewares: { use(path, handler) { routes.set(path, handler); } } });
  return routes.get('/api/news/live');
}

function invoke(handler, url) {
  return new Promise((resolve) => {
    const res = {
      statusCode: 200,
      setHeader() {},
      end(body) { resolve({ statusCode: this.statusCode, body: JSON.parse(String(body)) }); },
    };
    handler({ method: 'GET', url, headers: {}, socket: { remoteAddress: '127.0.0.1' } }, res);
  });
}

const LIVE_PAGE = `<html><head><title>LIVE: ABC News Live - YouTube</title>
<link rel="canonical" href="https://www.youtube.com/watch?v=MuBEsh9yyKg"></head>
<body>{"isLive":true,"isLiveContent":true}</body></html>`;

test('rejects anything that is not a YouTube channel id', async () => {
  const handler = installRoutes();
  const bad = await invoke(handler, '/api/news/live?channel=../etc/passwd');
  assert.equal(bad.statusCode, 400);
  const missing = await invoke(handler, '/api/news/live');
  assert.equal(missing.statusCode, 400);
});

test('resolves the current live video id from the channel live page and caches it', async (t) => {
  const handler = installRoutes();
  let calls = 0;
  const realFetch = globalThis.fetch;
  globalThis.fetch = async () => { calls += 1; return { text: async () => LIVE_PAGE }; };
  t.after(() => { globalThis.fetch = realFetch; });

  const first = await invoke(handler, '/api/news/live?channel=UCBi2mrWuNuyYy4gbM6fU18Q');
  assert.equal(first.statusCode, 200);
  assert.deepEqual(first.body, { channel: 'UCBi2mrWuNuyYy4gbM6fU18Q', videoId: 'MuBEsh9yyKg', isLive: true, title: 'LIVE: ABC News Live' });
  const second = await invoke(handler, '/api/news/live?channel=UCBi2mrWuNuyYy4gbM6fU18Q');
  assert.equal(second.body.videoId, 'MuBEsh9yyKg');
  assert.equal(calls, 1, 'second request served from cache');
});

test('reports an off-air channel without a video id', async (t) => {
  const handler = installRoutes();
  const realFetch = globalThis.fetch;
  globalThis.fetch = async () => ({ text: async () => '<html><head><title>Foo - YouTube</title></head></html>' });
  t.after(() => { globalThis.fetch = realFetch; });
  const res = await invoke(handler, '/api/news/live?channel=UCXIJgqnII2ZOINSWNOGFThA');
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.videoId, null);
  assert.equal(res.body.isLive, false);
});
