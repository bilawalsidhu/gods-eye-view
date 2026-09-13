// Pages Function tests for /api/route — mirrors the dev middleware contract
// (vite/proxies/overpass.js): identical validation errors, upstream URL,
// cache behavior, and response shapes. Offline via a stubbed globalThis.fetch.
//
// Run with: npm test   (node --test)
import test from 'node:test';
import assert from 'node:assert/strict';

import { onRequest, resetRouteStateForTest } from './route.js';

const url = (query) => `https://example.com/api/route${query}`;
const ctx = (request) => ({ request });

const OSRM_BODY = JSON.stringify({
  code: 'Ok',
  routes: [{
    distance: 1234.56,
    duration: 567.89,
    geometry: { coordinates: [[-0.12, 51.5], [-0.125, 51.505], [-0.13, 51.51]] },
  }],
});

/** Install a fetch stub; returns { calls, restore }. */
function stubFetch(handler) {
  const calls = [];
  const original = globalThis.fetch;
  globalThis.fetch = async (fetchUrl, init) => {
    calls.push({ fetchUrl: String(fetchUrl), init });
    return handler(fetchUrl, init);
  };
  return {
    calls,
    restore() { globalThis.fetch = original; },
  };
}

test('OPTIONS gets the CORS preflight without touching OSRM', async () => {
  resetRouteStateForTest();
  const { calls, restore } = stubFetch(() => { throw new Error('must not fetch'); });
  try {
    const res = await onRequest(ctx(new Request(url('?profile=foot&coords=0,1;2,3'), { method: 'OPTIONS' })));
    assert.equal(res.status, 204);
    assert.equal(res.headers.get('access-control-allow-methods'), 'GET, OPTIONS');
    assert.equal(calls.length, 0);
  } finally {
    restore();
  }
});

test('validation failures return the exact dev error strings and never fetch', async () => {
  resetRouteStateForTest();
  const { calls, restore } = stubFetch(() => { throw new Error('must not fetch'); });
  try {
    const cases = [
      ['?profile=skateboard&coords=0,1;2,3', 'invalid profile'],
      ['?profile=foot&coords=', 'need 2-12 coordinates'],
      ['?profile=foot&coords=0,1', 'need 2-12 coordinates'],
      [`?profile=foot&coords=${Array.from({ length: 13 }, (_, i) => `${i},${i}`).join(';')}`, 'need 2-12 coordinates'],
      ['?profile=foot&coords=0,1;2', 'invalid coordinate'],
      ['?profile=foot&coords=0,1;abc,3', 'invalid coordinate'],
      ['?profile=foot&coords=0,999;2,3', 'invalid coordinate'],
    ];
    for (const [query, error] of cases) {
      const res = await onRequest(ctx(new Request(url(query))));
      assert.equal(res.status, 200, query);
      assert.deepEqual(await res.json(), { ok: false, error }, query);
    }
    assert.equal(calls.length, 0, 'validation failures never reach OSRM');
  } finally {
    restore();
  }
});

test('abusive spans are rejected before OSRM is asked for a cross-continent route', async () => {
  resetRouteStateForTest();
  const { calls, restore } = stubFetch(() => { throw new Error('must not fetch'); });
  try {
    // Madrid → Manila is ~11,800 km: exceeds both the 600 km leg cap and the
    // 2,500 km total cap.
    const res = await onRequest(ctx(new Request(url('?profile=foot&coords=-3.70,40.42;120.98,14.60'))));
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { ok: false, error: 'route leg too long' });
    assert.equal(calls.length, 0);
  } finally {
    restore();
  }
});

test('a successful OSRM reply becomes the exact client payload shape', async () => {
  resetRouteStateForTest();
  const { calls, restore } = stubFetch(() => new Response(OSRM_BODY, {
    status: 200,
    headers: { 'content-type': 'application/json' },
  }));
  try {
    const res = await onRequest(ctx(new Request(url('?profile=foot&coords=-0.12,51.5;-0.13,51.51'))));
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), {
      ok: true,
      profile: 'foot',
      distanceM: 1235,
      durationS: 568,
      geometry: [[-0.12, 51.5], [-0.125, 51.505], [-0.13, 51.51]],
    });
    assert.equal(calls.length, 1);
    assert.equal(
      calls[0].fetchUrl,
      'https://routing.openstreetmap.de/routed-foot/route/v1/foot/-0.12,51.5;-0.13,51.51?overview=full&geometries=geojson&alternatives=false&steps=false',
    );
    assert.ok(calls[0].init.signal instanceof AbortSignal, 'the upstream call is time-bounded');
  } finally {
    restore();
  }
});

test('driving aliases map to the OSRM driving profile on the routed-car endpoint', async () => {
  resetRouteStateForTest();
  const { calls, restore } = stubFetch(() => new Response(OSRM_BODY, {
    status: 200,
    headers: { 'content-type': 'application/json' },
  }));
  try {
    const res = await onRequest(ctx(new Request(url('?profile=driving&coords=-0.12,51.5;-0.13,51.51'))));
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.profile, 'car');
    assert.match(calls[0].fetchUrl, /routed-car\/route\/v1\/driving\//);
  } finally {
    restore();
  }
});

test('a repeat within the TTL is served from cache and burns no OSRM call', async () => {
  resetRouteStateForTest();
  const { calls, restore } = stubFetch(() => new Response(OSRM_BODY, {
    status: 200,
    headers: { 'content-type': 'application/json' },
  }));
  try {
    const query = '?profile=bike&coords=-0.12,51.5;-0.13,51.51';
    const first = await onRequest(ctx(new Request(url(query))));
    assert.equal(first.status, 200);
    const second = await onRequest(ctx(new Request(url(query))));
    assert.deepEqual(await second.json(), await first.json());
    assert.equal(calls.length, 1, 'the cached route answers the second request');
  } finally {
    restore();
  }
});

test('upstream failures get the dev `no route found` / proxy-error shapes', async () => {
  resetRouteStateForTest();
  const { restore } = stubFetch(() => new Response('nope', { status: 500 }));
  try {
    const httpFail = await onRequest(ctx(new Request(url('?profile=foot&coords=-0.12,51.5;-0.13,51.51'))));
    assert.equal(httpFail.status, 200);
    assert.deepEqual(await httpFail.json(), { ok: false, error: 'no route found' });
  } finally {
    restore();
  }

  resetRouteStateForTest();
  const malformed = stubFetch(() => new Response('{not json', {
    status: 200,
    headers: { 'content-type': 'application/json' },
  }));
  try {
    const res = await onRequest(ctx(new Request(url('?profile=foot&coords=-0.12,51.5;-0.13,51.51'))));
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { ok: false, error: 'route proxy error' });
  } finally {
    malformed.restore();
  }

  resetRouteStateForTest();
  const codeNotOk = stubFetch(() => new Response(JSON.stringify({ code: 'NoRoute' }), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  }));
  try {
    const res = await onRequest(ctx(new Request(url('?profile=foot&coords=-0.12,51.5;-0.13,51.51'))));
    assert.deepEqual(await res.json(), { ok: false, error: 'no route found' });
  } finally {
    codeNotOk.restore();
  }
});

test('the 60 req/min/IP limiter matches the dev middleware exactly', async () => {
  resetRouteStateForTest();
  const { restore } = stubFetch(() => new Response(OSRM_BODY, {
    status: 200,
    headers: { 'content-type': 'application/json' },
  }));
  try {
    // A dedicated client IP: the limiter is module-scoped and keyed per IP, so
    // earlier tests in this file (which share the default 'unknown' key) must
    // not eat into this window.
    const headers = { 'CF-Connecting-IP': '198.51.100.7' };
    let last;
    for (let i = 0; i < 60; i += 1) {
      last = await onRequest(ctx(new Request(
        url(`?profile=foot&coords=-0.12,51.5;-0.13,51.5${String(i % 10)}`),
        { headers },
      )));
      assert.equal(last.status, 200, `request ${i + 1} within the window`);
    }
    const over = await onRequest(ctx(new Request(url('?profile=foot&coords=-0.12,51.5;-0.13,51.51'), { headers })));
    assert.equal(over.status, 429);
    assert.equal(over.headers.get('retry-after'), '5');
    assert.deepEqual(await over.json(), { ok: false, error: 'rate limited' });
  } finally {
    restore();
  }
});
