import test from 'node:test';
import assert from 'node:assert/strict';

import {
  TRACK_CACHE_MS,
  TRACK_CACHE_MAX,
  coalesceRequest,
  fetchTrackJson,
  readTextCapped,
  resetTrackCacheForTest,
  trackResponse,
} from './_upstream.js';

const streamOf = (chunks) => new Response(new ReadableStream({
  start(controller) {
    for (const chunk of chunks) controller.enqueue(new TextEncoder().encode(chunk));
    controller.close();
  },
}));

test('readTextCapped returns the body when it fits the cap', async () => {
  const res = streamOf(['hello ', 'world']);
  assert.deepEqual(await readTextCapped(res, 64), { tooLarge: false, text: 'hello world' });
});

test('readTextCapped short-circuits on a declared content-length over the cap', async () => {
  const res = new Response('tiny', { headers: { 'content-length': String(1024 * 1024) } });
  const { tooLarge, text } = await readTextCapped(res, 1024);
  assert.equal(tooLarge, true);
  assert.equal(text, '', 'no partial body is ever returned');
});

test('readTextCapped aborts mid-stream once the running total passes the cap', async () => {
  let cancelled = false;
  const body = new ReadableStream({
    start(controller) {
      controller.enqueue(new TextEncoder().encode('a'.repeat(600)));
      controller.enqueue(new TextEncoder().encode('b'.repeat(600)));
      // No close(): a well-behaved reader has to stop pulling.
    },
    cancel() { cancelled = true; },
  });
  const res = new Response(body);
  const { tooLarge, text } = await readTextCapped(res, 1024);
  assert.equal(tooLarge, true);
  assert.equal(text, '');
  assert.equal(cancelled, true, 'the upstream stream is released');
});

test('coalesceRequest joins concurrent callers onto one promise and labels the owner', async () => {
  const inFlight = new Map();
  let calls = 0;
  const create = async () => {
    calls += 1;
    await new Promise((resolve) => setTimeout(resolve, 5));
    return 'payload';
  };
  const first = coalesceRequest(inFlight, 'k', create);
  const second = coalesceRequest(inFlight, 'k', create);
  assert.equal(first.shared, false, 'the first caller owns the refresh');
  assert.equal(second.shared, true, 'the joiner is told it did not start it');
  assert.equal(await first.promise, 'payload');
  assert.equal(await second.promise, 'payload');
  assert.equal(calls, 1);
  assert.equal(inFlight.size, 0, 'the map drains once the promise settles');
  assert.equal(coalesceRequest(inFlight, 'k', create).shared, false, 'a settled request is not reused');
});

test('coalesceRequest keys are independent and failures do not poison the slot', async () => {
  const inFlight = new Map();
  const failing = coalesceRequest(inFlight, 'a', async () => { throw new Error('boom'); });
  const other = coalesceRequest(inFlight, 'b', async () => 'fine');
  await assert.rejects(failing.promise, /boom/);
  assert.equal(await other.promise, 'fine');
  assert.equal(inFlight.size, 0);
  assert.equal(coalesceRequest(inFlight, 'a', async () => 'retry').promise instanceof Promise, true);
});

test('fetchTrackJson caches any status for the track TTL and replays it verbatim', async () => {
  resetTrackCacheForTest();
  let calls = 0;
  const original = globalThis.fetch;
  globalThis.fetch = async () => {
    calls += 1;
    return new Response('{"detail":"Not found"}', { status: 404 });
  };
  try {
    const first = await fetchTrackJson({ key: 'k:404', upstreamUrl: 'https://up.test/x' });
    assert.equal(first.status, 404, 'the status is preserved');
    assert.equal(first.body, '{"error":"Track source HTTP 404"}', 'the upstream body is sanitized');
    assert.equal(first.cacheHit, false);
    const second = await fetchTrackJson({ key: 'k:404', upstreamUrl: 'https://up.test/x' });
    assert.deepEqual(second, { status: 404, body: '{"error":"Track source HTTP 404"}', cacheHit: true });
    assert.equal(calls, 1, 'the negative answer is cached too');
    assert.equal(TRACK_CACHE_MS, 60000, 'the TTL the two track routes agree on');
    assert.equal(TRACK_CACHE_MAX, 200, 'the ceiling the two track routes agree on');
  } finally {
    globalThis.fetch = original;
  }
});

test('fetchTrackJson sanitizes upstream failures and reports an oversized document', async () => {
  resetTrackCacheForTest();
  const original = globalThis.fetch;
  let n = 0;
  globalThis.fetch = async () => {
    n += 1;
    if (n === 1) return new Response('server on fire', { status: 500 });
    return new Response('truncated', { status: 200, headers: { 'content-length': String(5 * 1024 * 1024 + 1) } });
  };
  try {
    const failed = await fetchTrackJson({ key: 'k:500', upstreamUrl: 'https://up.test/x' });
    assert.equal(failed.status, 500);
    assert.equal(failed.body, '{"error":"Track source HTTP 500"}', 'the upstream body is never surfaced');

    const big = await fetchTrackJson({ key: 'k:big', upstreamUrl: 'https://up.test/x' });
    assert.equal(big.status, 502, 'an oversized body is an upstream failure, not a success');
    assert.equal(big.body, '{"error":"Upstream track response too large"}');
    // The 502 is cached like any upstream status: a retry inside the TTL
    // must not re-download the same oversized document.
    const replay = await fetchTrackJson({ key: 'k:big', upstreamUrl: 'https://up.test/x' });
    assert.equal(replay.status, 502, 'the cached 502 replays for the TTL');
    assert.equal(n, 2, 'the oversize retry never re-fetched upstream');
  } finally {
    globalThis.fetch = original;
  }
});

test('fetchTrackJson passes request headers through and rejects on transport failure', async () => {
  resetTrackCacheForTest();
  let captured;
  const original = globalThis.fetch;
  globalThis.fetch = async (fetchUrl, init) => {
    captured = { fetchUrl, init };
    throw new Error('connect ECONNREFUSED');
  };
  try {
    await assert.rejects(
      fetchTrackJson({ key: 'k:dead', upstreamUrl: 'https://up.test/y', headers: { Authorization: 'Bearer t' } }),
      /ECONNREFUSED/,
    );
    assert.equal(captured.fetchUrl, 'https://up.test/y');
    assert.deepEqual(captured.init.headers, { Authorization: 'Bearer t' });
    assert.ok(captured.init.signal instanceof AbortSignal);
  } finally {
    globalThis.fetch = original;
  }
});

test('trackResponse is the one shape both track routes answer with', () => {
  const res = trackResponse(404, '{"error":"Track source HTTP 404"}');
  assert.equal(res.status, 404);
  assert.equal(res.headers.get('content-type'), 'application/json; charset=utf-8');
  assert.equal(res.headers.get('cache-control'), 'no-store');
});

test('the shared track cache evicts its oldest entry past the ceiling', async () => {
  resetTrackCacheForTest();
  const original = globalThis.fetch;
  globalThis.fetch = async () => new Response('{}', { status: 200 });
  try {
    // Seed the ceiling plus one; the first-seen key must be the one dropped.
    for (let i = 0; i < TRACK_CACHE_MAX; i += 1) {
      await fetchTrackJson({ key: `k:first-${i}`, upstreamUrl: 'https://up.test/x' });
    }
    await fetchTrackJson({ key: 'k:last', upstreamUrl: 'https://up.test/x' });

    // k:first-0 was the oldest — refetching it must hit upstream again.
    let calls = 0;
    globalThis.fetch = async () => { calls += 1; return new Response('{}', { status: 200 }); };
    await fetchTrackJson({ key: 'k:first-0', upstreamUrl: 'https://up.test/x' });
    assert.equal(calls, 1, 'the oldest entry was evicted');

    await fetchTrackJson({ key: 'k:last', upstreamUrl: 'https://up.test/x' });
    assert.equal(calls, 1, 'the newest entries are still warm');
  } finally {
    globalThis.fetch = original;
    resetTrackCacheForTest();
  }
});
