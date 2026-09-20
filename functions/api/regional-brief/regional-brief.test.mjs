// functions/api/regional-brief/regional-brief.test.mjs
//
// The Pages Function is a thin workerd adapter (limiter + cache maps) over
// the shared `resolveRegionalBriefRequest` core, whose branches are covered
// exhaustively in `src/data/regionalBriefPolicy.test.mjs`. These tests pin
// the adapter shell: method gating, rate limiting, header/status passthrough,
// and one end-to-end MISS→HIT cycle with a mocked upstream fetch.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { onRequest } from './index.js';

const get = (query = '') => new Request(`https://example.com/api/regional-brief${query}`);
const ctx = (request) => ({ request });

/** Mock upstream fetch keyed by upstream-substring, as in the core tests. */
function mockFetch(bySubstring = {}) {
  return (url) => {
    const entry = Object.entries(bySubstring).find(([needle]) => String(url).includes(needle));
    if (!entry) return new Response('nope', { status: 404 });
    const [_, body] = entry;
    return new Response(typeof body === 'string' ? body : JSON.stringify(body), {
      status: 200,
      headers: { 'Content-Type': typeof body === 'string' ? 'application/rss+xml' : 'application/json' },
    });
  };
}

const UPSTREAM = {
  'nominatim.openstreetmap.org': {
    address: { city: 'Duluth', state: 'Minnesota', country: 'United States' },
    display_name: 'Duluth, Minnesota, United States',
  },
  'open-meteo.com': { current: { weather_code: 0, temperature_2m: 4.2 } },
  'news.google.com': '<rss><channel><item><title>Fresh story</title><link>https://example.press/1</link></item></channel></rss>',
};

test('405 for non-GET requests', async () => {
  const res = await onRequest(ctx(new Request(get(), { method: 'POST' })));
  assert.equal(res.status, 405);
  assert.deepEqual(await res.json(), { error: 'Method Not Allowed' });
});

test('400 for missing or invalid coordinates', async () => {
  for (const query of ['', '?latitude=46', '?latitude=91&longitude=0']) {
    const res = await onRequest(ctx(get(query)));
    assert.equal(res.status, 400, query);
    assert.deepEqual(await res.json(), { error: 'Valid latitude and longitude are required' });
  }
});

test('MISS then HIT with real upstream shapes, headers intact', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = mockFetch(UPSTREAM);
  try {
    const miss = await onRequest(ctx(get('?latitude=46.7867&longitude=-92.1005')));
    assert.equal(miss.status, 200);
    assert.equal(miss.headers.get('x-regional-brief'), 'MISS');
    assert.equal(miss.headers.get('cache-control'), 'public, max-age=60');
    const body = await miss.json();
    assert.equal(body.status, 'ready');
    assert.equal(body.placeStatus, 'ready');
    assert.equal(body.newsSource, 'Google News RSS');
    assert.equal(body.articles.length, 1);

    // A second identical request is served from the per-isolate cache.
    const hit = await onRequest(ctx(get('?latitude=46.7867&longitude=-92.1005')));
    assert.equal(hit.headers.get('x-regional-brief'), 'HIT');
    assert.equal((await hit.json()).status, 'cached');
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('rate limiter engages after the per-window budget is spent', async () => {
  // Invalid-coordinate requests exit at 400 BEFORE any upstream work, but
  // still pass the limiter — so the budget (30/min) trips fast and offline.
  const statuses = [];
  for (let i = 0; i < 40 && !statuses.includes(429); i += 1) {
    const res = await onRequest(ctx(get('?latitude=46')));
    statuses.push(res.status);
  }
  assert.ok(statuses.includes(429), `expected a 429 within 40 requests, got ${statuses.join(',')}`);
});
