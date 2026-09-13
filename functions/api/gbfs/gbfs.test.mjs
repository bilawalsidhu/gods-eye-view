// Pages Function tests for /api/gbfs/[[path]] — mirrors the dev middleware
// contract (vite/proxies/gbfs.js): the full SSRF guard chain in the same
// order, redirect refusal, the 5 MB body cap, and the relay headers.
// Offline via a stubbed globalThis.fetch.
//
// Named without brackets: `node --test` silently skips bracketed paths.
// Run with: npm test   (node --test)
import test from 'node:test';
import assert from 'node:assert/strict';

import { onRequest } from './[[path]].js';

const BASE = 'https://example.com/api/gbfs';
const url = (target) => `${BASE}/${encodeURIComponent(target)}`;
const ctx = (request) => ({ request });

const AUSTIN_INFO = 'https://austin.publicbikesystem.net/ube/gbfs/v1/en/station_information.json';

/** Stub upstream fetches; records every URL + init. */
function stubUpstream(handler) {
  const calls = [];
  const original = globalThis.fetch;
  globalThis.fetch = async (fetchUrl, init) => {
    calls.push({ fetchUrl: String(fetchUrl), init });
    return handler(fetchUrl, init);
  };
  return { calls, restore() { globalThis.fetch = original; } };
}

async function expectJson(res, status, body) {
  assert.equal(res.status, status);
  assert.deepEqual(await res.json(), body);
}

test('the guard chain matches the dev middleware byte for byte and never fetches', async () => {
  const upstream = stubUpstream(() => { throw new Error('must not fetch'); });
  try {
    const cases = [
      // [raw-request-URL-or-target, status, error]
      [null, 405, 'Method Not Allowed'],
      [`${BASE}/`, 400, 'Missing GBFS upstream target'],
      // A raw undecodable %zz path (encodeURIComponent would launder the %).
      [`${BASE}/%zz`, 400, 'Invalid GBFS target encoding'],
      ['not a url', 400, 'Invalid GBFS upstream URL'],
      ['http://gbfs.lyft.com/uberide/station_information.json', 400, 'Only https GBFS targets are allowed'],
      ['https://evil.example.com/station_information.json', 403, 'GBFS host not allowed'],
      ['https://gbfs.lyft.com/ube/gbfs/v1/en/vehicle_status.json', 400, 'Only station_information/station_status endpoints are allowed'],
    ];
    for (const [target, status, error] of cases) {
      const raw = target === null ? BASE : target.startsWith(BASE) ? target : url(target);
      const req = new Request(raw, { method: target === null ? 'POST' : 'GET' });
      await expectJson(await onRequest(ctx(req)), status, { error });
    }
    assert.equal(upstream.calls.length, 0);
  } finally {
    upstream.restore();
  }
});

test('an allowlisted station feed is relayed with the dev headers and cache-control', async () => {
  const body = JSON.stringify({ data: { stations: [{ station_id: '42', name: 'Congress & 4th' }] } });
  const upstream = stubUpstream(() => new Response(body, {
    status: 200,
    headers: { 'content-type': 'application/json' },
  }));
  try {
    const res = await onRequest(ctx(new Request(url(AUSTIN_INFO))));
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('content-type'), 'application/json');
    assert.equal(res.headers.get('cache-control'), 'public, max-age=300', 'station_information is semi-static');
    assert.equal(res.headers.get('x-gbfs-upstream'), 'austin.publicbikesystem.net');
    assert.equal(res.headers.get('x-gbfs-cache'), 'MISS');
    assert.deepEqual(await res.json(), JSON.parse(body));
    assert.equal(upstream.calls.length, 1);
    assert.equal(upstream.calls[0].fetchUrl, AUSTIN_INFO, 'target arrives percent-encoded and is decoded exactly once');
    assert.equal(upstream.calls[0].init.redirect, 'manual');
  } finally {
    upstream.restore();
  }
});

test('station_status is real-time: relays no-store', async () => {
  const upstream = stubUpstream(() => new Response('{"data":{"stations":[]}}', {
    status: 200,
    headers: { 'content-type': 'application/json' },
  }));
  try {
    const res = await onRequest(ctx(new Request(url(
      'https://gbfs.bluebikes.com/gbfs/en/station_status.json'
    ))));
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('cache-control'), 'no-store');
  } finally {
    upstream.restore();
  }
});

test('an upstream redirect is refused, not followed (allowlist stays authoritative)', async () => {
  const upstream = stubUpstream(() => new Response(null, {
    status: 302,
    headers: { location: 'https://evil.example.com/payload' },
  }));
  try {
    await expectJson(
      await onRequest(ctx(new Request(url(AUSTIN_INFO)))),
      502,
      { error: 'GBFS upstream redirects are not followed' },
    );
    assert.equal(upstream.calls.length, 1);
  } finally {
    upstream.restore();
  }
});

test('an oversized upstream body is capped at 5 MB', async () => {
  const big = 'x'.repeat(5 * 1024 * 1024 + 1);
  const upstream = stubUpstream(() => new Response(big, {
    status: 200,
    headers: { 'content-type': 'application/json' },
  }));
  try {
    await expectJson(
      await onRequest(ctx(new Request(url(AUSTIN_INFO)))),
      502,
      { error: 'GBFS upstream response too large' },
    );
  } finally {
    upstream.restore();
  }
});

test('upstream timeout and transport failure get the dev 504/502 shapes', async () => {
  const timeout = stubUpstream(() => {
    const err = new Error('The operation was aborted due to timeout');
    err.name = 'TimeoutError';
    throw err;
  });
  try {
    await expectJson(
      await onRequest(ctx(new Request(url(AUSTIN_INFO)))),
      504,
      { error: 'GBFS upstream timeout' },
    );
  } finally {
    timeout.restore();
  }

  const abort = stubUpstream(() => {
    const err = new Error('This operation was aborted');
    err.name = 'AbortError';
    throw err;
  });
  try {
    await expectJson(
      await onRequest(ctx(new Request(url(AUSTIN_INFO)))),
      504,
      { error: 'GBFS upstream timeout' },
    );
  } finally {
    abort.restore();
  }

  const broken = stubUpstream(() => { throw new Error('getaddrinfo EAI_AGAIN'); });
  try {
    await expectJson(
      await onRequest(ctx(new Request(url(AUSTIN_INFO)))),
      502,
      { error: 'GBFS proxy error' },
    );
  } finally {
    broken.restore();
  }
});
