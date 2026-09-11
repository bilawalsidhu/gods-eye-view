// Contract tests for the /api/google/[[path]] Pages Function (dev parity with
// the googlePlacesContextProxy middlewares in vite.config.js). The previous
// state had NO Pages handler at all — the client's places fetches silently
// fell through to the SPA on static deployments. These pin the HTTP contract:
// the `places: []` error envelope, the Sec-Fetch-Site drive-by gate, the
// default-on limiter, param validation, and the upstream request shape.
//
// Run with: npm test   (node --test)
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import { onRequest, resetGoogleLimiterForTest } from './[[path]].js';

const env = { GOOGLE_MAPS_API_KEY: 'test-key' };
const url = (path = '/nearby-places', query = '') => `https://example.com/api/google${path}${query ? `?${query}` : ''}`;
const ctx = (request, environment = env) => ({ request, env: environment });

/** Same-origin browser GET: Sec-Fetch-Site attached, no Origin on GET fetches. */
const siteFetch = (path, query, headers = {}) => new Request(url(path, query), {
  headers: { 'Sec-Fetch-Site': 'same-origin', ...headers },
});

/** Replace global fetch; `impl` receives {url, init}. */
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

const placeRow = (index, overrides = {}) => ({
  id: `place-${index}`,
  displayName: { text: `Alamo ${index}` },
  formattedAddress: '300 Alamo Plaza, San Antonio, TX 78205',
  shortFormattedAddress: '300 Alamo Plaza',
  location: { latitude: 29.4259, longitude: -98.4861 },
  primaryType: 'historical_landmark',
  primaryTypeDisplayName: { text: 'Historical landmark' },
  types: ['historical_landmark', 'tourist_attraction', 'point_of_interest'],
  ...overrides,
});

beforeEach(() => resetGoogleLimiterForTest());

test('non-GET answers the dev 405 shape with the places envelope', async () => {
  const stub = stubFetch(() => { throw new Error('must not fetch'); });
  try {
    for (const method of ['POST', 'OPTIONS']) {
      const res = await onRequest(ctx(new Request(url(), { method })));
      assert.equal(res.status, 405, method);
      assert.deepEqual(await res.json(), { error: 'Method not allowed', places: [] });
    }
    assert.equal(stub.calls.length, 0);
  } finally {
    stub.restore();
  }
});

test('a cross-site Sec-Fetch-Site is rejected before any quota is spent', async () => {
  const stub = stubFetch(() => { throw new Error('must not fetch'); });
  try {
    const res = await onRequest(ctx(siteFetch('/nearby-places', 'lat=29.4&lon=-98.5', {
      'Sec-Fetch-Site': 'cross-site',
    })));
    assert.equal(res.status, 403);
    assert.deepEqual(await res.json(), { error: 'cross-origin requests are rejected', places: [] });

    const sameSite = await onRequest(ctx(siteFetch('/nearby-places', 'lat=29.4&lon=-98.5', {
      'Sec-Fetch-Site': 'same-site',
    })));
    assert.equal(sameSite.status, 403, 'same-site (sibling subdomain) is still not this origin');
    assert.equal(stub.calls.length, 0, 'a rejected drive-by must not reach Google');
  } finally {
    stub.restore();
  }
});

test('rate limiting is default-ON: the 61st request in a minute gets 429', async () => {
  const stub = stubFetch(() => Response.json({ places: [placeRow(0)] }));
  try {
    let last;
    for (let i = 0; i < 60; i += 1) {
      last = await onRequest(ctx(siteFetch('/nearby-places', `lat=29.4${i}&lon=-98.5`)));
      assert.equal(last.status, 200, `request ${i} should pass the default limiter`);
    }
    const limited = await onRequest(ctx(siteFetch('/nearby-places', 'lat=29.4&lon=-98.5')));
    assert.equal(limited.status, 429);
    assert.equal(limited.headers.get('retry-after'), '5');
    assert.deepEqual(await limited.json(), { error: 'Rate limit exceeded', places: [] });
  } finally {
    stub.restore();
  }
});

test('GEV_RATELIMIT_GOOGLE_PER_MIN=0 is the documented escape hatch', async () => {
  const stub = stubFetch(() => Response.json({ places: [placeRow(0)] }));
  try {
    for (let i = 0; i < 62; i += 1) {
      const res = await onRequest(ctx(siteFetch('/nearby-places', `lat=29.4${i}&lon=-98.5`), {
        GOOGLE_MAPS_API_KEY: 'test-key',
        GEV_RATELIMIT_GOOGLE_PER_MIN: '0',
      }));
      assert.equal(res.status, 200, `request ${i} should pass with the limiter disabled`);
    }
  } finally {
    stub.restore();
  }
});

test('a missing key answers the dev 503 shape without touching upstream', async () => {
  const stub = stubFetch(() => { throw new Error('must not fetch'); });
  try {
    const res = await onRequest(ctx(siteFetch('/nearby-places', 'lat=29.4&lon=-98.5'), {}));
    assert.equal(res.status, 503);
    assert.deepEqual(await res.json(), { error: 'GOOGLE_MAPS_API_KEY is not set', places: [] });
    assert.equal(stub.calls.length, 0);
  } finally {
    stub.restore();
  }
});

test('invalid params answer the dev 400 messages', async () => {
  const stub = stubFetch(() => { throw new Error('must not fetch'); });
  try {
    const noCoords = await onRequest(ctx(siteFetch('/nearby-places', '')));
    assert.equal(noCoords.status, 400);
    assert.deepEqual(await noCoords.json(), { error: 'Valid lat and lon are required', places: [] });

    const badText = await onRequest(ctx(siteFetch('/text-search', 'lat=999&lon=-98.5')));
    assert.equal(badText.status, 400);
    assert.deepEqual(
      await badText.json(),
      { error: 'q, lat and lon are required (lat in [-90,90], lon in [-180,180])', places: [] },
    );
    assert.equal(stub.calls.length, 0);
  } finally {
    stub.restore();
  }
});

test('nearby-places sends the shared field mask and DISTANCE-ranked circle body', async () => {
  const stub = stubFetch(() => Response.json({ places: [placeRow(0), placeRow(0), {}] }));
  try {
    const res = await onRequest(ctx(siteFetch('/nearby-places', 'lat=29.426&lon=-98.486&radiusM=99')));
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('cache-control'), 'private, max-age=300');
    const body = await res.json();
    assert.equal(body.error, null);
    assert.equal(body.places.length, 1, 'dedupe + the nameless row must be dropped');
    assert.equal(body.places[0].name, 'Alamo 0');
    assert.ok(Number.isFinite(body.places[0].distanceM));
    assert.equal('contextPriority' in body.places[0], false, 'internal ranking field never reaches the wire');

    assert.equal(stub.calls.length, 1);
    assert.equal(stub.calls[0].url, 'https://places.googleapis.com/v1/places:searchNearby');
    assert.equal(stub.calls[0].init.headers['X-Goog-Api-Key'], 'test-key');
    assert.ok(stub.calls[0].init.headers['X-Goog-FieldMask'].startsWith('places.id,'));
    const sent = JSON.parse(stub.calls[0].init.body);
    assert.deepEqual(sent.locationRestriction.circle.center, { latitude: 29.426, longitude: -98.486 });
    assert.equal(sent.locationRestriction.circle.radius, 99);
    assert.equal(sent.rankPreference, 'DISTANCE');
    assert.equal(sent.maxResultCount, 20);
  } finally {
    stub.restore();
  }
});

test('text-search keeps the viewport box and validates before fetching', async () => {
  const stub = stubFetch(() => Response.json({
    places: [placeRow(0, { viewport: { low: { latitude: 29.42, longitude: -98.49 }, high: { latitude: 29.43, longitude: -98.48 } } })],
  }));
  try {
    const res = await onRequest(ctx(siteFetch('/text-search', 'q=the%20alamo&lat=29.426&lon=-98.486')));
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.places[0].viewport.low.latitude, 29.42);
    assert.equal(stub.calls[0].url, 'https://places.googleapis.com/v1/places:searchText');
    const sent = JSON.parse(stub.calls[0].init.body);
    assert.equal(sent.textQuery, 'the alamo');
    assert.equal(sent.maxResultCount, 5);
  } finally {
    stub.restore();
  }
});

test('an upstream error status travels verbatim with the upstream message', async () => {
  const stub = stubFetch(() => Response.json(
    { error: { message: 'Field mask is invalid' } },
    { status: 400 },
  ));
  try {
    const res = await onRequest(ctx(siteFetch('/nearby-places', 'lat=29.4&lon=-98.5')));
    assert.equal(res.status, 400);
    const body = await res.json();
    assert.equal(body.error, 'Field mask is invalid');
    assert.deepEqual(body.places, []);
  } finally {
    stub.restore();
  }
});

test('a transport failure answers the dev 502 shape', async () => {
  const stub = stubFetch(() => { throw new Error('connect ECONNREFUSED'); });
  try {
    const res = await onRequest(ctx(siteFetch('/nearby-places', 'lat=29.4&lon=-98.5')));
    assert.equal(res.status, 502);
    const body = await res.json();
    assert.equal(body.error, 'connect ECONNREFUSED');
    assert.deepEqual(body.places, []);
  } finally {
    stub.restore();
  }
});

test('unknown google subpaths answer 404, never an upstream call', async () => {
  const stub = stubFetch(() => { throw new Error('must not fetch'); });
  try {
    const res = await onRequest(ctx(siteFetch('/directions', 'lat=29.4&lon=-98.5')));
    assert.equal(res.status, 404);
    assert.equal(stub.calls.length, 0);
  } finally {
    stub.restore();
  }
});

test('the scaffolded .env placeholder key is treated as absent, not forwarded', async () => {
  // Regression (L9 D8): a placeholder-configured server forwarded the
  // sentinel to Google, which 400'd "API key not valid" on every call —
  // degrading differently from an honest keyless deployment and blinding
  // keyless-detection in the QA probes.
  const stub = stubFetch(() => { throw new Error('must not fetch'); });
  try {
    for (const placeholder of ['your_google_maps_api_key_here', '  your_google_maps_api_key_here  ', '   ', '']) {
      const res = await onRequest(ctx(siteFetch('/nearby-places', 'lat=29.4&lon=-98.5'), { GOOGLE_MAPS_API_KEY: placeholder }));
      assert.equal(res.status, 503, JSON.stringify(placeholder));
      assert.deepEqual(await res.json(), { error: 'GOOGLE_MAPS_API_KEY is not set', places: [] });
    }
    assert.equal(stub.calls.length, 0, 'no placeholder value may reach upstream');
  } finally {
    stub.restore();
  }
});
