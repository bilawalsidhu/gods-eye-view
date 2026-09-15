// Contract tests for the /api/opensky Pages Function's viewport scoping —
// the body-cap/bbox-clamp sweep (docs/PLAN.md Phase 7). The handler once
// forwarded a raw `bbox=lamax,lamin,lomin,romax` passthrough (no client ever
// sent it) and fed unvalidated lat/lon strings into the upstream query; these
// pin the validated replacement.
//
// Run with: npm test   (node --test)
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { OPENSKY_BOX_HALF_DEG, buildOpenSkyStatesUrl, onRequest } from './opensky.js';

const queryOf = (search) => new URL(`https://example.com/api/opensky${search}`).searchParams;

test('camera lat/lon derive the ~250 km query box', () => {
  const url = buildOpenSkyStatesUrl(queryOf('?lat=29.4259&lon=-98.4861'));
  assert.equal(url.pathname, '/api/states/all');
  assert.equal(Number(url.searchParams.get('lamin')), 29.4259 - OPENSKY_BOX_HALF_DEG);
  assert.equal(Number(url.searchParams.get('lamax')), 29.4259 + OPENSKY_BOX_HALF_DEG);
  assert.equal(Number(url.searchParams.get('lomin')), -98.4861 - OPENSKY_BOX_HALF_DEG);
  assert.equal(Number(url.searchParams.get('romax')), -98.4861 + OPENSKY_BOX_HALF_DEG);
});

test('the derived box is clamped to the planet', () => {
  const url = buildOpenSkyStatesUrl(queryOf('?lat=89.9&lon=179.9'));
  assert.equal(Number(url.searchParams.get('lamax')), 90);
  assert.equal(Number(url.searchParams.get('romax')), 180);
  assert.ok(Number(url.searchParams.get('lamin')) > 80);
});

test('absent, malformed, and out-of-range coordinates degrade to the global fetch', () => {
  for (const search of ['', '?lat=999&lon=0', '?lat=29.4&lon=-999', '?lat=abc&lon=def', '?lat=91&lon=0', '?lat=0&lon=181']) {
    const url = buildOpenSkyStatesUrl(queryOf(search));
    assert.equal(
      url.searchParams.toString(),
      '',
      `${search || '(no query)'} must not produce a partial box`,
    );
  }
});

test('the raw bbox passthrough is gone', () => {
  // Nothing in the client ever sent it; it forwarded arbitrary strings into
  // the upstream query string.
  const url = buildOpenSkyStatesUrl(queryOf('?bbox=1,2,3,<script>'));
  assert.equal(url.searchParams.toString(), '');
});

// ── onRequest handler: upstream wiring, auth, caching, failure shape ───────

/** Capture the outbound fetch; answer with a canned upstream Response. */
function stubFetch(responder) {
  const saved = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, init) => {
    calls.push({ url: String(url), init });
    return responder();
  };
  return { calls, restore: () => { globalThis.fetch = saved; } };
}

const get = (search) => new Request(`https://example.com/api/opensky${search}`);

test('OPTIONS is answered with a bare CORS preflight', async () => {
  const res = await onRequest({ request: new Request('https://example.com/api/opensky', { method: 'OPTIONS' }), env: {} });
  assert.equal(res.status, 204);
  assert.equal(res.headers.get('Access-Control-Allow-Origin'), '*');
  assert.match(res.headers.get('Access-Control-Allow-Methods') ?? '', /GET/);
});

test('GET forwards the derived box with the project User-Agent', async () => {
  const upstream = new Response('{}', { status: 200 });
  const fetcher = stubFetch(() => upstream);
  try {
    const res = await onRequest({ request: get('?lat=29.4&lon=-98.5'), env: {} });
    assert.equal(res.status, 200);
    const call = fetcher.calls[0];
    assert.ok(call.url.includes('lamin=26.9'), `box in upstream URL: ${call.url}`);
    assert.match(call.init.headers['User-Agent'] ?? '', /gods-eye-view/);
    assert.equal(call.init.headers.Authorization, undefined, 'no credentials configured, no auth header');
  } finally {
    fetcher.restore();
  }
});

test('configured credentials ride along as Basic auth', async () => {
  const fetcher = stubFetch(() => new Response('{}', { status: 200 }));
  try {
    await onRequest({
      request: get(''),
      env: { OPENSKY_USERNAME: 'user@example.com', OPENSKY_PASSWORD: 'secret:word' },
    });
    const expected = `Basic ${btoa('user@example.com:secret:word')}`;
    assert.equal(fetcher.calls[0].init.headers.Authorization, expected);
    assert.equal(fetcher.calls[0].url, 'https://opensky-network.org/api/states/all', 'no box without coordinates');
  } finally {
    fetcher.restore();
  }
});

test('only a full credential pair authenticates', async () => {
  for (const env of [{ OPENSKY_USERNAME: 'u' }, { OPENSKY_PASSWORD: 'p' }]) {
    const fetcher = stubFetch(() => new Response('{}', { status: 200 }));
    try {
      await onRequest({ request: get(''), env });
      assert.equal(fetcher.calls[0].init.headers.Authorization, undefined, JSON.stringify(env));
    } finally {
      fetcher.restore();
    }
  }
});

test('a 200 upstream is edge-cached, a 429 is passed through uncached', async () => {
  const fetcher = stubFetch(() => new Response('{"states":[]}', { status: 200 }));
  try {
    const res = await onRequest({ request: get(''), env: {} });
    assert.equal(res.headers.get('Cache-Control'), 'public, max-age=8, stale-while-revalidate=4');
    assert.equal(res.headers.get('Vary'), 'Accept-Encoding');
    assert.equal(res.headers.get('Access-Control-Allow-Origin'), '*');
    assert.deepEqual(await res.json(), { states: [] });
  } finally {
    fetcher.restore();
  }

  const limited = stubFetch(() => new Response('nope', { status: 429 }));
  try {
    const res = await onRequest({ request: get(''), env: {} });
    assert.equal(res.status, 429);
    assert.equal(res.headers.get('Cache-Control'), null, 'failures must not be edge-cached');
    assert.equal(res.headers.get('Access-Control-Allow-Origin'), '*');
  } finally {
    limited.restore();
  }
});

test('an upstream failure degrades to the shared JSON error shape', async () => {
  const saved = globalThis.fetch;
  globalThis.fetch = async () => { throw new Error('boom'); };
  try {
    const res = await onRequest({ request: get(''), env: {} });
    assert.equal(res.status, 500);
    assert.equal(res.headers.get('Content-Type'), 'application/json');
    assert.equal(res.headers.get('Access-Control-Allow-Origin'), '*');
    const body = await res.json();
    assert.match(body.error, /OpenSky proxy error/);
    assert.match(body.error, /boom/);
  } finally {
    globalThis.fetch = saved;
  }
});
