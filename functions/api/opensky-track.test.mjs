import test from 'node:test';
import assert from 'node:assert/strict';

import { onRequest } from './opensky-track.js';
import { resetTrackCacheForTest } from '../_upstream.js';

const url = (query = '') => `https://example.com/api/opensky-track${query}`;
const ctx = (request, env = {}) => ({ request, env });

const TRACK = JSON.stringify({ path: [[1710000000, 12.5, 51.4, 11000, 250, 270]], });

/**
 * ORDERING NOTE: the OAuth token cache is module state, and a cached token wins
 * over re-reading the credentials (that is the dev behavior being mirrored).
 * The anonymous tests therefore have to run BEFORE any test that mints a token.
 * Within a file node:test runs tests sequentially in declaration order.
 */
test('a bad icao24 gets the dev 400 shape without touching OpenSky', async () => {
  resetTrackCacheForTest();
  const calls = [];
  const original = globalThis.fetch;
  globalThis.fetch = async (...args) => { calls.push(args); throw new Error('no'); };
  try {
    for (const query of ['', '?icao24=', '?icao24=abc12', '?icao24=abc1234', '?icao24=zzzzzz', '?icao24=ABC12G']) {
      const res = await onRequest(ctx(new Request(url(query))));
      assert.equal(res.status, 400, JSON.stringify(query));
      assert.deepEqual(await res.json(), { error: 'icao24 must be a 6-char hex string' }, query);
      assert.equal(res.headers.get('content-type'), 'application/json', 'the 400 carries no charset');
    }
    assert.equal(calls.length, 0, 'a rejected icao24 never burns OpenSky credits');
  } finally {
    globalThis.fetch = original;
  }
});

test('anonymous reads go out with no Authorization header at all', async () => {
  resetTrackCacheForTest();
  let captured;
  const original = globalThis.fetch;
  globalThis.fetch = async (fetchUrl, init) => {
    captured = { fetchUrl, init };
    return new Response(TRACK, { status: 200 });
  };
  try {
    const res = await onRequest(ctx(new Request(url('?icao24=abc123'))));
    assert.equal(res.status, 200);
    assert.equal(await res.text(), TRACK, 'the track document passes through untouched');
    assert.equal(res.headers.get('content-type'), 'application/json; charset=utf-8');
    assert.equal(res.headers.get('cache-control'), 'no-store');

    assert.equal(captured.fetchUrl, 'https://opensky-network.org/api/tracks/all?icao24=abc123&time=0');
    assert.deepEqual(captured.init.headers, {}, '`token ? {...} : {}` — no creds means no headers object');
    assert.ok(captured.init.signal instanceof AbortSignal, 'the upstream call is time-bounded');
  } finally {
    globalThis.fetch = original;
  }
});

test('a repeat within the 60 s TTL is served from cache and burns no credit', async () => {
  resetTrackCacheForTest();
  let calls = 0;
  const original = globalThis.fetch;
  globalThis.fetch = async () => { calls += 1; return new Response(TRACK, { status: 200 }); };
  try {
    const first = await onRequest(ctx(new Request(url('?icao24=aaa001'))));
    const second = await onRequest(ctx(new Request(url('?icao24=AAA001'))));
    assert.equal(await second.text(), TRACK);
    assert.equal(second.headers.get('content-type'), 'application/json; charset=utf-8');
    assert.equal(calls, 1, 'icao24 is lowercased before it becomes the cache key');
    assert.equal(first.headers.get('x-gev-cache'), null, 'dev sets no cache header on these routes');
  } finally {
    globalThis.fetch = original;
  }
});

test('an upstream 404 is forwarded with a sanitized body — and cached', async () => {
  resetTrackCacheForTest();
  let calls = 0;
  const original = globalThis.fetch;
  globalThis.fetch = async () => { calls += 1; return new Response('{"detail":"Not found"}', { status: 404 }); };
  try {
    for (let i = 0; i < 2; i += 1) {
      const res = await onRequest(ctx(new Request(url('?icao24=bad001'))));
      assert.equal(res.status, 404, `attempt ${i} forwards the status`);
      assert.deepEqual(await res.json(), { error: 'Track source HTTP 404' }, 'the upstream body is not surfaced');
      assert.equal(res.headers.get('cache-control'), 'no-store');
    }
    assert.equal(calls, 1, 'the negative answer is cached for the TTL');
  } finally {
    globalThis.fetch = original;
  }
});

test('a 429 is forwarded so the client can fall back to its own trail', async () => {
  resetTrackCacheForTest();
  const original = globalThis.fetch;
  globalThis.fetch = async () => new Response('{"detail":"Throttled"}', { status: 429 });
  try {
    const res = await onRequest(ctx(new Request(url('?icao24=429001'))));
    assert.equal(res.status, 429);
    assert.deepEqual(await res.json(), { error: 'Track source HTTP 429' });
  } finally {
    globalThis.fetch = original;
  }
});

test('a document over the 5 MB cap answers 200 with an error field', async () => {
  resetTrackCacheForTest();
  const original = globalThis.fetch;
  globalThis.fetch = async () => new Response('truncated', {
    status: 200,
    headers: { 'content-length': String(5 * 1024 * 1024 + 1) },
  });
  try {
    const res = await onRequest(ctx(new Request(url('?icao24=cafe01'))));
    assert.equal(res.status, 200, 'dev keeps the upstream status on this branch');
    assert.deepEqual(await res.json(), { error: 'Upstream track response too large' });
  } finally {
    globalThis.fetch = original;
  }
});

test('a failed OAuth exchange degrades to an anonymous read', async () => {
  resetTrackCacheForTest();
  const seen = [];
  const original = globalThis.fetch;
  globalThis.fetch = async (fetchUrl, init) => {
    seen.push({ fetchUrl: String(fetchUrl), init });
    if (String(fetchUrl).includes('auth.opensky-network.org')) {
      return new Response('{"error":"invalid_grant"}', { status: 400 });
    }
    return new Response(TRACK, { status: 200 });
  };
  try {
    const res = await onRequest(ctx(new Request(url('?icao24=000001')), {
      OPENSKY_CLIENT_ID: 'id',
      OPENSKY_CLIENT_SECRET: 'secret',
    }));
    assert.equal(res.status, 200);
    const trackCall = seen.at(-1);
    assert.deepEqual(trackCall.init.headers, {}, 'no token, no Authorization header');
    assert.equal(seen.filter((c) => c.fetchUrl.includes('auth.opensky-network.org')).length, 1);
  } finally {
    globalThis.fetch = original;
  }
});

test('a minted token is sent as a Bearer credential and reused across requests', async () => {
  resetTrackCacheForTest();
  const seen = [];
  const original = globalThis.fetch;
  globalThis.fetch = async (fetchUrl, init) => {
    seen.push({ fetchUrl: String(fetchUrl), init });
    if (String(fetchUrl).includes('auth.opensky-network.org')) {
      return new Response(JSON.stringify({ access_token: 'tok-1', expires_in: 1800 }), { status: 200 });
    }
    return new Response(TRACK, { status: 200 });
  };
  try {
    const env = { OPENSKY_CLIENT_ID: 'id', OPENSKY_CLIENT_SECRET: 'secret' };
    await onRequest(ctx(new Request(url('?icao24=aaa002')), env));
    await onRequest(ctx(new Request(url('?icao24=bbb003')), env));

    const tokenCalls = seen.filter((c) => c.fetchUrl.includes('auth.opensky-network.org'));
    assert.equal(tokenCalls.length, 1, 'the token is module-cached until near expiry');

    const tokenInit = tokenCalls[0].init;
    assert.equal(tokenInit.method, 'POST');
    assert.equal(tokenInit.headers['Content-Type'], 'application/x-www-form-urlencoded');
    assert.equal(
      tokenInit.body,
      'grant_type=client_credentials&client_id=id&client_secret=secret',
      'the client_credentials grant body is form-encoded',
    );

    const trackCalls = seen.filter((c) => !c.fetchUrl.includes('auth.opensky-network.org'));
    assert.equal(trackCalls.length, 2);
    for (const call of trackCalls) {
      assert.equal(call.init.headers.Authorization, 'Bearer tok-1');
    }
    assert.deepEqual(
      trackCalls.map((c) => c.fetchUrl),
      [
        'https://opensky-network.org/api/tracks/all?icao24=aaa002&time=0',
        'https://opensky-network.org/api/tracks/all?icao24=bbb003&time=0',
      ],
    );
  } finally {
    globalThis.fetch = original;
  }
});

test('a transport failure answers the dev 502 shape', async () => {
  resetTrackCacheForTest();
  const original = globalThis.fetch;
  globalThis.fetch = async () => { throw new Error('connect ECONNREFUSED'); };
  try {
    const res = await onRequest(ctx(new Request(url('?icao24=abc123'))));
    assert.equal(res.status, 502);
    assert.deepEqual(await res.json(), { error: 'OpenSky track fetch failed' });
    assert.equal(res.headers.get('content-type'), 'application/json');
  } finally {
    globalThis.fetch = original;
  }
});
