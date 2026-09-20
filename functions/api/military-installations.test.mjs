// Contract tests for the /api/military-installations Pages Function.
//
// The previous implementation (`military-installations.ts`) read a `bbox`
// param the client has never sent, so EVERY production request 400'd while
// dev worked — these tests pin the real client contract
// (`src/data/militaryInstallations.js`): south/west/north/east + optional
// exact=1, the {elements, saturated, elementCap, retrievedAt, status} payload,
// snapped-grid cache sharing, and the HIT/INFLIGHT/MISS/STALE/503 header set.
//
// Run with: npm test   (node --test)
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import { onRequest, resetMilitaryInstallationsStateForTest } from './military-installations.js';
import { OVERPASS_UPSTREAMS } from '../../src/data/overpassPolicy.js';

const url = 'https://example.com/api/military-installations';
const ctx = (request) => ({ request });

/** A downtown-Austin-ish viewport within one snap cell. */
function boxParams({ south = 30.26120, west = -97.74310, north = 30.28840, east = -97.70990, exact = null } = {}) {
  const params = new URLSearchParams({
    south: south.toFixed(5),
    west: west.toFixed(5),
    north: north.toFixed(5),
    east: east.toFixed(5),
  });
  if (exact) params.set('exact', '1');
  return params.toString();
}

const request = (query = boxParams(), init = {}) => new Request(`${url}?${query}`, init);

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

function installationRow(index) {
  return {
    type: 'way',
    id: 1000 + index,
    lat: 30.2 + index * 0.001,
    lon: -97.7 - index * 0.001,
    tags: { military: 'airfield', name: `Base ${index}` },
  };
}

function healthyUpstream({ count = 3 } = {}) {
  return Response.json({ elements: Array.from({ length: count }, (_, i) => installationRow(i)) });
}

beforeEach(() => resetMilitaryInstallationsStateForTest());

test('non-GET answers the dev 405 shape before any upstream work', async () => {
  const stub = stubFetch(() => { throw new Error('must not fetch'); });
  try {
    for (const method of ['POST', 'OPTIONS', 'DELETE']) {
      const res = await onRequest(ctx(request(boxParams(), { method })));
      assert.equal(res.status, 405, method);
      assert.deepEqual(await res.json(), { error: 'Method Not Allowed' });
    }
    assert.equal(stub.calls.length, 0);
  } finally {
    stub.restore();
  }
});

test('invalid, missing, oversized, and cross-dateline boxes answer the dev 400 message', async () => {
  const stub = stubFetch(() => { throw new Error('must not fetch'); });
  try {
    const cases = [
      '', // missing everything
      'south=30&west=-97', // partial
      'south=30&west=-97&north=abc&east=-96', // non-numeric
      'south=91&west=-97&north=92&east=-96', // out of range
      'south=40&west=-97&north=30&east=-96', // inverted
      'south=30&west=-170&north=40&east=170', // cross-dateline (east < west)
      'south=30&west=-97&north=45&east=-96', // > 10 deg span
    ];
    for (const query of cases) {
      const res = await onRequest(ctx(request(query)));
      assert.equal(res.status, 400, query);
      assert.deepEqual(
        await res.json(),
        { error: 'A non-dateline bbox no larger than 10 degrees is required' },
        query,
      );
    }
    assert.equal(stub.calls.length, 0);
  } finally {
    stub.restore();
  }
});

test('a valid viewport answers the client payload shape with MISS', async () => {
  const stub = stubFetch(() => healthyUpstream());
  try {
    const res = await onRequest(ctx(request()));
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('x-military-installations'), 'MISS');
    assert.equal(res.headers.get('cache-control'), 'public, max-age=60');
    const body = await res.json();
    assert.equal(body.elements.length, 3);
    assert.equal(body.saturated, false);
    assert.equal(body.elementCap, 700, 'dev parity: the cap travels with the payload');
    assert.equal(body.status, 'ready');
    assert.ok(typeof body.retrievedAt === 'string');

    // The upstream call is the shared builder's exact form body, element cap 700.
    assert.equal(stub.calls.length, 1);
    assert.equal(stub.calls[0].url, 'https://overpass-api.de/api/interpreter');
    assert.equal(stub.calls[0].init.method, 'POST');
    const sent = decodeURIComponent(stub.calls[0].init.body.replace(/^data=/, ''));
    assert.ok(sent.includes('out center tags geom 700'), sent);
    // The raw viewport snapped OUTWARD onto the 0.05° grid.
    assert.ok(sent.includes('(30.25,-97.75,30.3,-97.7)'), `snapped bbox expected in: ${sent}`);
  } finally {
    stub.restore();
  }
});

test('neighbouring viewports snap onto one cache cell and share the answer', async () => {
  const stub = stubFetch(() => healthyUpstream());
  try {
    const first = await onRequest(ctx(request()));
    assert.equal(first.headers.get('x-military-installations'), 'MISS');
    // A few meters over — same 0.05° cell.
    const second = await onRequest(ctx(request(boxParams({ south: 30.26125, west: -97.74305 }))));
    assert.equal(second.headers.get('x-military-installations'), 'HIT');
    assert.equal((await second.json()).status, 'cached');
    assert.equal(stub.calls.length, 1, 'snap sharing must avoid the second upstream call');
  } finally {
    stub.restore();
  }
});

test('a SATURATED snapped answer is keyed apart from the exact=1 re-ask', async () => {
  const stub = stubFetch(() => healthyUpstream({ count: 700 }));
  try {
    const snapped = await onRequest(ctx(request()));
    const snappedBody = await snapped.json();
    assert.equal(snappedBody.saturated, true, '700 elements = truncated upstream');
    assert.equal(snapped.headers.get('x-military-installations'), 'MISS');

    // The client re-asks for its exact viewport after SATURATED — a separate key.
    const exact = await onRequest(ctx(request(boxParams({ exact: true }))));
    assert.equal(exact.headers.get('x-military-installations'), 'MISS', 'exact must not collide with the snapped entry');
    assert.equal(stub.calls.length, 2);
    const sent = decodeURIComponent(stub.calls[1].init.body.replace(/^data=/, ''));
    assert.ok(sent.includes('(30.2612,-97.7431,30.2884,-97.7099)'), `raw viewport expected in: ${sent}`);
  } finally {
    stub.restore();
  }
});

test('upstream failure serves STALE from memory, 503 when cold', async () => {
  let failing = false;
  const stub = stubFetch(() => {
    if (failing) throw new Error('mirror unreachable');
    return healthyUpstream();
  });
  const originalNow = Date.now;
  try {
    await onRequest(ctx(request()));
    failing = true;
    // Age past the 5 min fresh TTL so the repeat actually reaches the mirrors.
    Date.now = () => originalNow() + 5 * 60_000 + 1_000;
    const stale = await onRequest(ctx(request()));
    assert.equal(stale.status, 200);
    assert.equal(stale.headers.get('x-military-installations'), 'STALE');
    assert.equal(stale.headers.get('cache-control'), 'no-store');
    assert.equal((await stale.json()).status, 'stale');

    const cold = await onRequest(ctx(request(boxParams({ south: 40.26120, north: 40.28840 }))));
    assert.equal(cold.status, 503);
    assert.equal(cold.headers.get('cache-control'), 'no-store');
    assert.deepEqual(
      await cold.json(),
      { error: 'Mapped installation context is temporarily unavailable' },
    );
  } finally {
    Date.now = originalNow;
    stub.restore();
  }
});

test('concurrent identical requests coalesce onto one upstream refresh', async () => {
  const original = globalThis.fetch;
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const calls = [];
  globalThis.fetch = async (fetchUrl, init) => {
    calls.push({ url: String(fetchUrl), init });
    await gate;
    return healthyUpstream();
  };
  try {
    const first = onRequest(ctx(request()));
    await new Promise((resolve) => setTimeout(resolve, 0));
    const second = onRequest(ctx(request()));
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.equal(calls.length, 1, 'the joiner must not re-fetch');

    release();
    const [a, b] = await Promise.all([first, second]);
    const headers = [a.headers.get('x-military-installations'), b.headers.get('x-military-installations')].sort();
    assert.deepEqual(headers, ['INFLIGHT', 'MISS']);
  } finally {
    globalThis.fetch = original;
  }
});

test('a degraded upstream (429 on every mirror) answers 503, never a truncated layer', async () => {
  const stub = stubFetch(() => new Response('rate_limited', { status: 200 }));
  try {
    const res = await onRequest(ctx(request()));
    assert.equal(res.status, 503);
    assert.equal(stub.calls.length, OVERPASS_UPSTREAMS.length, 'all mirrors tried before giving up');
  } finally {
    stub.restore();
  }
});

test('the memory cache evicts its oldest cell past the 80-entry ceiling', async () => {
  const stub = stubFetch(() => healthyUpstream({ count: 1 }));
  try {
    // exact=1 keys at 5 decimals, so every viewport here is its own cell.
    const boxes = Array.from({ length: 81 }, (_, i) => boxParams({
      south: -10 + i * 0.5, west: 10 + i * 0.5,
      north: -9.5 + i * 0.5, east: 10.5 + i * 0.5,
      exact: '1',
    }));
    for (const [i, query] of boxes.entries()) {
      const res = await onRequest(ctx(request(query)));
      assert.equal(res.status, 200, `box ${i}`);
    }
    const fetched = stub.calls.length;
    assert.equal(fetched, 81, 'each distinct cell costs one Overpass query');

    const evicted = await onRequest(ctx(request(boxes[0])));
    assert.equal(evicted.headers.get('x-military-installations'), 'MISS', 'the oldest cell was evicted');
    const retained = await onRequest(ctx(request(boxes[80])));
    assert.equal(retained.headers.get('x-military-installations'), 'HIT', 'the newest cell survives');
    assert.equal(stub.calls.length, fetched + 1, 'only the evicted cell went back upstream');
  } finally {
    stub.restore();
  }
});

test('the 91st request in a minute gets the dev 429 shape before any upstream work', async () => {
  const stub = stubFetch(() => { throw new Error('must not fetch'); });
  try {
    // An invalid box still clears the limiter (validation happens after it),
    // so ninety 400s are exactly the per-client window.
    const invalid = 'south=999&west=0&north=0&east=1';
    for (let i = 0; i < 90; i += 1) {
      const res = await onRequest(ctx(request(invalid)));
      assert.equal(res.status, 400, `request ${i + 1} must be admitted`);
    }
    const limited = await onRequest(ctx(request()));
    assert.equal(limited.status, 429);
    assert.deepEqual(await limited.json(), { error: 'Rate limit exceeded' });
    assert.equal(limited.headers.get('retry-after'), '5');
    assert.equal(stub.calls.length, 0, 'the limiter sits in front of Overpass');
  } finally {
    stub.restore();
  }
});
