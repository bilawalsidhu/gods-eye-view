import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createOpenDataService,
  nextOpenDataBackoffMs,
  openDataRedirectDecision,
} from './openDataProxy.js';

function jsonResponse(payload, init = {}) {
  return new Response(JSON.stringify(payload), {
    status: init.status ?? 200,
    headers: { 'Content-Type': 'application/json', ...(init.headers || {}) },
  });
}

test('nextOpenDataBackoffMs grows with consecutive failures', () => {
  const first = nextOpenDataBackoffMs(1);
  const second = nextOpenDataBackoffMs(2);
  const third = nextOpenDataBackoffMs(3);
  assert.ok(second > first, 'second wait exceeds first');
  assert.ok(third > second, 'third wait exceeds second');
});

test('openDataRedirectDecision accepts a same-origin https redirect', () => {
  const decision = openDataRedirectDecision(
    'https://example.test/api/x',
    'https://example.test/api/y',
  );
  assert.equal(decision.ok, true);
});

test('openDataRedirectDecision rejects a cross-origin redirect', () => {
  const decision = openDataRedirectDecision(
    'https://example.test/api/x',
    'https://evil.test/api/y',
  );
  assert.equal(decision.ok, false);
});

test('openDataRedirectDecision rejects a downgrade to http', () => {
  const decision = openDataRedirectDecision(
    'https://example.test/api/x',
    'http://example.test/api/y',
  );
  assert.equal(decision.ok, false);
});

test('service serves a cached payload without a second upstream call', async () => {
  let calls = 0;
  const service = createOpenDataService({
    id: 'test',
    routes: new Map([['thing', 'https://example.test/thing']]),
    loader: async () => {
      calls += 1;
      return { ok: true };
    },
    ttlMs: 60_000,
    fetchImpl: async () => jsonResponse({ ok: true }),
  });
  const first = await service.handle({
    url: 'http://localhost/api/x/thing',
    method: 'GET',
  });
  assert.equal(first.status, 200);
  const second = await service.handle({
    url: 'http://localhost/api/x/thing',
    method: 'GET',
  });
  assert.equal(second.status, 200);
  assert.equal(calls, 1, 'second read is served from cache');
});

test('service rejects a non-GET method', async () => {
  const service = createOpenDataService({
    id: 'test',
    routes: new Map([['thing', 'https://example.test/thing']]),
    loader: async () => ({ ok: true }),
    fetchImpl: async () => jsonResponse({ ok: true }),
  });
  const response = await service.handle({
    url: 'http://localhost/api/x/thing',
    method: 'POST',
  });
  assert.equal(response.status, 405);
});

test('a preflight gate short-circuits the upstream', async () => {
  let calls = 0;
  const service = createOpenDataService({
    id: 'test',
    routes: new Map([['thing', 'https://example.test/thing']]),
    loader: async () => ({ ok: true }),
    preflight: () => ({ status: 503, payload: { error: 'key missing' } }),
    fetchImpl: async () => {
      calls += 1;
      return jsonResponse({ ok: true });
    },
  });
  const response = await service.handle({
    url: 'http://localhost/api/x/thing',
    method: 'GET',
  });
  assert.equal(response.status, 503);
  assert.equal(calls, 0, 'upstream must not be contacted');
});
