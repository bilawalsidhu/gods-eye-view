import test from 'node:test';
import assert from 'node:assert/strict';

import { onRequest } from './trace.js';
import { resetTrackCacheForTest } from '../../_upstream.js';

const url = (query = '') => `https://example.com/api/adsblol/trace${query}`;
const ctx = (request) => ({ request, env: {} });

const TRACE = JSON.stringify({
  icao: 'ae4c5d',
  r: '05-4613',
  t: 'C17',
  trace: [[1710000000, 51.4, 12.5, 11000, 250, 270]],
});

test('a bad hex gets the dev 400 shape without touching adsb.lol', async () => {
  resetTrackCacheForTest();
  const calls = [];
  const original = globalThis.fetch;
  globalThis.fetch = async (...args) => { calls.push(args); throw new Error('no'); };
  try {
    for (const query of ['', '?hex=', '?hex=abc12', '?hex=abc12345', '?hex=zzzzzz', '?hex=~abc1']) {
      const res = await onRequest(ctx(new Request(url(query))));
      assert.equal(res.status, 400, JSON.stringify(query));
      assert.deepEqual(await res.json(), { error: 'hex must be a 6-7 char hex string' }, query);
      assert.equal(res.headers.get('content-type'), 'application/json', 'the 400 carries no charset');
    }
    assert.equal(calls.length, 0, 'a rejected hex never reaches the trace store');
  } finally {
    globalThis.fetch = original;
  }
});

test('a trace is read from the shard named after the last two hex chars', async () => {
  resetTrackCacheForTest();
  let captured;
  const original = globalThis.fetch;
  globalThis.fetch = async (fetchUrl, init) => {
    captured = { fetchUrl, init };
    return new Response(TRACE, { status: 200 });
  };
  try {
    const res = await onRequest(ctx(new Request(url('?hex=ae4c5d'))));
    assert.equal(res.status, 200);
    assert.equal(await res.text(), TRACE, 'the trace document passes through untouched');
    assert.equal(res.headers.get('content-type'), 'application/json; charset=utf-8');
    assert.equal(res.headers.get('cache-control'), 'no-store');

    assert.equal(captured.fetchUrl, 'https://adsb.lol/data/traces/5d/trace_full_ae4c5d.json');
    assert.deepEqual(captured.init.headers, {}, 'this route sends no auth and no User-Agent override');
    assert.ok(captured.init.signal instanceof AbortSignal, 'the upstream call is time-bounded');
  } finally {
    globalThis.fetch = original;
  }
});

test('hex is lowercased before it becomes the cache key and the URL', async () => {
  resetTrackCacheForTest();
  const seen = [];
  const original = globalThis.fetch;
  globalThis.fetch = async (fetchUrl) => { seen.push(String(fetchUrl)); return new Response(TRACE, { status: 200 }); };
  try {
    const res = await onRequest(ctx(new Request(url('?hex=AE4C5D'))));
    assert.equal(await res.text(), TRACE);
    assert.deepEqual(seen, ['https://adsb.lol/data/traces/5d/trace_full_ae4c5d.json']);
  } finally {
    globalThis.fetch = original;
  }
});

test('the 7-char TIS-B form (leading ~) resolves through the same shard scheme', async () => {
  resetTrackCacheForTest();
  const seen = [];
  const original = globalThis.fetch;
  globalThis.fetch = async (fetchUrl) => { seen.push(String(fetchUrl)); return new Response(TRACE, { status: 200 }); };
  try {
    const res = await onRequest(ctx(new Request(url('?hex=~ae12c4'))));
    assert.equal(res.status, 200);
    assert.equal(await res.text(), TRACE);
    assert.deepEqual(seen, ['https://adsb.lol/data/traces/c4/trace_full_~ae12c4.json']);
  } finally {
    globalThis.fetch = original;
  }
});

test('seven chars and a tilde anywhere in the address are both legal here', async () => {
  // Unlike /api/opensky-track (strict hex6), this route accepts the 7-char
  // TIS-B form — and dev's /^[0-9a-f~]{6,7}$/ puts the `~` anywhere in the
  // string, not just at the front.
  resetTrackCacheForTest();
  const seen = [];
  const original = globalThis.fetch;
  globalThis.fetch = async (fetchUrl) => { seen.push(String(fetchUrl)); return new Response(TRACE, { status: 200 }); };
  try {
    const seven = await onRequest(ctx(new Request(url('?hex=ae4c5de'))));
    assert.equal(seven.status, 200);
    const tildeLast = await onRequest(ctx(new Request(url('?hex=ae4c5~'))));
    assert.equal(tildeLast.status, 200);
    assert.deepEqual(seen, [
      'https://adsb.lol/data/traces/de/trace_full_ae4c5de.json',
      'https://adsb.lol/data/traces/5~/trace_full_ae4c5~.json',
    ]);
  } finally {
    globalThis.fetch = original;
  }
});

test('a repeat within the 60 s TTL is served from the shared track cache', async () => {
  resetTrackCacheForTest();
  let calls = 0;
  const original = globalThis.fetch;
  globalThis.fetch = async () => { calls += 1; return new Response(TRACE, { status: 200 }); };
  try {
    await onRequest(ctx(new Request(url('?hex=ae4c5e'))));
    const second = await onRequest(ctx(new Request(url('?hex=ae4c5e'))));
    assert.equal(await second.text(), TRACE);
    assert.equal(second.headers.get('content-type'), 'application/json; charset=utf-8');
    assert.equal(calls, 1);
  } finally {
    globalThis.fetch = original;
  }
});

test('a 404 is forwarded with a sanitized body — and cached like any status', async () => {
  resetTrackCacheForTest();
  let calls = 0;
  const original = globalThis.fetch;
  globalThis.fetch = async () => { calls += 1; return new Response('{"detail":"Not found"}', { status: 404 }); };
  try {
    for (let i = 0; i < 2; i += 1) {
      const res = await onRequest(ctx(new Request(url('?hex=dead01'))));
      assert.equal(res.status, 404, `attempt ${i} forwards the status`);
      assert.deepEqual(await res.json(), { error: 'Track source HTTP 404' }, 'no upstream body is surfaced');
      assert.equal(res.headers.get('cache-control'), 'no-store');
    }
    assert.equal(calls, 1);
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
    const res = await onRequest(ctx(new Request(url('?hex=cafe02'))));
    assert.equal(res.status, 200, 'dev keeps the upstream status on this branch');
    assert.deepEqual(await res.json(), { error: 'Upstream track response too large' });
  } finally {
    globalThis.fetch = original;
  }
});

test('a transport failure answers the dev 502 shape', async () => {
  resetTrackCacheForTest();
  const original = globalThis.fetch;
  globalThis.fetch = async () => { throw new Error('connect ECONNREFUSED'); };
  try {
    const res = await onRequest(ctx(new Request(url('?hex=abc123'))));
    assert.equal(res.status, 502);
    assert.deepEqual(await res.json(), { error: 'adsb.lol trace fetch failed' });
    assert.equal(res.headers.get('content-type'), 'application/json');
  } finally {
    globalThis.fetch = original;
  }
});
