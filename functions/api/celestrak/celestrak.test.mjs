import test from 'node:test';
import assert from 'node:assert/strict';

// The Function file is `[[path]].js` (Pages optional catch-all). This test file
// deliberately does NOT mirror that name: `node --test` treats `[[...]]` in a
// filename argument as a glob, matches nothing, and reports "0 tests, 0
// failures" — every assertion below would be silently skipped.
import { onRequest } from './[[path]].js';

const url = (group) => `https://example.com/api/celestrak/${group}`;
const ctx = (request) => ({ request, env: {} });

/** Two real-ish TLE lines — the proxy forwards upstream text verbatim. */
const TLE = [
  '1 25544U 98067A   24100.50000000  .00016717  00000-0  30777-3 0  9993',
  '2 25544  51.6416 247.4627 0006703 130.5360 325.0288 15.72125391563537',
  '',
].join('\n');

const tleResponse = () => new Response(TLE, { status: 200 });

test('the bare mount and malformed groups are rejected with the dev 400 text shape', async () => {
  const calls = [];
  const original = globalThis.fetch;
  globalThis.fetch = async (...args) => { calls.push(args); throw new Error('no'); };
  try {
    for (const path of ['', 'bad_group', 'stations/extra', '%41ctive', 'STAR.LINK']) {
      const res = await onRequest(ctx(new Request(`https://example.com/api/celestrak/${path}`)));
      assert.equal(res.status, 400, path);
      assert.equal(await res.text(), 'invalid group', path);
      assert.equal(res.headers.get('content-type'), 'text/plain', 'celestrak answers text/plain, not JSON');
      assert.equal(res.headers.get('x-tle-cache'), null, 'no cache exists to describe');
    }
    // The bare mount (no trailing segment) is the dev prefix itself.
    const bare = await onRequest(ctx(new Request('https://example.com/api/celestrak')));
    assert.equal(bare.status, 400);
    assert.equal(await bare.text(), 'invalid group');
    assert.equal(calls.length, 0, 'a rejected group never reaches CelesTrak');
  } finally {
    globalThis.fetch = original;
  }
});

test('a cold group is fetched with the GROUP/FORMAT params and the bulk-friendly User-Agent', async () => {
  let captured;
  const original = globalThis.fetch;
  globalThis.fetch = async (fetchUrl, init) => {
    captured = { fetchUrl, init };
    return tleResponse();
  };
  try {
    const res = await onRequest(ctx(new Request(url('stations'))));
    assert.equal(res.status, 200);
    assert.equal(await res.text(), TLE, 'TLE text passes through untouched');
    assert.equal(res.headers.get('content-type'), 'text/plain');
    assert.equal(res.headers.get('x-tle-cache'), 'MISS');

    assert.equal(captured.fetchUrl, 'https://celestrak.org/NORAD/elements/gp.php?GROUP=stations&FORMAT=tle');
    assert.match(captured.init.headers['User-Agent'], /^gods-eye-view-celestrak-proxy\/1\.0 \(\+https:/);
    assert.ok(captured.init.signal instanceof AbortSignal, 'the upstream call is time-bounded');
  } finally {
    globalThis.fetch = original;
  }
});

test('a warm group is answered from the 6h cache without touching CelesTrak', async () => {
  let calls = 0;
  const original = globalThis.fetch;
  globalThis.fetch = async () => { calls += 1; return tleResponse(); };
  try {
    const first = await onRequest(ctx(new Request(url('gps-ops'))));
    assert.equal(first.headers.get('x-tle-cache'), 'MISS');
    const second = await onRequest(ctx(new Request(url('gps-ops'))));
    assert.equal(second.headers.get('x-tle-cache'), 'HIT');
    assert.equal(await second.text(), TLE);
    assert.equal(calls, 1, 'the second request is served entirely from cache');
  } finally {
    globalThis.fetch = original;
  }
});

test('an expired entry is served as STALE-ERROR when the refresh fails', async () => {
  const original = globalThis.fetch;
  const originalNow = Date.now;
  try {
    globalThis.fetch = async () => tleResponse();
    const first = await onRequest(ctx(new Request(url('glo-ops'))));
    assert.equal(first.headers.get('x-tle-cache'), 'MISS');

    // Push "now" past the 6h TTL, then make the refresh fail.
    Date.now = () => originalNow() + 7 * 3600_000;
    globalThis.fetch = async () => { throw new Error('connect ETIMEDOUT'); };
    const second = await onRequest(ctx(new Request(url('glo-ops'))));
    assert.equal(second.status, 200, 'stale beats empty');
    assert.equal(await second.text(), TLE);
    assert.equal(second.headers.get('x-tle-cache'), 'STALE-ERROR');
  } finally {
    Date.now = originalNow;
    globalThis.fetch = original;
  }
});

test('a failed refresh with no cache answers the dev 502 text shape', async () => {
  const original = globalThis.fetch;
  globalThis.fetch = async () => { throw new Error('connect ECONNREFUSED'); };
  try {
    const res = await onRequest(ctx(new Request(url('geo'))));
    assert.equal(res.status, 502);
    assert.equal(await res.text(), 'celestrak fetch failed and no cache available');
    assert.equal(res.headers.get('content-type'), 'text/plain');
    assert.equal(res.headers.get('x-tle-cache'), 'NONE');
  } finally {
    globalThis.fetch = original;
  }
});

test('an upstream HTTP error is a failure, not a document', async () => {
  const original = globalThis.fetch;
  globalThis.fetch = async () => new Response('forbidden', { status: 403 });
  try {
    const res = await onRequest(ctx(new Request(url('galileo'))));
    assert.equal(res.status, 502);
    assert.equal(await res.text(), 'celestrak fetch failed and no cache available');
    assert.equal(res.headers.get('x-tle-cache'), 'NONE');
  } finally {
    globalThis.fetch = original;
  }
});

test('a 200 body with zero TLE lines is treated as an upstream error page', async () => {
  const original = globalThis.fetch;
  globalThis.fetch = async () => new Response('No data available for this group', { status: 200 });
  try {
    const res = await onRequest(ctx(new Request(url('starlink'))));
    assert.equal(res.status, 502);
    assert.equal(res.headers.get('x-tle-cache'), 'NONE');
  } finally {
    globalThis.fetch = original;
  }
});

test('concurrent misses for one group share a single upstream request', async () => {
  let calls = 0;
  const original = globalThis.fetch;
  globalThis.fetch = async () => {
    calls += 1;
    await new Promise((resolve) => setTimeout(resolve, 5));
    return tleResponse();
  };
  try {
    const [a, b] = await Promise.all([
      onRequest(ctx(new Request(url('visual')))),
      onRequest(ctx(new Request(url('visual')))),
    ]);
    assert.equal(calls, 1, 'single-flight collapses the burst into one CelesTrak fetch');
    assert.equal(a.headers.get('x-tle-cache'), 'MISS');
    assert.equal(b.headers.get('x-tle-cache'), 'MISS');
    assert.equal(await b.text(), TLE);
  } finally {
    globalThis.fetch = original;
  }
});

test('there is no method guard — parity with the dev prefix middleware', async () => {
  const original = globalThis.fetch;
  globalThis.fetch = async () => tleResponse();
  try {
    const res = await onRequest(ctx(new Request(url('sarsat'), { method: 'POST' })));
    assert.equal(res.status, 200, 'dev never checks req.method here, so neither do we');
    assert.equal(res.headers.get('x-tle-cache'), 'MISS');
  } finally {
    globalThis.fetch = original;
  }
});
