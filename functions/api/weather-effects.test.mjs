// Pages Function tests for /api/weather-effects — mirrors the dev middleware
// contract (vite/proxies/regional.js): identical validation errors, the 0.1°
// cache quantization, HIT/INFLIGHT/MISS/STALE header semantics, and the 503
// shape. Offline via a stubbed globalThis.fetch.
//
// Run with: npm test   (node --test)
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  expireWeatherEffectsPointForTest,
  onRequest,
  resetWeatherEffectsStateForTest,
} from './weather-effects.js';

const BASE = 'https://example.com/api/weather-effects';
const url = (query = '') => `${BASE}${query}`;
const ctx = (request) => ({ request });

const OPEN_METEO_BODY = JSON.stringify({
  current: {
    time: '2026-09-12T00:15',
    temperature_2m: 21.4,
    apparent_temperature: 20.9,
    precipitation: 0,
    weather_code: 2,
    cloud_cover: 55,
    wind_speed_10m: 12.3,
    wind_direction_10m: 170,
    visibility: 24140,
  },
});

/** Stub Open-Meteo; records every upstream URL. */
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

test('validation failures match the dev middleware byte for byte and never fetch', async () => {
  resetWeatherEffectsStateForTest();
  const upstream = stubUpstream(() => { throw new Error('must not fetch'); });
  try {
    for (const query of ['', '?longitude=12.5', '?latitude=12.5', '?latitude=&longitude=12.5', '?latitude=999&longitude=0']) {
      const res = await onRequest(ctx(new Request(url(query))));
      await expectJson(res, 400, { error: 'Valid latitude and longitude are required' });
    }
    const post = await onRequest(ctx(new Request(url('?latitude=1&longitude=2'), { method: 'POST' })));
    await expectJson(post, 405, { error: 'Method Not Allowed' });
    assert.equal(upstream.calls.length, 0);
  } finally {
    upstream.restore();
  }
});

test('a MISS fetches the exact shared Open-Meteo URL and returns the ready payload', async () => {
  resetWeatherEffectsStateForTest();
  const upstream = stubUpstream(() => new Response(OPEN_METEO_BODY, {
    status: 200,
    headers: { 'content-type': 'application/json' },
  }));
  try {
    const res = await onRequest(ctx(new Request(url('?latitude=30.2711&longitude=-97.7437'))));
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('x-weather-effects'), 'MISS');
    assert.equal(res.headers.get('cache-control'), 'public, max-age=60');
    const body = await res.json();
    assert.equal(body.status, 'ready');
    assert.deepEqual(body.coordinates, { latitude: 30.2711, longitude: -97.7437 });
    assert.equal(body.weather.temperatureC, 21.4);
    assert.equal(body.weather.observedAt, '2026-09-12T00:15:00.000Z', 'zone-naive upstream time pinned to UTC');
    assert.match(upstream.calls[0].fetchUrl, /^https:\/\/api\.open-meteo\.com\/v1\/forecast\?latitude=30\.27110&longitude=-97\.74370&current=/);
    assert.match(upstream.calls[0].fetchUrl, /timezone=UTC$/);
  } finally {
    upstream.restore();
  }
});

test('repeats within the 0.1° quantization and the 5 min TTL are HITs', async () => {
  resetWeatherEffectsStateForTest();
  const upstream = stubUpstream(() => new Response(OPEN_METEO_BODY, {
    status: 200,
    headers: { 'content-type': 'application/json' },
  }));
  try {
    // 30.2711/-97.7437 quantizes to the 0.1° cell (30.3, -97.7).
    const first = await onRequest(ctx(new Request(url('?latitude=30.2711&longitude=-97.7437'))));
    assert.equal(first.headers.get('x-weather-effects'), 'MISS');
    // Camera drift inside the same 0.1° cell reuses the observation…
    const drifted = await onRequest(ctx(new Request(url('?latitude=30.2749&longitude=-97.7401'))));
    assert.equal(drifted.headers.get('x-weather-effects'), 'HIT');
    assert.equal((await drifted.json()).status, 'cached');
    // …and a point in the NEIGHBOURING cell does not.
    const neighbour = await onRequest(ctx(new Request(url('?latitude=30.44&longitude=-97.81'))));
    assert.equal(neighbour.headers.get('x-weather-effects'), 'MISS');
    assert.equal(upstream.calls.length, 2);
  } finally {
    upstream.restore();
  }
});

test('upstream failure with no cache gets the dev 503 shape', async () => {
  resetWeatherEffectsStateForTest();
  const upstream = stubUpstream(() => new Response('{"error":true}', {
    status: 500,
    headers: { 'content-type': 'application/json' },
  }));
  try {
    const res = await onRequest(ctx(new Request(url('?latitude=30.27&longitude=-97.74'))));
    await expectJson(res, 503, { error: 'Weather effects are temporarily unavailable' });
    assert.equal(res.headers.get('cache-control'), 'no-store');
  } finally {
    upstream.restore();
  }
});

test('a malformed observation body is a 503, never a fabricated payload', async () => {
  resetWeatherEffectsStateForTest();
  const upstream = stubUpstream(() => new Response('{"current":{}}', {
    status: 200,
    headers: { 'content-type': 'application/json' },
  }));
  try {
    const res = await onRequest(ctx(new Request(url('?latitude=30.27&longitude=-97.74'))));
    await expectJson(res, 503, { error: 'Weather effects are temporarily unavailable' });
  } finally {
    upstream.restore();
  }
});

test('stale cache answers when refresh fails after a previously good fetch', async () => {
  resetWeatherEffectsStateForTest();
  const good = stubUpstream(() => new Response(OPEN_METEO_BODY, {
    status: 200,
    headers: { 'content-type': 'application/json' },
  }));
  const first = await onRequest(ctx(new Request(url('?latitude=30.27&longitude=-97.74'))));
  assert.equal(first.headers.get('x-weather-effects'), 'MISS');
  // Age the observation past the fresh TTL so the next request must refresh.
  expireWeatherEffectsPointForTest('30.3,-97.7');
  good.restore();

  const bad = stubUpstream(() => new Response('upstream down', { status: 502 }));
  try {
    const res = await onRequest(ctx(new Request(url('?latitude=30.27&longitude=-97.74'))));
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('x-weather-effects'), 'STALE');
    assert.equal((await res.json()).status, 'stale');
  } finally {
    bad.restore();
  }
});
