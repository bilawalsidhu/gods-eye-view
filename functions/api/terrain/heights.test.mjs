// Pages Function tests for /api/terrain/heights — mirrors the dev middleware
// contract (vite/proxies/terrain-heights.js): identical parse/limit errors,
// shared resolver, order-preserving results including duplicates. Offline via
// a stubbed globalThis.fetch (the shared retry helper reads it per call).
//
// Run with: npm test   (node --test)
import test from 'node:test';
import assert from 'node:assert/strict';

import { onRequest, resetTerrainHeightsStateForTest } from './heights.js';

const url = (points) => `https://example.com/api/terrain/heights${points ? `?points=${encodeURIComponent(points)}` : ''}`;
const ctx = (request) => ({ request });

/** Stub the Re:Earth upstream: one height per requested point, in order. */
function stubUpstream(height) {
  const calls = [];
  const original = globalThis.fetch;
  globalThis.fetch = async (fetchUrl) => {
    calls.push(String(fetchUrl));
    const raw = new URL(fetchUrl).searchParams.get('points');
    const pairs = raw.split(';');
    return new Response(JSON.stringify({ results: pairs.map(() => ({ ellipsoid: height })) }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  };
  return { calls, restore() { globalThis.fetch = original; } };
}

test('OPTIONS gets the CORS preflight without touching the upstream', async () => {
  resetTerrainHeightsStateForTest();
  const upstream = stubUpstream(0);
  try {
    const res = await onRequest(ctx(new Request(url(''), { method: 'OPTIONS' })));
    assert.equal(res.status, 204);
    assert.equal(upstream.calls.length, 0);
  } finally {
    upstream.restore();
  }
});

test('invalid and oversized points params get the exact dev error shapes', async () => {
  resetTerrainHeightsStateForTest();
  const upstream = stubUpstream(0);
  try {
    for (const query of ['', '?points=', '?points=lon,lat', '?points=1,2;abc,3', '?points=1,2;3']) {
      const res = await onRequest(ctx(new Request(`https://example.com/api/terrain/heights${query}`)));
      assert.equal(res.status, 400, query);
      assert.deepEqual(
        await res.json(),
        { error: 'invalid points parameter — expected "lon,lat;lon,lat;…" with finite numbers' },
        query,
      );
    }
    const tooMany = `${Array.from({ length: 2001 }, (_, i) => `1${i % 10}.5,20.5`).join(';')}`;
    const res = await onRequest(ctx(new Request(url(tooMany))));
    assert.equal(res.status, 500);
    assert.deepEqual(await res.json(), { error: 'too many points (2001); max 2000 per request' });
    assert.equal(upstream.calls.length, 0, 'rejected requests never reach Re:Earth');
  } finally {
    upstream.restore();
  }
});

test('results come back in exact request order, duplicates included, and are cached', async () => {
  resetTerrainHeightsStateForTest();
  const upstream = stubUpstream(42.5);
  try {
    const points = '-0.13,51.51;-0.12,51.5;-0.13,51.51';
    const res = await onRequest(ctx(new Request(url(points))));
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { results: [{ ellipsoid: 42.5 }, { ellipsoid: 42.5 }, { ellipsoid: 42.5 }] });
    assert.match(upstream.calls[0], /^https:\/\/terrain\.reearth\.land\/heights\.json\?points=/);
    // The deduped missing-set collapses the duplicate into one upstream point.
    assert.equal(upstream.calls[0].match(/(?<=points=)[^&]+/)[0].split('%3B').length, 2);

    const again = await onRequest(ctx(new Request(url(points))));
    assert.deepEqual(await again.json(), { results: [{ ellipsoid: 42.5 }, { ellipsoid: 42.5 }, { ellipsoid: 42.5 }] });
    assert.equal(upstream.calls.length, 1, 'the warm isolate cache answers the repeat');
  } finally {
    upstream.restore();
  }
});

test('a malformed upstream body fails fast to the dev 502 shape (no fabricated heights)', async () => {
  resetTerrainHeightsStateForTest();
  const original = globalThis.fetch;
  globalThis.fetch = async () => new Response('{}', {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
  try {
    const res = await onRequest(ctx(new Request(url('-0.12,51.5;-0.13,51.51'))));
    assert.equal(res.status, 502);
    assert.deepEqual(await res.json(), { error: 'terrain heights fetch failed and no cache available for every point' });
  } finally {
    globalThis.fetch = original;
  }
});

test('a partial upstream failure serves the cached points and 502s the rest', async () => {
  resetTerrainHeightsStateForTest();
  // Prime the cache for one point only.
  const good = stubUpstream(10);
  await onRequest(ctx(new Request(url('-0.12,51.5'))));
  assert.equal(good.calls.length, 1);
  good.restore();

  const original = globalThis.fetch;
  globalThis.fetch = async () => new Response('{}', {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
  try {
    const res = await onRequest(ctx(new Request(url('-0.12,51.5;-0.13,51.51'))));
    assert.equal(res.status, 502, 'any missing height fails the whole batch — no zeros invented');
    assert.deepEqual(
      await res.json(),
      { error: 'terrain heights fetch failed and no cache available for every point' },
    );
  } finally {
    globalThis.fetch = original;
  }
});
