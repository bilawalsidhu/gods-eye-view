import test from 'node:test';
import assert from 'node:assert/strict';

import { onRequest, resetMilCacheForTest } from './mil.js';

const url = 'https://example.com/api/adsblol/mil';
const ctx = (request) => ({ request, env: {} });

const MIL = JSON.stringify({
  ac: [
    { hex: 'ae4c5d', r: '05-4613', t: 'C17', flight: 'REACH42' },
    { hex: 'ae1250', r: '84-0125', t: 'KC135', flight: 'SHELL74' },
  ],
  now: 1710000000000,
});

const milResponse = () => new Response(MIL, { status: 200 });

test('a cold request proxies v2/mil with the descriptive User-Agent and labels the MISS', async () => {
  resetMilCacheForTest();
  let captured;
  const original = globalThis.fetch;
  globalThis.fetch = async (fetchUrl, init) => {
    captured = { fetchUrl, init };
    return milResponse();
  };
  try {
    const res = await onRequest(ctx(new Request(url)));
    assert.equal(res.status, 200);
    assert.equal(await res.text(), MIL, 'the fleet document passes through untouched');
    assert.equal(res.headers.get('content-type'), 'application/json');
    assert.equal(res.headers.get('cache-control'), 'no-store');
    assert.equal(res.headers.get('x-ads-b-cache'), 'MISS');

    assert.equal(captured.fetchUrl, 'https://api.adsb.lol/v2/mil');
    assert.equal(captured.init.headers['User-Agent'], 'gods-eye-view-adsblol-proxy/1.0');
  } finally {
    globalThis.fetch = original;
  }
});

test('a repeat inside the 12 s window is served from cache with HIT', async () => {
  let calls = 0;
  const original = globalThis.fetch;
  globalThis.fetch = async () => { calls += 1; return milResponse(); };
  try {
    const res = await onRequest(ctx(new Request(url)));
    assert.equal(res.status, 200);
    assert.equal(await res.text(), MIL);
    assert.equal(res.headers.get('x-ads-b-cache'), 'HIT');
    assert.equal(res.headers.get('cache-control'), 'no-store');
    assert.equal(calls, 0, 'the layer polls this every few seconds — it must not re-fetch');
  } finally {
    globalThis.fetch = original;
  }
});

test('an upstream HTTP error is passed through at its own status and never cached', async () => {
  resetMilCacheForTest();
  let calls = 0;
  const original = globalThis.fetch;
  globalThis.fetch = async () => {
    calls += 1;
    return new Response('{"ac":[]}', { status: 503 });
  };
  try {
    const res = await onRequest(ctx(new Request(url)));
    assert.equal(res.status, 503, 'the client reads this status to decide whether to poll again');
    assert.equal(await res.text(), '{"ac":[]}');
    assert.equal(res.headers.get('x-ads-b-cache'), 'MISS');
    assert.equal(res.headers.get('cache-control'), 'no-store');

    // A successful request right after still has to reach upstream: the 503
    // must not have poisoned the cache.
    globalThis.fetch = async () => { calls += 1; return milResponse(); };
    const good = await onRequest(ctx(new Request(url)));
    assert.equal(good.headers.get('x-ads-b-cache'), 'MISS');
    assert.equal(await good.text(), MIL);
    assert.equal(calls, 2);
  } finally {
    globalThis.fetch = original;
  }
});

test('a transport failure after the cache expires serves the stale fleet', async () => {
  const original = globalThis.fetch;
  const originalNow = Date.now;
  try {
    globalThis.fetch = async () => milResponse();
    resetMilCacheForTest();
    assert.equal((await onRequest(ctx(new Request(url)))).headers.get('x-ads-b-cache'), 'MISS');

    // Push "now" past the 12 s TTL, then break upstream.
    Date.now = () => originalNow() + 13_000;
    globalThis.fetch = async () => { throw new Error('connect ECONNRESET'); };
    const stale = await onRequest(ctx(new Request(url)));
    assert.equal(stale.status, 200);
    assert.equal(await stale.text(), MIL);
    assert.equal(stale.headers.get('x-ads-b-cache'), 'STALE');
    assert.equal(stale.headers.get('cache-control'), null, 'dev omits Cache-Control on this branch');
  } finally {
    Date.now = originalNow;
    globalThis.fetch = original;
  }
});

test('a cold cache plus a dead upstream answers the dev 502 shape', async () => {
  resetMilCacheForTest();
  const original = globalThis.fetch;
  globalThis.fetch = async () => { throw new Error('connect ECONNREFUSED'); };
  try {
    const res = await onRequest(ctx(new Request(url)));
    assert.equal(res.status, 502);
    assert.deepEqual(await res.json(), { error: 'ADS-B proxy error' });
    assert.equal(res.headers.get('content-type'), 'application/json');
    assert.equal(res.headers.get('x-ads-b-cache'), null, 'nothing was served from cache');
    assert.equal(res.headers.get('cache-control'), null);
  } finally {
    globalThis.fetch = original;
  }
});

test('there is no method guard and no query contract — parity with dev', async () => {
  resetMilCacheForTest();
  const original = globalThis.fetch;
  globalThis.fetch = async () => milResponse();
  try {
    const res = await onRequest(ctx(new Request(`${url  }?bbox=-10,10,20,30`, { method: 'POST' })));
    assert.equal(res.status, 200, 'dev never inspects req.method or req.url here');
    assert.equal(res.headers.get('x-ads-b-cache'), 'MISS', 'query params are not part of the cache key');
  } finally {
    globalThis.fetch = original;
  }
});
