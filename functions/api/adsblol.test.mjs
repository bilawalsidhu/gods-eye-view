import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import { onRequest as bareRoute, resetMilCacheForTest } from './adsblol.js';
import { onRequest as milRoute } from './adsblol/mil.js';

const FLEET = JSON.stringify({ ac: [{ hex: 'abcdef', flight: 'MIL1' }], msg: 'No error' });

function stubFetch(impl) {
  const original = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (fetchUrl, init) => {
    calls.push({ url: String(fetchUrl), init });
    return impl({ url: String(fetchUrl), init });
  };
  return { calls, restore: () => { globalThis.fetch = original; } };
}

beforeEach(() => resetMilCacheForTest());

test('bare route is the same handler as /mil — one implementation, one contract', () => {
  assert.equal(bareRoute, milRoute);
});

test('bare and /mil routes share one 12 s cache, like the dev mounts do', async () => {
  let upstreamHits = 0;
  const stub = stubFetch(async () => {
    upstreamHits += 1;
    return new Response(FLEET, { status: 200 });
  });
  try {
    const first = await bareRoute();
    assert.equal(first.status, 200);
    assert.equal(first.headers.get('x-ads-b-cache'), 'MISS');
    const second = await milRoute();
    assert.equal(second.headers.get('x-ads-b-cache'), 'HIT', 'registry poll must hit the layer-warmed cache');
    assert.equal(upstreamHits, 1, 'the second route must not re-fetch upstream within the TTL');
    assert.equal(await second.text(), FLEET);
  } finally {
    stub.restore();
  }
});

test('upstream failure with a warm cache serves STALE instead of taking the layer down', async () => {
  let failing = false;
  const stub = stubFetch(async () => {
    if (failing) throw new Error('feed offline');
    return new Response(FLEET, { status: 200 });
  });
  const originalNow = Date.now;
  try {
    assert.equal((await bareRoute()).headers.get('x-ads-b-cache'), 'MISS');
    failing = true;
    // Age past the 12 s TTL so the next poll actually reaches upstream.
    Date.now = () => originalNow() + 13_000;
    const stale = await bareRoute();
    assert.equal(stale.status, 200);
    assert.equal(stale.headers.get('x-ads-b-cache'), 'STALE');
    assert.equal(await stale.text(), FLEET);
  } finally {
    Date.now = originalNow;
    stub.restore();
  }
});

test('upstream failure with a cold cache answers the dev 502 shape', async () => {
  const stub = stubFetch(async () => { throw new Error('feed offline'); });
  try {
    const res = await bareRoute();
    assert.equal(res.status, 502);
    assert.equal(res.headers.get('x-ads-b-cache'), null);
    assert.deepEqual(JSON.parse(await res.text()), { error: 'ADS-B proxy error' });
  } finally {
    stub.restore();
  }
});

test('a non-2xx upstream body is surfaced but never cached', async () => {
  let upstreamHits = 0;
  const stub = stubFetch(async () => {
    upstreamHits += 1;
    return new Response(JSON.stringify({ msg: 'rate limited' }), { status: 429 });
  });
  try {
    const first = await bareRoute();
    assert.equal(first.status, 429);
    assert.equal(first.headers.get('x-ads-b-cache'), 'MISS');
    const second = await bareRoute();
    assert.equal(second.headers.get('x-ads-b-cache'), 'MISS');
    assert.equal(upstreamHits, 2, 'a failed upstream response must not poison the cache slot');
  } finally {
    stub.restore();
  }
});
