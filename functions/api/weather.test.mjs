import test from 'node:test';
import assert from 'node:assert/strict';

import { onRequest } from './weather.ts';

const ctx = (request) => ({ request });
const get = (query = '') => new Request(`https://example.com/api/weather${query}`);

/** Replace global fetch and record every call; restores afterwards. */
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

test('proxies to the Open-Meteo v1 forecast endpoint, rewriting host+path', async () => {
  // The handler rewrites ONLY the origin parts of the request URL and passes
  // the caller's query straight through, so a client cannot steer the proxy
  // off the forecast endpoint but CAN pick coordinates and models.
  const stub = stubFetch(() => new Response('{"ok":true}', { status: 200 }));
  try {
    const res = await onRequest(ctx(get('?latitude=32.7&longitude=-117.2&hourly=temperature_2m')));
    assert.equal(res.status, 200);
    assert.equal(await res.text(), '{"ok":true}');
    assert.equal(stub.calls.length, 1);
    const upstream = new URL(stub.calls[0].url);
    assert.equal(upstream.host, 'api.open-meteo.com');
    assert.equal(upstream.pathname, '/v1/forecast');
    assert.equal(upstream.searchParams.get('latitude'), '32.7');
    assert.equal(upstream.searchParams.get('longitude'), '-117.2');
    assert.equal(upstream.searchParams.get('hourly'), 'temperature_2m');
  } finally {
    stub.restore();
  }
});

test('upstream errors pass through with CORS added, not swallowed', async () => {
  const stub = stubFetch(() => new Response('rate limited', { status: 429 }));
  try {
    const res = await onRequest(ctx(get()));
    assert.equal(res.status, 429);
    assert.equal(await res.text(), 'rate limited');
    assert.equal(res.headers.get('access-control-allow-origin'), '*');
  } finally {
    stub.restore();
  }
});

test('a failed upstream fetch becomes a JSON 500, not an unhandled throw', async () => {
  const stub = stubFetch(() => { throw new Error('upstream unreachable'); });
  try {
    const res = await onRequest(ctx(get()));
    assert.equal(res.status, 500);
    const body = await res.json();
    assert.equal(body.error, 'Weather proxy error');
    assert.equal(res.headers.get('content-type'), 'application/json');
    assert.equal(res.headers.get('access-control-allow-origin'), '*');
  } finally {
    stub.restore();
  }
});

test('upstream calls carry a 15 s timeout signal', async () => {
  const stub = stubFetch(() => new Response('{}', { status: 200 }));
  try {
    await onRequest(ctx(get()));
    const signal = stub.calls[0].init?.signal;
    assert.ok(signal instanceof AbortSignal, 'fetch init must carry an AbortSignal');
  } finally {
    stub.restore();
  }
});

test('CORS preflight answers 204 with the GET/OPTIONS policy', async () => {
  const res = await onRequest(ctx(new Request(get(), { method: 'OPTIONS' })));
  assert.equal(res.status, 204);
  assert.equal(await res.text(), '');
  assert.equal(res.headers.get('access-control-allow-origin'), '*');
  assert.equal(res.headers.get('access-control-allow-methods'), 'GET, OPTIONS');
  assert.equal(res.headers.get('access-control-max-age'), '86400');
});
