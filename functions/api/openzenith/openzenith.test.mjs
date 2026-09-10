import test from 'node:test';
import assert from 'node:assert/strict';

// Co-located tests cannot carry the Function's bracketed filename (`node
// --test` silently glob-misses `[[path]].test.mjs`), so this file is the
// plain-named convention shared by every Pages Function here. The handler is
// imported directly — the [[path]].js wrapper adds nothing but `onRequest`.
const { handleOpenZenithRequest, resetOpenZenithCacheForTest } = await import('./_handler.js');

const ELEVATION_OK = JSON.stringify({
  requestId: 'oz-test', elevation: 149, surface_type: 'land', unit: 'meters',
  location: { lat: 30.2, lon: -97.7 }, source: 'ozt2', tile: '',
  resolution: 30, ok: true,
});

function call({ url = 'https://x.dev/api/openzenith/elevation?lat=30.2&lon=-97.7', method = 'GET', env = {} } = {}) {
  return handleOpenZenithRequest(new Request(url, { method }), env);
}

// The answer cache is module state; every test starts cold.
test.beforeEach(() => resetOpenZenithCacheForTest());

test('non-GET is a 405 with the shared shape', async () => {
  const res = await call({ method: 'POST' });
  assert.equal(res.status, 405);
  assert.deepEqual(await res.json(), { error: 'Method not allowed' });
});

test('unknown kinds are a 404 — the proxy is an allowlist, never an open forwarder', async () => {
  const res = await call({ url: 'https://x.dev/api/openzenith/weather?lat=1&lon=2' });
  assert.equal(res.status, 404);
  assert.deepEqual(await res.json(), { error: 'not found' });

  // A path-traversal or absolute-URL kind can never become the upstream path.
  const sneaky = await call({ url: 'https://x.dev/api/openzenith/%2e%2e%2fadmin?lat=1&lon=2' });
  assert.equal(sneaky.status, 404);
});

test('missing or non-numeric coordinates are validated locally, never forwarded', async () => {
  for (const url of [
    'https://x.dev/api/openzenith/elevation',
    'https://x.dev/api/openzenith/elevation?lat=abc&lon=3',
    'https://x.dev/api/openzenith/reverse-geocode?lat=30.2',
    'https://x.dev/api/openzenith/geocode',
    'https://x.dev/api/openzenith/geocode?query=%20%20',
  ]) {
    const res = await call({ url });
    assert.equal(res.status, 400, url);
    const body = await res.json();
    assert.ok(body.error, `expected an error message for ${url}`);
  }
});

test('elevation is fetched once and then served from the cache tier', async (t) => {
  let upstreamHits = 0;
  const realFetch = globalThis.fetch;
  t.after(() => { globalThis.fetch = realFetch; });
  globalThis.fetch = async () => {
    upstreamHits += 1;
    return new Response(ELEVATION_OK, { status: 200, headers: { 'content-type': 'application/json' } });
  };

  const first = await call();
  assert.equal(first.status, 200);
  assert.equal(first.headers.get('X-GEV-OpenZenith-Cache'), 'MISS');
  assert.equal(first.headers.get('Cache-Control'), 'public, max-age=300');
  assert.deepEqual(await first.json(), JSON.parse(ELEVATION_OK));

  const second = await call();
  assert.equal(second.headers.get('X-GEV-OpenZenith-Cache'), 'HIT');
  assert.equal(upstreamHits, 1, 'the second caller costs the upstream nothing');
});

test('an upstream failure with no entry is an honest 502', async (t) => {
  let upstreamHits = 0;
  const realFetch = globalThis.fetch;
  t.after(() => { globalThis.fetch = realFetch; });
  globalThis.fetch = async () => {
    upstreamHits += 1;
    throw new Error('down');
  };
  const res = await call({ url: 'https://x.dev/api/openzenith/elevation?lat=1&lon=2' });
  assert.equal(res.status, 502);
  assert.deepEqual(await res.json(), { error: 'OpenZenith unavailable' });
  assert.equal(upstreamHits, 1);
});

test('upstream HTTP errors are forwarded but NOT cached, so a retry re-fetches', async (t) => {
  let upstreamHits = 0;
  const realFetch = globalThis.fetch;
  t.after(() => { globalThis.fetch = realFetch; });
  globalThis.fetch = async () => {
    upstreamHits += 1;
    return new Response('{"ok":false,"error":{"code":"UPSTREAM","message":"boom"}}', {
      status: 503,
      headers: { 'content-type': 'application/json' },
    });
  };
  const url = 'https://x.dev/api/openzenith/elevation?lat=5&lon=6';
  const first = await call({ url });
  assert.equal(first.status, 503);
  assert.equal(first.headers.get('Cache-Control'), 'no-store');
  const second = await call({ url });
  assert.equal(second.status, 503);
  assert.equal(second.headers.get('X-GEV-OpenZenith-Cache'), 'MISS', 'a 503 is never frozen into the cache');
  assert.equal(upstreamHits, 2);
});

test('the same lat/lon under different parameter spellings still share one cache entry', async (t) => {
  let upstreamHits = 0;
  const realFetch = globalThis.fetch;
  t.after(() => { globalThis.fetch = realFetch; });
  globalThis.fetch = async () => {
    upstreamHits += 1;
    return new Response(ELEVATION_OK, { status: 200 });
  };
  await call({ url: 'https://x.dev/api/openzenith/elevation?lon=-97.7&lat=30.2' });
  await call({ url: 'https://x.dev/api/openzenith/elevation?lat=30.2&lon=-97.7' });
  assert.equal(upstreamHits, 1, 'canonicalized params make cache keys order-insensitive');
});

test('a geocode query is bounded and forwarded verbatim to the allowed kind', async (t) => {
  let seen = null;
  const realFetch = globalThis.fetch;
  t.after(() => { globalThis.fetch = realFetch; });
  globalThis.fetch = async (url) => {
    seen = String(url);
    return new Response('{"results":[],"count":0}', { status: 200 });
  };
  const res = await call({ url: 'https://x.dev/api/openzenith/geocode?query=Austin%20Tower' });
  assert.equal(res.status, 200);
  assert.ok(seen.endsWith('/api/geocode?query=Austin+Tower'), seen);
});

test('an oversized geocode query is refused before the network', async (t) => {
  let called = false;
  const realFetch = globalThis.fetch;
  t.after(() => { globalThis.fetch = realFetch; });
  globalThis.fetch = async () => { called = true; return new Response('{}', { status: 200 }); };
  const long = 'a'.repeat(201);
  const res = await call({ url: `https://x.dev/api/openzenith/geocode?query=${long}` });
  assert.equal(res.status, 400);
  assert.equal(called, false);
});
