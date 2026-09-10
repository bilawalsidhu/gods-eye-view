import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import { onRequest, resetTomTomStateForTest, expireTomTomTileForTest } from './tomtom.js';

const url = (path = '') => `https://example.com/api/tomtom${path}`;
const ctx = (request, env = {}) => ({ request, env });

const TILE_PBF = new Uint8Array([0x1a, 0x2b, 0x3c, 0x4d]);

/** Replace global fetch; `impl` receives {url, init}. */
function stubFetch(impl) {
  const original = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (fetchUrl, init) => {
    const entry = { url: String(fetchUrl), init };
    calls.push(entry);
    return impl(entry);
  };
  return { calls, restore: () => { globalThis.fetch = original; } };
}

const TILE_OK = () => new Response(TILE_PBF, { status: 200 });

beforeEach(() => resetTomTomStateForTest());

test('OPTIONS answers 204 with CORS preflight headers', async () => {
  const res = await onRequest(ctx(new Request(url(), { method: 'OPTIONS' })));
  assert.equal(res.status, 204);
  assert.equal(res.headers.get('access-control-allow-origin'), '*');
});

test('non-GET gets the shared _lib 405 shape', async () => {
  const res = await onRequest(ctx(new Request(url('/flow/1/0/0.pbf'), { method: 'POST' })));
  assert.equal(res.status, 405);
  assert.deepEqual(await res.json(), { error: 'Method not allowed' });
});

test('status reports hasKey and the daily budget without touching upstream', async () => {
  const stub = stubFetch(() => { throw new Error('must not fetch'); });
  try {
    const res = await onRequest(ctx(new Request(url('/status')), { TOMTOM_API_KEY: 'k' }));
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { hasKey: true, dailyCount: 0, budget: 40000, date: new Date().toISOString().slice(0, 10) });
  } finally {
    stub.restore();
  }
});

test('unknown paths get the dev 404 shape', async () => {
  const res = await onRequest(ctx(new Request(url('/something-else'))));
  assert.equal(res.status, 404);
  assert.deepEqual(await res.json(), { error: 'not_found' });
});

test('out-of-range tiles are rejected with the dev 400 shape before any fetch', async () => {
  const stub = stubFetch(() => { throw new Error('must not fetch'); });
  try {
    for (const path of ['/flow/0/1/0.pbf', '/flow/26/0/0.pbf', '/flow/12/99999/0.pbf']) {
      const res = await onRequest(ctx(new Request(url(path))));
      assert.equal(res.status, 400, path);
      assert.deepEqual(await res.json(), { error: 'invalid_tile' }, path);
    }
    assert.equal(stub.calls.length, 0, 'no upstream call is ever built for an invalid tile');
  } finally {
    stub.restore();
  }
});

test('a valid tile is fetched from the explicit relative-flow path and cached', async () => {
  const stub = stubFetch(({ url: fetchUrl }) => {
    assert.equal(fetchUrl, 'https://api.tomtom.com/traffic/map/4/tile/flow/relative/12/1580/2413.pbf?key=tom-key');
    return TILE_OK();
  });
  try {
    const first = await onRequest(ctx(new Request(url('/flow/12/1580/2413.pbf')), { TOMTOM_API_KEY: 'tom-key' }));
    assert.equal(first.status, 200);
    assert.equal(first.headers.get('content-type'), 'application/x-protobuf');
    assert.equal(first.headers.get('x-tomtom-cache'), 'MISS');
    assert.equal(first.headers.get('cache-control'), 'no-store');
    assert.deepEqual(new Uint8Array(await first.arrayBuffer()), TILE_PBF);

    const second = await onRequest(ctx(new Request(url('/flow/12/1580/2413.pbf')), { TOMTOM_API_KEY: 'tom-key' }));
    assert.equal(second.headers.get('x-tomtom-cache'), 'HIT');
    assert.equal(stub.calls.length, 1, 'the second request within the TTL burns no upstream tile');

    const status = await (await onRequest(ctx(new Request(url('/status')), { TOMTOM_API_KEY: 'tom-key' }))).json();
    assert.equal(status.dailyCount, 1, 'exactly one billable upstream attempt is counted');
  } finally {
    stub.restore();
  }
});

test('missing key answers the dev 503 no_key shape without fetching', async () => {
  const stub = stubFetch(() => { throw new Error('must not fetch'); });
  try {
    const res = await onRequest(ctx(new Request(url('/flow/12/0/0.pbf'))));
    assert.equal(res.status, 503);
    assert.deepEqual(await res.json(), { error: 'no_key' });
    assert.equal(stub.calls.length, 0);
  } finally {
    stub.restore();
  }
});

test('upstream failure with no cached tile answers the dev 502 upstream shape', async () => {
  const stub = stubFetch(() => new Response('denied', { status: 403 }));
  try {
    const res = await onRequest(ctx(new Request(url('/flow/12/0/0.pbf')), { TOMTOM_API_KEY: 'k' }));
    assert.equal(res.status, 502);
    const text = await res.text();
    assert.deepEqual(JSON.parse(text), { error: 'upstream' });
    assert.equal(text.includes('k'), false, 'no key echo in the error body');
  } finally {
    stub.restore();
  }
});

test('an empty tile body counts as a failed fetch, not a tile', async () => {
  const stub = stubFetch(() => new Response(new Uint8Array(0), { status: 200 }));
  try {
    const res = await onRequest(ctx(new Request(url('/flow/12/0/0.pbf')), { TOMTOM_API_KEY: 'k' }));
    assert.equal(res.status, 502);
    assert.deepEqual(await res.json(), { error: 'upstream' });
  } finally {
    stub.restore();
  }
});

test('over the daily budget a fresh tile gets 429 and a stale tile is served', async () => {
  const env = { TOMTOM_API_KEY: 'k', TOMTOM_DAILY_TILE_BUDGET: '2' };
  const stub = stubFetch(() => TILE_OK());
  try {
    // Burn the budget of 2 on distinct valid tiles.
    for (const [z, x, y] of [[10, 100, 200], [10, 101, 200]]) {
      const res = await onRequest(ctx(new Request(url(`/flow/${z}/${x}/${y}.pbf`)), env));
      assert.equal(res.status, 200, `${z}/${x}/${y}`);
    }

    // A fresh-enough cached tile is still served over budget (the hit path
    // runs before the governor — a HIT never counts against the budget).
    const hit = await onRequest(ctx(new Request(url('/flow/10/100/200.pbf')), env));
    assert.equal(hit.headers.get('x-tomtom-cache'), 'HIT');

    // A tile with NO cached entry gets the dev 429 shape.
    const fresh = await onRequest(ctx(new Request(url('/flow/10/102/200.pbf')), env));
    assert.equal(fresh.status, 429);
    assert.deepEqual(await fresh.json(), { error: 'budget' });

    // Age a cached tile past the TTL → over budget it takes the stale path.
    expireTomTomTileForTest('10/100/200');
    const stale = await onRequest(ctx(new Request(url('/flow/10/100/200.pbf')), env));
    assert.equal(stale.status, 200, 'over budget, last-good data beats a dead layer');
    assert.equal(stale.headers.get('x-tomtom-cache'), 'STALE-BUDGET');
  } finally {
    stub.restore();
  }
});

test('the key never reaches any response body or header', async () => {
  const env = { TOMTOM_API_KEY: 'topsecret-tom-key' };
  const stub = stubFetch(() => TILE_OK());
  try {
    for (const path of ['/status', '/flow/12/0/0.pbf', '/flow/0/1/0.pbf', '/nope']) {
      const res = await onRequest(ctx(new Request(url(path)), env));
      const text = await res.clone().text();
      assert.equal(text.includes('topsecret-tom-key'), false, path);
      for (const [name, value] of res.headers.entries()) {
        assert.equal(value.includes('topsecret-tom-key'), false, `${path} header ${name}`);
      }
    }
  } finally {
    stub.restore();
  }
});
