import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fsp } from 'node:fs';
import {
  fireballsProxy,
  FIREBALL_CACHE_TTL_MS,
} from 'gods-eye-view/server/providers/space';

const BODY = JSON.stringify({ fields: ['date', 'energy'], data: [] });

function install(plugin) {
  const routes = new Map();
  plugin.configureServer({
    middlewares: {
      use(route, handler) {
        routes.set(route, handler);
      },
    },
  });
  return async (method = 'GET') => {
    const res = {
      headersSent: false,
      writeHead(status, headers) {
        Object.assign(this, { status, headers, headersSent: true });
      },
      end(body) {
        this.body = body;
      },
    };
    await routes.get('/api/fireballs')({ url: '/', method }, res);
    return res;
  };
}

function isolate(t) {
  t.mock.method(fsp, 'readFile', async () => {
    throw Error('no cache');
  });
  t.mock.method(fsp, 'stat', async () => {
    throw Error('no cache');
  });
  t.mock.method(fsp, 'mkdir', async () => {});
  t.mock.method(fsp, 'writeFile', async () => {});
  t.mock.method(console, 'warn', () => {});
}

test('the upstream request refuses redirects', async (t) => {
  isolate(t);
  let init;
  t.mock.method(globalThis, 'fetch', async (_url, options) => {
    init = options;
    return new Response(BODY, { status: 200 });
  });
  const res = await install(fireballsProxy())();
  assert.equal(res.status, 200);
  assert.equal(init.redirect, 'error');
});

test('a redirect, which fetch rejects under redirect:error, is a 502 with nothing cached', async (t) => {
  isolate(t);
  t.mock.method(globalThis, 'fetch', async () => {
    throw new TypeError('fetch failed: unexpected redirect');
  });
  const res = await install(fireballsProxy())();
  assert.equal(res.status, 502);
  assert.equal(res.headers['Cache-Control'], 'no-store');
  assert.deepEqual(JSON.parse(res.body), {
    error: 'NASA/JPL fireball API unavailable',
  });
});

test('upstream HTTP errors with no cache come back as 502, never the upstream status', async (t) => {
  isolate(t);
  for (const status of [503, 500, 404, 429]) {
    t.mock.method(
      globalThis,
      'fetch',
      async () => new Response('nope', { status }),
    );
    const res = await install(fireballsProxy())();
    assert.equal(res.status, 502, `upstream ${status}`);
    assert.equal(res.headers['Cache-Control'], 'no-store');
    assert.equal(res.headers['X-GEV-Cache'], 'NONE');
    globalThis.fetch.mock.restore();
  }
});

test('malformed upstream JSON is a 502 and is not cached', async (t) => {
  isolate(t);
  t.mock.method(
    globalThis,
    'fetch',
    async () => new Response('{"data": "not an array"}', { status: 200 }),
  );
  const call = install(fireballsProxy());
  assert.equal((await call()).status, 502);
  assert.equal((await call()).status, 502); // nothing was stored, so it asks again
});

test('a fresh answer is cacheable; a stale fallback after a failed refresh is not', async (t) => {
  isolate(t);
  let now = 1_000_000;
  t.mock.method(Date, 'now', () => now);
  let healthy = true;
  t.mock.method(globalThis, 'fetch', async () =>
    healthy
      ? new Response(BODY, { status: 200 })
      : new Response('down', { status: 503 }),
  );
  const call = install(fireballsProxy());

  const first = await call();
  assert.equal(first.status, 200);
  assert.equal(first.headers['X-GEV-Cache'], 'MISS');
  assert.equal(first.headers['Cache-Control'], 'public, max-age=1800');

  const hit = await call();
  assert.equal(hit.headers['X-GEV-Cache'], 'HIT');
  assert.equal(hit.headers['Cache-Control'], 'public, max-age=1800');

  now += FIREBALL_CACHE_TTL_MS + 1;
  healthy = false;
  const stale = await call();
  assert.equal(stale.status, 200);
  assert.equal(stale.body, BODY);
  assert.equal(stale.headers['X-GEV-Cache'], 'STALE-ERROR');
  assert.equal(stale.headers['Cache-Control'], 'no-store');

  healthy = true; // the next request must reach the recovered upstream, not a cached stale copy
  const recovered = await call();
  assert.equal(recovered.headers['X-GEV-Cache'], 'MISS');
  assert.equal(recovered.headers['Cache-Control'], 'public, max-age=1800');
});

test('only GET is accepted', async (t) => {
  isolate(t);
  t.mock.method(globalThis, 'fetch', async () => {
    throw Error('must not be called');
  });
  const res = await install(fireballsProxy())('POST');
  assert.equal(res.status, 405);
  assert.equal(res.headers['Cache-Control'], 'no-store');
});

test('the layer credit and data source say the data is not real-time and incomplete', async () => {
  const { readFileSync } = await import('node:fs');
  const credits = readFileSync(
    new URL('../data/dataCredits.js', import.meta.url),
    'utf8',
  );
  assert.match(credits, /Derived from U\.S\. Government sensor detections/);
  assert.match(credits, /not real-time, and not all fireballs are reported/);
  const sources = readFileSync(
    new URL('../../DATA_SOURCES.md', import.meta.url),
    'utf8',
  );
  assert.match(
    sources,
    /not provided in real-time and not all fireballs are reported/,
  );
  assert.match(sources, /Derived from U\.S\. Government sensor detections/);
});
