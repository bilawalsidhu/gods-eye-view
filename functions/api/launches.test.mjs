import test from 'node:test';
import assert from 'node:assert/strict';

import { onRequest, resetLaunchCacheForTest } from './launches.js';

const url = 'https://example.com/api/launches';
const ctx = (request, env = {}) => ({ request, env });

/** A minimal-but-real LL2 2.3.0 `detailed` document — passed through verbatim. */
const LL2 = JSON.stringify({
  count: 1,
  results: [{ id: 'launch-1', name: 'Falcon 9 | Starlink 10-14', status: 'success' }],
});

const ll2Response = () => new Response(LL2, { status: 200, headers: { 'content-length': String(LL2.length) } });

test('non-GET methods get the dev 405 shape without calling upstream', async () => {
  let calls = 0;
  const original = globalThis.fetch;
  globalThis.fetch = async () => { calls += 1; throw new Error('no'); };
  try {
    for (const method of ['POST', 'HEAD', 'DELETE']) {
      const res = await onRequest(ctx(new Request(url, { method })));
      assert.equal(res.status, 405, method);
      assert.deepEqual(await res.json(), { error: 'Method Not Allowed' }, 'dev capitalizes this one');
      assert.equal(res.headers.get('content-type'), 'application/json');
      assert.equal(res.headers.get('cache-control'), 'no-store');
      assert.equal(res.headers.get('x-gev-cache'), 'NONE');
    }
    assert.equal(calls, 0, 'a method guard rejection never reaches upstream');
  } finally {
    globalThis.fetch = original;
  }
});

test('an upstream HTTP status is forwarded verbatim with its body', async () => {
  resetLaunchCacheForTest();
  let captured;
  const original = globalThis.fetch;
  globalThis.fetch = async (fetchUrl, init) => {
    captured = { fetchUrl, init };
    return new Response('{"detail":"Request was throttled."}', { status: 429 });
  };
  try {
    const res = await onRequest(ctx(new Request(url)));
    assert.equal(res.status, 429, 'the client reads this status, so 429 must survive the proxy');
    assert.equal(await res.text(), '{"detail":"Request was throttled."}', 'upstream body passes through untouched');
    assert.equal(res.headers.get('cache-control'), 'no-store');
    assert.equal(res.headers.get('x-gev-cache'), 'NONE');

    assert.equal(captured.fetchUrl.origin + captured.fetchUrl.pathname, 'https://ll.thespacedevs.com/2.3.0/launches/');
    assert.equal(captured.init.headers.Accept, 'application/json');
    assert.equal(captured.init.headers.Authorization, undefined, 'no token env, no Authorization header');
    assert.ok(captured.init.signal instanceof AbortSignal, 'the upstream call is time-bounded');
  } finally {
    globalThis.fetch = original;
  }
});

test('a transport failure answers the dev 502 shape', async () => {
  resetLaunchCacheForTest();
  const original = globalThis.fetch;
  globalThis.fetch = async () => { throw new Error('connect ECONNREFUSED'); };
  try {
    const res = await onRequest(ctx(new Request(url)));
    assert.equal(res.status, 502);
    assert.deepEqual(await res.json(), { error: 'Launch Library 2 unavailable' });
    assert.equal(res.headers.get('x-gev-cache'), 'NONE');
  } finally {
    globalThis.fetch = original;
  }
});

test('a document without a results array is a 502, not a passthrough', async () => {
  resetLaunchCacheForTest();
  const original = globalThis.fetch;
  globalThis.fetch = async () => new Response('{"detail":"Not found."}', { status: 200 });
  try {
    const res = await onRequest(ctx(new Request(url)));
    assert.equal(res.status, 502);
    assert.deepEqual(await res.json(), { error: 'Launch Library 2 unavailable' });
  } finally {
    globalThis.fetch = original;
  }
});

test('a document over the 12 MB cap is refused before it is parsed', async () => {
  resetLaunchCacheForTest();
  const original = globalThis.fetch;
  // Declared content-length is enough — the dev reader short-circuits on it.
  globalThis.fetch = async () => new Response('truncated', {
    status: 200,
    headers: { 'content-length': String(12 * 1024 * 1024 + 1) },
  });
  try {
    const res = await onRequest(ctx(new Request(url)));
    assert.equal(res.status, 502);
    assert.deepEqual(await res.json(), { error: 'Launch Library 2 unavailable' });
  } finally {
    globalThis.fetch = original;
  }
});

test('a cold request fetches the 30-day detailed window and returns MISS', async () => {
  resetLaunchCacheForTest();
  let captured;
  const original = globalThis.fetch;
  globalThis.fetch = async (fetchUrl, init) => { captured = { fetchUrl, init }; return ll2Response(); };
  try {
    const res = await onRequest(ctx(new Request(url)));
    assert.equal(res.status, 200);
    assert.equal(await res.text(), LL2, 'the raw LL2 document is passed through for client normalization');
    assert.equal(res.headers.get('content-type'), 'application/json');
    assert.equal(res.headers.get('cache-control'), 'public, max-age=900');
    assert.equal(res.headers.get('x-gev-cache'), 'MISS');

    const q = captured.fetchUrl.searchParams;
    assert.equal(q.get('limit'), '100');
    assert.equal(q.get('mode'), 'detailed');
    const gte = new Date(q.get('net__gte'));
    const lte = new Date(q.get('net__lte'));
    assert.ok(!Number.isNaN(gte.getTime()) && !Number.isNaN(lte.getTime()), 'the window is two ISO timestamps');
    assert.equal(lte.getTime() - gte.getTime(), 30 * 86400000, 'exactly a 30-day lookback');
    assert.ok(lte.getTime() <= Date.now() + 1000, 'the window ends at now');
  } finally {
    globalThis.fetch = original;
  }
});

test('a warm request is served from the 15 min cache with HIT', async () => {
  let calls = 0;
  const original = globalThis.fetch;
  globalThis.fetch = async () => { calls += 1; return ll2Response(); };
  try {
    const res = await onRequest(ctx(new Request(url)));
    assert.equal(res.headers.get('x-gev-cache'), 'HIT');
    assert.equal(await res.text(), LL2);
    assert.equal(res.headers.get('cache-control'), 'public, max-age=900');
    assert.equal(calls, 0, 'nothing upstream within the TTL');
  } finally {
    globalThis.fetch = original;
  }
});

test('LL2_API_TOKEN rides the request as a Token credential', async () => {
  resetLaunchCacheForTest();
  let captured;
  const original = globalThis.fetch;
  globalThis.fetch = async (fetchUrl, init) => { captured = { init }; return ll2Response(); };
  try {
    const res = await onRequest(ctx(new Request(url), { LL2_API_TOKEN: ' ll2-secret ' }));
    assert.equal(res.headers.get('x-gev-cache'), 'MISS', 'the reset above forces a real refresh');
    assert.equal(captured.init.headers.Authorization, 'Token ll2-secret', 'trimmed, like the dev helper');
  } finally {
    globalThis.fetch = original;
  }
});

test('a failed refresh after the cache expires serves the stale document', async () => {
  const original = globalThis.fetch;
  const originalNow = Date.now;
  try {
    globalThis.fetch = async () => ll2Response();
    resetLaunchCacheForTest();
    assert.equal((await onRequest(ctx(new Request(url)))).headers.get('x-gev-cache'), 'MISS');

    // Push "now" past the 15 min TTL, then break upstream.
    Date.now = () => originalNow() + 16 * 60_000;
    globalThis.fetch = async () => { throw new Error('socket hang up'); };
    const stale = await onRequest(ctx(new Request(url)));
    assert.equal(stale.status, 200, 'last-good launches feed beats a dead layer');
    assert.equal(await stale.text(), LL2);
    assert.equal(stale.headers.get('x-gev-cache'), 'STALE-ERROR');
    assert.equal(stale.headers.get('cache-control'), 'public, max-age=900', 'it is a 200');
  } finally {
    Date.now = originalNow;
    globalThis.fetch = original;
  }
});

test('concurrent cold requests coalesce and the joiner is labelled INFLIGHT', async () => {
  resetLaunchCacheForTest();
  let calls = 0;
  const original = globalThis.fetch;
  globalThis.fetch = async () => {
    calls += 1;
    await new Promise((resolve) => setTimeout(resolve, 5));
    return ll2Response();
  };
  try {
    const [first, second] = await Promise.all([
      onRequest(ctx(new Request(url))),
      onRequest(ctx(new Request(url))),
    ]);
    assert.equal(calls, 1, 'one upstream refresh serves the whole burst');
    assert.equal(first.headers.get('x-gev-cache'), 'MISS');
    assert.equal(second.headers.get('x-gev-cache'), 'INFLIGHT');
    assert.equal(await second.text(), LL2);
  } finally {
    globalThis.fetch = original;
  }
});
