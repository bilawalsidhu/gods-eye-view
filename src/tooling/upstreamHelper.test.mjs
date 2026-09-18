import test from 'node:test';
import assert from 'node:assert/strict';
import {
  PROVIDER_USER_AGENT,
  PROVIDER_STATUSES,
  fetchUpstream,
  fetchUpstreamJson,
  providerStatus,
  statusHeaders,
  createLastGoodStore,
  parseRetryAfter,
  jitteredBackoffMs,
  bboxAround,
  distanceNm,
} from '../../server/providers/common/upstream.js';

const noSleep = async () => {};

test('fetchUpstream sends the descriptive User-Agent, accepts gzip and returns text on 200', async () => {
  const seen = [];
  const result = await fetchUpstream('https://example.test/data', {
    fetchImpl: async (url, init) => {
      seen.push({ url, init });
      return new Response('hello', { status: 200 });
    },
    sleep: noSleep,
  });
  assert.equal(result.ok, true);
  assert.equal(result.text, 'hello');
  assert.equal(result.attempts, 1);
  assert.equal(seen[0].init.headers['User-Agent'], PROVIDER_USER_AGENT);
  assert.match(PROVIDER_USER_AGENT, /^ondemand-spatial\/\d+\.\d+ \(\+https:\/\//);
  assert.match(seen[0].init.headers['Accept-Encoding'], /gzip/);
  assert.ok(seen[0].init.signal instanceof AbortSignal);
});

test('fetchUpstream retries at most `retries` times with jitter on network errors and 5xx, never on 4xx', async () => {
  let calls = 0;
  const waits = [];
  const flaky = await fetchUpstream('https://example.test/flaky', {
    retries: 2,
    fetchImpl: async () => {
      calls += 1;
      if (calls === 1) throw new TypeError('fetch failed');
      if (calls === 2) return new Response('boom', { status: 503 });
      return new Response('ok', { status: 200 });
    },
    sleep: async (ms) => {
      waits.push(ms);
    },
    random: () => 0.5, // jitter factor exactly 1.0
  });
  assert.equal(flaky.ok, true);
  assert.equal(flaky.attempts, 3);
  assert.deepEqual(waits, [250, 500]);

  calls = 0;
  const exhausted = await fetchUpstream('https://example.test/down', {
    retries: 2,
    fetchImpl: async () => {
      calls += 1;
      return new Response('nope', { status: 502 });
    },
    sleep: noSleep,
  });
  assert.equal(exhausted.ok, false);
  assert.equal(exhausted.attempts, 3);
  assert.equal(exhausted.status, 502);
  assert.equal(exhausted.error.code, 'upstream_5xx');
  assert.match(exhausted.error.message, /HTTP 502/);

  calls = 0;
  const rejected = await fetchUpstream('https://example.test/forbidden', {
    retries: 2,
    fetchImpl: async () => {
      calls += 1;
      return new Response('{"error":"Please contact us"}', { status: 403 });
    },
    sleep: noSleep,
  });
  assert.equal(rejected.ok, false);
  assert.equal(rejected.attempts, 1, '4xx is never retried');
  assert.equal(rejected.error.code, 'auth');
});

test('fetchUpstream reports a timeout as its own error code and honours a short Retry-After on 429', async () => {
  const timedOut = await fetchUpstream('https://example.test/slow', {
    timeoutMs: 20,
    retries: 1,
    fetchImpl: (url, init) =>
      new Promise((_, reject) => {
        init.signal.addEventListener('abort', () => {
          const error = new Error('aborted');
          error.name = 'AbortError';
          reject(error);
        });
      }),
    sleep: noSleep,
  });
  assert.equal(timedOut.ok, false);
  assert.equal(timedOut.attempts, 2);
  assert.equal(timedOut.error.code, 'timeout');
  assert.match(timedOut.error.message, /timed out after 20 ms/);

  const waits = [];
  let calls = 0;
  const limited = await fetchUpstream('https://example.test/limited', {
    retries: 1,
    fetchImpl: async () => {
      calls += 1;
      if (calls === 1)
        return new Response('slow down', {
          status: 429,
          headers: { 'Retry-After': '2' },
        });
      return new Response('ok', { status: 200 });
    },
    sleep: async (ms) => {
      waits.push(ms);
    },
  });
  assert.equal(limited.ok, true);
  assert.deepEqual(waits, [2000], 'Retry-After (seconds) drives the wait');

  calls = 0;
  const longCooldown = await fetchUpstream('https://example.test/cooldown', {
    retries: 2,
    fetchImpl: async () => {
      calls += 1;
      return new Response('later', {
        status: 429,
        headers: { 'Retry-After': '120' },
      });
    },
    sleep: noSleep,
  });
  assert.equal(longCooldown.ok, false);
  assert.equal(calls, 1, 'a long Retry-After is not waited out inside the request');
  assert.equal(longCooldown.retryAfterMs, 120_000);
  assert.equal(longCooldown.error.code, 'rate_limited');
});

test('fetchUpstream enforces the body cap and fetchUpstreamJson flags malformed JSON', async () => {
  const big = await fetchUpstream('https://example.test/big', {
    maxBytes: 8,
    fetchImpl: async () => new Response('0123456789abcdef', { status: 200 }),
    sleep: noSleep,
  });
  assert.equal(big.ok, false);
  assert.equal(big.error.code, 'too_large');

  const bad = await fetchUpstreamJson('https://example.test/json', {
    fetchImpl: async () => new Response('not json', { status: 200 }),
    sleep: noSleep,
  });
  assert.equal(bad.ok, false);
  assert.equal(bad.error.code, 'malformed');

  const good = await fetchUpstreamJson('https://example.test/json', {
    fetchImpl: async (url, init) => {
      assert.equal(init.headers.Accept, 'application/json');
      return Response.json({ ok: 1 });
    },
    sleep: noSleep,
  });
  assert.equal(good.ok, true);
  assert.deepEqual(good.json, { ok: 1 });
});

test('fetchUpstream uses globalThis.fetch at call time so test mocks apply', async (t) => {
  t.mock.method(globalThis, 'fetch', async () => new Response('mocked', { status: 200 }));
  const result = await fetchUpstream('https://example.test/mock', { sleep: noSleep });
  assert.equal(result.text, 'mocked');
});

test('providerStatus normalises the envelope and statusHeaders carries it with an edge Cache-Control', () => {
  const now = Date.UTC(2026, 8, 18, 12, 0, 0);
  const status = providerStatus({
    status: 'stale',
    source: 'CelesTrak',
    fetchedAt: now - 90_000,
    error: 'CelesTrak timed out after 10000 ms — served snapshot',
    count: 42,
    now,
  });
  assert.equal(status.status, 'stale');
  assert.equal(status.ageSec, 90);
  assert.equal(status.fetchedAt, '2026-09-18T11:58:30.000Z');
  assert.equal(status.count, 42);
  assert.deepEqual(PROVIDER_STATUSES, ['live', 'stale', 'degraded', 'unavailable']);
  assert.equal(providerStatus({ status: 'bogus', source: 'x' }).status, 'unavailable');

  const headers = statusHeaders(status, {
    edgeMaxAgeSec: 3600,
    staleWhileRevalidateSec: 86400,
  });
  assert.equal(headers['X-Provider-Status'], 'stale');
  assert.equal(headers['X-Provider-Source'], 'CelesTrak');
  assert.equal(headers['X-Provider-Age-Sec'], '90');
  assert.equal(headers['X-Provider-Count'], '42');
  assert.equal(headers['X-Provider-Error'], 'CelesTrak timed out after 10000 ms - served snapshot');
  assert.equal(
    headers['Cache-Control'],
    'public, max-age=0, s-maxage=3600, stale-while-revalidate=86400',
  );
  assert.equal(statusHeaders(status)['Cache-Control'], 'no-store');
});

test('createLastGoodStore keeps bounded per-key entries with fetchedAt and source', () => {
  const store = createLastGoodStore({ maxEntries: 2 });
  store.set('a', 1, { fetchedAt: 10, source: 'A' });
  store.set('b', 2, { fetchedAt: 20, source: 'B' });
  store.set('c', 3, { fetchedAt: 30, source: 'C' });
  assert.equal(store.get('a'), null, 'oldest entry evicted');
  assert.deepEqual(store.get('c'), { value: 3, fetchedAt: 30, source: 'C', meta: null });
  assert.equal(store.size, 2);
});

test('parseRetryAfter, jitteredBackoffMs, bboxAround and distanceNm behave', () => {
  const now = Date.UTC(2026, 8, 18, 12, 0, 0);
  assert.equal(parseRetryAfter('30', now), 30_000);
  assert.equal(parseRetryAfter('Fri, 18 Sep 2026 12:01:00 GMT', now), 60_000);
  assert.equal(parseRetryAfter('garbage', now), null);
  assert.equal(parseRetryAfter(null, now), null);
  assert.equal(jitteredBackoffMs(0, () => 0), 125);
  assert.equal(jitteredBackoffMs(0, () => 1), 375);
  assert.equal(jitteredBackoffMs(5, () => 1), 1500, 'capped at 1.5 s');
  assert.deepEqual(bboxAround(30.2672, -97.7431, 1.5), {
    lamin: 28.767,
    lamax: 31.767,
    lomin: -99.243,
    lomax: -96.243,
  });
  assert.equal(bboxAround(89.9, 179.9, 1.5).lamax, 90);
  assert.equal(bboxAround(89.9, 179.9, 1.5).lomax, 180);
  assert.equal(bboxAround('x', 1), null);
  // Austin → Houston is ≈ 128 nm.
  const nm = distanceNm(30.2672, -97.7431, 29.7604, -95.3698);
  assert.ok(nm > 125 && nm < 131, `got ${nm}`);
});
