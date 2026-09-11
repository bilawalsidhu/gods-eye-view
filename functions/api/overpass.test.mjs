// Contract tests for the /api/overpass Pages Function (dev-parity with the
// `overpassProxy` middleware in vite.config.js). The sanitizer/transport
// semantics themselves are covered in src/data/overpassPolicy.js's siblings
// (overpassProxy.test.mjs); these tests pin the HTTP contract: method gating,
// body caps, sanitizer rejections, cache/coalescing headers, mirror
// fall-through, the degraded-vs-502 split, and the concurrency cap.
//
// Run with: npm test   (node --test)
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import { onRequest, resetOverpassStateForTest } from './overpass.js';

const url = 'https://example.com/api/overpass';
const ctx = (request) => ({ request });

const GOOD_QL = '[out:json][timeout:20];node(around:1200,30.27,-97.74)["leisure"]["name"];out;';
const goodBody = (ql = GOOD_QL) => `data=${encodeURIComponent(ql)}`;
const queryKey = (ql) => `data=${encodeURIComponent(ql)}`.replace(/\s+/g, ' ').trim();

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

/** Deferred fetch stub so tests can hold mirrors open (concurrency cap). */
function stubDeferredFetch() {
  const original = globalThis.fetch;
  const calls = [];
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  globalThis.fetch = async (fetchUrl, init) => {
    const entry = { url: String(fetchUrl), init };
    calls.push(entry);
    await gate;
    return Response.json({ elements: [] });
  };
  return {
    calls,
    release,
    restore: () => { globalThis.fetch = original; },
  };
}

beforeEach(() => resetOverpassStateForTest());

test('non-POST answers the dev 405 shape before any upstream work', async () => {
  const stub = stubFetch(() => { throw new Error('must not fetch'); });
  try {
    for (const method of ['GET', 'OPTIONS', 'DELETE']) {
      const res = await onRequest(ctx(new Request(url, { method })));
      assert.equal(res.status, 405, method);
      assert.deepEqual(await res.json(), { error: 'Method Not Allowed' });
    }
    assert.equal(stub.calls.length, 0);
  } finally {
    stub.restore();
  }
});

test('bodies past the 24 KB cap are refused with 413 before parsing', async () => {
  const stub = stubFetch(() => { throw new Error('must not fetch'); });
  try {
    const huge = `data=${encodeURIComponent(`[out:json];${'x'.repeat(25 * 1024)}`)}`;
    const res = await onRequest(ctx(new Request(url, { method: 'POST', body: huge })));
    assert.equal(res.status, 413);
    assert.deepEqual(await res.json(), { error: 'Overpass query too large' });
    assert.equal(stub.calls.length, 0);
  } finally {
    stub.restore();
  }
});

test('empty bodies and sanitizer rejections answer 400 with the dev messages', async () => {
  const stub = stubFetch(() => { throw new Error('must not fetch'); });
  try {
    const empty = await onRequest(ctx(new Request(url, { method: 'POST', body: '' })));
    assert.equal(empty.status, 400);
    assert.deepEqual(await empty.json(), { error: 'Missing Overpass query body' });

    const unbounded = await onRequest(ctx(new Request(url, {
      method: 'POST',
      body: `data=${encodeURIComponent('[out:json];way["highway"];out;' )}`,
    })));
    assert.equal(unbounded.status, 400);
    assert.deepEqual(await unbounded.json(), { error: 'Overpass query has an unbounded selector' });

    const world = await onRequest(ctx(new Request(url, {
      method: 'POST',
      body: `data=${encodeURIComponent('way(-90,-180,90,180)["highway"];out;')}`,
    })));
    assert.equal(world.status, 400);
    assert.deepEqual(await world.json(), { error: 'Overpass bbox too large' });
    assert.equal(stub.calls.length, 0, 'rejections must never reach a mirror');
  } finally {
    stub.restore();
  }
});

test('a valid query reaches the first mirror with the sanitized form body', async () => {
  const stub = stubFetch(() => Response.json({ elements: [{ type: 'way', id: 1 }] }));
  try {
    const res = await onRequest(ctx(new Request(url, { method: 'POST', body: goodBody() })));
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('x-overpass-cache'), 'MISS');
    assert.equal(res.headers.get('cache-control'), 'public, max-age=15');
    assert.ok(res.headers.get('x-overpass-upstream')?.startsWith('https://overpass-api.de/'));
    assert.deepEqual(await res.json(), { elements: [{ type: 'way', id: 1 }] });
    assert.equal(stub.calls.length, 1);
    assert.equal(stub.calls[0].url, 'https://overpass-api.de/api/interpreter');
    assert.equal(stub.calls[0].init.method, 'POST');
    assert.equal(stub.calls[0].init.headers['Content-Type'], 'application/x-www-form-urlencoded');
    assert.equal(stub.calls[0].init.body, queryKey(GOOD_QL));
  } finally {
    stub.restore();
  }
});

test('an identical repeat answers HIT from the memory tier without re-fetching', async () => {
  const stub = stubFetch(() => Response.json({ elements: [] }));
  try {
    await onRequest(ctx(new Request(url, { method: 'POST', body: goodBody() })));
    const second = await onRequest(ctx(new Request(url, { method: 'POST', body: goodBody() })));
    assert.equal(second.headers.get('x-overpass-cache'), 'HIT');
    assert.equal(stub.calls.length, 1, 'the memory tier must absorb the repeat');
  } finally {
    stub.restore();
  }
});

test('per-client limiter answers 429 after 90 admitted queries in a window', async () => {
  const stub = stubFetch(() => Response.json({ elements: [] }));
  try {
    let last;
    for (let i = 0; i < 90; i += 1) {
      last = await onRequest(ctx(new Request(url, {
        method: 'POST',
        body: goodBody(`[out:json][timeout:20];node(around:${1000 + i},30.27,-97.74)["amenity"];out;`),
      })));
      assert.equal(last.status, 200, `query ${i} should pass`);
    }
    const limited = await onRequest(ctx(new Request(url, {
      method: 'POST',
      body: goodBody('[out:json][timeout:20];node(around:9999,30.27,-97.74)["amenity"];out;'),
    })));
    assert.equal(limited.status, 429);
    assert.equal(limited.headers.get('retry-after'), '5');
    assert.deepEqual(await limited.json(), { error: 'Rate limit exceeded' });
  } finally {
    stub.restore();
  }
});

test('rate-limited mirrors fall through and a total rate-limit is forwarded verbatim', async () => {
  let upstreamHits = 0;
  const stub = stubFetch(() => {
    upstreamHits += 1;
    return new Response('rate_limited: dispatcher quota', { status: 429 });
  });
  try {
    const res = await onRequest(ctx(new Request(url, { method: 'POST', body: goodBody() })));
    assert.equal(upstreamHits, 4, 'every mirror must be tried');
    assert.equal(res.status, 429, 'the degraded status travels verbatim');
    assert.equal(res.headers.get('x-overpass-cache'), 'MISS');
  } finally {
    stub.restore();
  }
});

test('a warm cache serves STALE when every mirror is degraded', async () => {
  let degraded = false;
  const stub = stubFetch(() => (degraded
    ? new Response('rate_limited', { status: 429 })
    : Response.json({ elements: [{ type: 'node', id: 7 }] })));
  const originalNow = Date.now;
  try {
    await onRequest(ctx(new Request(url, { method: 'POST', body: goodBody() })));
    degraded = true;
    // Age past the 24 h fresh TTL so the repeat actually reaches the mirrors.
    Date.now = () => originalNow() + 86_400_000 + 1_000;
    const stale = await onRequest(ctx(new Request(url, { method: 'POST', body: goodBody() })));
    assert.equal(stale.headers.get('x-overpass-cache'), 'STALE');
    assert.deepEqual(await stale.json(), { elements: [{ type: 'node', id: 7 }] });
  } finally {
    Date.now = originalNow;
    stub.restore();
  }
});

test('runtime-error and 5xx mirrors are skipped in favor of healthy ones', async () => {
  const bodies = [
    () => new Response('{"remark":"runtime error: query timed out"}', { status: 200 }),
    () => new Response('boom', { status: 502 }),
    () => Response.json({ elements: [{ type: 'way', id: 2 }] }),
  ];
  let call = 0;
  const stub = stubFetch(() => {
    const index = call;
    call += 1;
    return bodies[index]();
  });
  try {
    const res = await onRequest(ctx(new Request(url, { method: 'POST', body: goodBody() })));
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { elements: [{ type: 'way', id: 2 }] });
    assert.equal(res.headers.get('x-overpass-cache'), 'MISS');
    assert.equal(res.headers.get('x-overpass-upstream'), 'https://lz4.overpass-api.de/api/interpreter');
    assert.equal(call, 3);
  } finally {
    stub.restore();
  }
});

test('a transport failure on every mirror answers the 502 shape, stale when warm', async () => {
  let stub = stubFetch(() => { throw new Error('mirror unreachable'); });
  const originalNow = Date.now;
  try {
    const cold = await onRequest(ctx(new Request(url, { method: 'POST', body: goodBody() })));
    assert.equal(cold.status, 502);
    assert.deepEqual(await cold.json(), { error: 'Overpass proxy error' });

    stub.restore();
    stub = stubFetch(() => Response.json({ elements: [] }));
    await onRequest(ctx(new Request(url, {
      method: 'POST',
      body: goodBody('[out:json][timeout:20];way(30.2,-97.8,30.3,-97.7)["highway"];out;'),
    })));
    stub.restore();
    stub = stubFetch(() => { throw new Error('mirror unreachable'); });
    // Age past the fresh TTL so the repeat reaches the (dead) mirrors.
    Date.now = () => originalNow() + 86_400_000 + 1_000;
    const stale = await onRequest(ctx(new Request(url, {
      method: 'POST',
      body: goodBody('[out:json][timeout:20];way(30.2,-97.8,30.3,-97.7)["highway"];out;'),
    })));
    assert.equal(stale.headers.get('x-overpass-cache'), 'STALE');
  } finally {
    Date.now = originalNow;
    stub.restore();
  }
});

test('concurrent distinct queries cap at 6 upstream fetches; the 7th gets 503', async () => {
  const stub = stubDeferredFetch();
  try {
    const flights = [];
    for (let i = 0; i < 6; i += 1) {
      flights.push(onRequest(ctx(new Request(url, {
        method: 'POST',
        body: goodBody(`[out:json][timeout:20];node(around:${2000 + i},30.27,-97.74)["amenity"];out;`),
      }))));
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
    assert.equal(stub.calls.length, 6, 'all six should be in flight');
    const seventh = await onRequest(ctx(new Request(url, {
      method: 'POST',
      body: goodBody('[out:json][timeout:20];node(around:3000,30.27,-97.74)["amenity"];out;'),
    })));
    assert.equal(seventh.status, 503);
    assert.equal(seventh.headers.get('retry-after'), '2');
    assert.deepEqual(await seventh.json(), { error: 'Overpass proxy busy — try again shortly' });
    assert.equal(stub.calls.length, 6, 'the 503 must not open a seventh slot');

    stub.release();
    for (const flight of flights) {
      const res = await flight;
      assert.equal(res.status, 200);
      assert.equal(res.headers.get('x-overpass-cache'), 'MISS');
    }
  } finally {
    stub.restore();
  }
});

test('concurrent identical queries coalesce onto one upstream fetch', async () => {
  const stub = stubDeferredFetch();
  try {
    const first = onRequest(ctx(new Request(url, { method: 'POST', body: goodBody() })));
    await new Promise((resolve) => setTimeout(resolve, 0));
    const second = onRequest(ctx(new Request(url, { method: 'POST', body: goodBody() })));
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.equal(stub.calls.length, 1, 'the joiner must not open a second slot');

    stub.release();
    const [a, b] = await Promise.all([first, second]);
    const statuses = [a.headers.get('x-overpass-cache'), b.headers.get('x-overpass-cache')].sort();
    assert.deepEqual(statuses, ['INFLIGHT', 'MISS']);
  } finally {
    stub.restore();
  }
});
