// functions/api/geocode.test.mjs
/**
 * Contract tests for the `/api/geocode` Pages Function — the workerd adapter
 * over the shared `resolveGeocodeRequest` core (fully covered in
 * `src/data/geocodePolicy.test.mjs`). These pin the adapter surface only:
 * Request/env plumbing, the Response envelope, and the NOMINATIM_BASE_URL
 * override. No real network.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { onRequest } from './geocode.js';
import { NOMINATIM_SEARCH_ENDPOINT } from '../../src/data/geocodePolicy.js';

const ROW = {
  category: 'place',
  type: 'city',
  display_name: 'Austin, Travis County, Texas, USA',
  lat: '30.267153',
  lon: '-97.743057',
  boundingbox: ['30.1', '30.6', '-98.0', '-97.5'],
};

function ctx(search, env = {}) {
  return { request: new Request(`https://example.com/api/geocode${search}`), env };
}

function stubFetch(impl) {
  const calls = [];
  const original = globalThis.fetch;
  globalThis.fetch = (url, init) => {
    calls.push({ url: String(url), init });
    return impl(url, init);
  };
  return { calls, restore() { globalThis.fetch = original; } };
}

test('GET resolves a query through the shared core and stamps the envelope', async () => {
  const stub = stubFetch(async (url) => {
    assert.equal(String(url).startsWith(NOMINATIM_SEARCH_ENDPOINT), true, String(url));
    return new Response(JSON.stringify([ROW]), { status: 200 });
  });
  try {
    const res = await onRequest(ctx('?q=austin&limit=3'));
    assert.equal(res.status, 200);
    assert.match(res.headers.get('Content-Type') || '', /^application\/json/);
    assert.equal(res.headers.get('Cache-Control'), 'public, max-age=60');
    assert.equal(res.headers.get('X-GEV-Cache'), 'MISS');
    const body = await res.json();
    assert.equal(body.results.length, 1);
    assert.equal(body.results[0].label, 'Austin, Travis County, Texas, USA');
    assert.equal(body.results[0].viewport.southwest.lat, 30.1);
    assert.equal(body.attribution, '© OpenStreetMap contributors');
    assert.equal(stub.calls[0].init.headers['User-Agent'], 'gods-eye-view/1.0 (+https://github.com/bilawalsidhu/gods-eye-view)');
  } finally {
    stub.restore();
  }
});

test('a repeat query is served from the per-isolate cache without upstream calls', async () => {
  const stub = stubFetch(async () => new Response(JSON.stringify([ROW]), { status: 200 }));
  try {
    await onRequest(ctx('?q=cache-me'));
    const res = await onRequest(ctx('?q=cache-me'));
    assert.equal(res.headers.get('X-GEV-Cache'), 'HIT');
    assert.equal(stub.calls.length, 1);
  } finally {
    stub.restore();
  }
});

test('non-GET is a 405 and a bad query a 400, both no-store', async () => {
  const stub = stubFetch(async () => { throw new Error('must not fetch'); });
  try {
    const method = await onRequest({
      request: new Request('https://example.com/api/geocode?q=x', { method: 'POST' }),
      env: {},
    });
    assert.equal(method.status, 405);
    assert.equal(method.headers.get('Cache-Control'), 'no-store');

    const missing = await onRequest(ctx(''));
    assert.equal(missing.status, 400);
    assert.deepEqual(await missing.json(), { error: 'Missing or invalid q parameter' });
    assert.equal(stub.calls.length, 0, 'neither rejection may reach upstream');
  } finally {
    stub.restore();
  }
});

test('NOMINATIM_BASE_URL substitutes the upstream entirely', async () => {
  const stub = stubFetch(async (url) => {
    assert.equal(String(url).startsWith('https://nominatim.internal/search'), true, String(url));
    return new Response(JSON.stringify([ROW]), { status: 200 });
  });
  try {
    const res = await onRequest(ctx('?q=austin', { NOMINATIM_BASE_URL: 'https://nominatim.internal/search' }));
    assert.equal(res.status, 200);
    assert.equal(stub.calls.length, 1);
  } finally {
    stub.restore();
  }
});
