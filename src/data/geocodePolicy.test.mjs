// geocodePolicy.test.mjs — the keyless geocoder core (PLAN.md issues #211/#213).
// Pure-function coverage: validation contract, upstream URL shape (Nominatim
// usage policy), result normalization, and the full request contract with an
// injected fetch/clock — no network, no server, no real time.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  GEOCODE_CACHE_MAX_ENTRIES,
  GEOCODE_CACHE_TTL_MS,
  NOMINATIM_SEARCH_ENDPOINT,
  NOMINATIM_USER_AGENT,
  buildNominatimSearchUrl,
  nominatimBoundingBoxToViewport,
  normalizeNominatimResults,
  parseGeocodeQuery,
  parseGeocodeViewbox,
  resolveGeocodeRequest,
} from './geocodePolicy.js';

function queryParams(search) {
  return new URL(`https://unit.test/api/geocode${search}`).searchParams;
}

/** Minimal deps with empty per-test state; override per case. */
function deps(overrides = {}) {
  return {
    searchParams: queryParams('?q=test'),
    cache: new Map(),
    inFlight: new Map(),
    fetchImpl: async () => new Response('[]', { status: 200, headers: { 'Content-Type': 'application/json' } }),
    now: () => 1_000_000,
    ...overrides,
  };
}

/** A representative Nominatim jsonv2 row (Austin, a place node → no bbox). */
const AUSTIN_ROW = {
  place_id: 123,
  category: 'place',
  type: 'city',
  addresstype: 'city',
  display_name: 'Austin, Travis County, Texas, USA',
  lat: '30.267153',
  lon: '-97.743057',
  importance: 0.6,
  boundingbox: ['30.1', '30.6', '-98.0', '-97.5'],
};

test('parseGeocodeQuery: q/limit contract, defaults, and rejection cases', () => {
  assert.deepEqual(parseGeocodeQuery(queryParams('?q=%20the%20Alps%20&limit=8')), {
    query: 'the Alps',
    limit: 8,
    viewbox: null,
  });
  // Default limit when absent.
  assert.equal(parseGeocodeQuery(queryParams('?q=x')).limit, 5);
  // Missing / oversized q.
  assert.equal(parseGeocodeQuery(queryParams('?limit=3')), null);
  assert.equal(parseGeocodeQuery(queryParams('?q=')), null);
  assert.equal(parseGeocodeQuery(queryParams(`?q=${'x'.repeat(201)}`)), null);
  // Limit must be an integer within [1, 10].
  for (const bad of ['0', '11', 'abc', '2.5', '-1']) {
    assert.equal(parseGeocodeQuery(queryParams(`?q=x&limit=${bad}`)), null, `limit=${bad}`);
  }
  assert.equal(parseGeocodeQuery(queryParams('?q=x&limit=10')).limit, 10);
});

test('parseGeocodeViewbox: client lat-first corners normalize; junk drops to null', () => {
  assert.deepEqual(parseGeocodeViewbox('30.1,-97.95|30.5,-97.55'), {
    south: 30.1, west: -97.95, north: 30.5, east: -97.55,
  });
  // Reversed corners normalize to the same box.
  assert.deepEqual(parseGeocodeViewbox('30.5,-97.55|30.1,-97.95'), {
    south: 30.1, west: -97.95, north: 30.5, east: -97.55,
  });
  // Bias-only param: anything wrong degrades to "no bias", never a rejection.
  for (const bad of [null, '', '30.1', 'a,b|c,d', '91,0|92,1', '0,181|1,182', '1;2|3;4']) {
    assert.equal(parseGeocodeViewbox(bad), null, String(bad));
  }
});

test('buildNominatimSearchUrl: jsonv2 shape, lat→lon-first viewbox, bias-only', () => {
  const url = buildNominatimSearchUrl({
    query: 'the Alps',
    limit: 8,
    viewbox: parseGeocodeViewbox('46.0,5.0|47.5,11.0'),
  });
  assert.equal(url.origin + url.pathname, NOMINATIM_SEARCH_ENDPOINT);
  assert.equal(url.searchParams.get('format'), 'jsonv2');
  assert.equal(url.searchParams.get('addressdetails'), '0');
  assert.equal(url.searchParams.get('limit'), '8');
  assert.equal(url.searchParams.get('q'), 'the Alps');
  // Client corners (sw/ne lat-first) → Nominatim west,south,east,north.
  assert.equal(url.searchParams.get('viewbox'), '5,46,11,47.5');
  assert.equal(url.searchParams.get('bounded'), '0', 'a bias, not a hard filter — like the keyed bounds');

  // No viewbox → no viewbox/bounded params at all.
  const bare = buildNominatimSearchUrl({ query: 'x' });
  assert.equal(bare.searchParams.get('viewbox'), null);
  assert.equal(bare.searchParams.get('bounded'), null);
  assert.equal(bare.searchParams.get('limit'), '5');

  // Self-hosted override and the Nominatim-side limit cap.
  const own = buildNominatimSearchUrl({ query: 'x', limit: 99 }, 'https://nominatim.internal/search');
  assert.equal(own.origin + own.pathname, 'https://nominatim.internal/search');
  assert.equal(own.searchParams.get('limit'), '10');
});

test('normalizeNominatimResults: geocode-shaped rows; unusable rows dropped', () => {
  const rows = normalizeNominatimResults([
    AUSTIN_ROW,
    { display_name: 'No Coords', lat: 'NaN', lon: '0' },
    { display_name: '  ', lat: '1', lon: '2' },
    { lat: '1', lon: '2' },
    'junk',
  ]);
  assert.equal(rows.length, 1);
  assert.deepEqual(rows[0], {
    label: 'Austin, Travis County, Texas, USA',
    lat: 30.267153,
    lon: -97.743057,
    kind: 'place:city',
    viewport: {
      southwest: { lat: 30.1, lng: -98.0 },
      northeast: { lat: 30.6, lng: -97.5 },
    },
  });
  // Non-array payloads (HTML error pages, nulls) normalize to nothing.
  assert.deepEqual(normalizeNominatimResults(null), []);
  assert.deepEqual(normalizeNominatimResults({ error: 'x' }), []);
});

test('nominatimBoundingBoxToViewport: [south,north,west,east] strings → geocode bounds', () => {
  assert.deepEqual(nominatimBoundingBoxToViewport(['-10', '20', '-30', '40']), {
    southwest: { lat: -10, lng: -30 },
    northeast: { lat: 20, lng: 40 },
  });
  // Point results (nodes) legitimately have no boundingbox.
  assert.equal(nominatimBoundingBoxToViewport(undefined), null);
  assert.equal(nominatimBoundingBoxToViewport(['1', '2', '3']), null);
  assert.equal(nominatimBoundingBoxToViewport(['a', 'b', 'c', 'd']), null);
});

test('resolveGeocodeRequest: MISS normalizes and sends the identifying UA', async () => {
  let upstreamUrl = null;
  let upstreamHeaders = null;
  const outcome = await resolveGeocodeRequest(deps({
    fetchImpl: async (url, init) => {
      upstreamUrl = url;
      upstreamHeaders = init.headers;
      return new Response(JSON.stringify([AUSTIN_ROW]), { status: 200 });
    },
  }));
  assert.equal(outcome.status, 200);
  assert.equal(outcome.cacheState, 'MISS');
  assert.equal(outcome.cacheControl, 'public, max-age=60');
  assert.equal(upstreamHeaders['User-Agent'], NOMINATIM_USER_AGENT, 'Nominatim usage policy');
  assert.equal(upstreamUrl.searchParams.get('q'), 'test');
  assert.deepEqual(outcome.payload.results, normalizeNominatimResults([AUSTIN_ROW]));
  assert.equal(outcome.payload.attribution, '© OpenStreetMap contributors');
});

test('resolveGeocodeRequest: identical request inside the TTL is a HIT with zero upstream calls', async () => {
  let calls = 0;
  const shared = deps({
    fetchImpl: async () => {
      calls += 1;
      return new Response(JSON.stringify([AUSTIN_ROW]), { status: 200 });
    },
  });
  const first = await resolveGeocodeRequest(shared);
  const second = await resolveGeocodeRequest(shared);
  assert.equal(first.cacheState, 'MISS');
  assert.equal(second.cacheState, 'HIT');
  assert.equal(calls, 1);
  // TTL expiry sends it back upstream (distinct viewbox = distinct key, too).
  const later = await resolveGeocodeRequest({ ...shared, now: () => 1_000_000 + GEOCODE_CACHE_TTL_MS + 1 });
  assert.equal(later.cacheState, 'MISS');
  assert.equal(calls, 2);
});

test('resolveGeocodeRequest: concurrent requests single-flight into one upstream call', async () => {
  let calls = 0;
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const shared = deps({
    fetchImpl: async () => {
      calls += 1;
      await gate;
      return new Response(JSON.stringify([AUSTIN_ROW]), { status: 200 });
    },
  });
  const first = resolveGeocodeRequest(shared);
  const second = resolveGeocodeRequest(shared);
  release();
  const [a, b] = await Promise.all([first, second]);
  assert.equal(calls, 1, 'the second request must join the first refresh');
  assert.equal(a.cacheState, 'MISS');
  assert.equal(b.cacheState, 'INFLIGHT');
});

test('resolveGeocodeRequest: 405 and 400 with no-store, no upstream touch', async () => {
  let calls = 0;
  const shared = deps({ fetchImpl: async () => { calls += 1; return new Response('[]'); } });
  const post = await resolveGeocodeRequest({ ...shared, method: 'POST' });
  assert.equal(post.status, 405);
  assert.deepEqual(post.payload, { error: 'Method Not Allowed' });
  assert.equal(post.cacheControl, 'no-store');
  const bad = await resolveGeocodeRequest(deps({ searchParams: queryParams('?limit=3') }));
  assert.equal(bad.status, 400);
  assert.deepEqual(bad.payload, { error: 'Missing or invalid q parameter' });
  const badLimit = await resolveGeocodeRequest(deps({ searchParams: queryParams('?q=x&limit=nope') }));
  assert.equal(badLimit.status, 400);
  assert.equal(calls, 0);
});

test('resolveGeocodeRequest: upstream failure is a 502; a stale cache entry answers instead', async () => {
  // Cold failure → 502.
  const cold = await resolveGeocodeRequest(deps({
    fetchImpl: async () => new Response('nope', { status: 500 }),
  }));
  assert.equal(cold.status, 502);
  assert.deepEqual(cold.payload, { error: 'Geocoder unavailable' });
  assert.equal(cold.cacheControl, 'no-store');

  // Warm cache that has gone stale + failing refresh → stale body, flagged.
  const cache = new Map([[
    JSON.stringify(['the Alps', 5, null]),
    { at: 1, payload: { results: [{ label: 'stale', lat: 1, lon: 2, kind: 'x', viewport: null }], attribution: '© OpenStreetMap contributors' } },
  ]]);
  const stale = await resolveGeocodeRequest(deps({
    searchParams: queryParams('?q=the%20Alps'),
    cache,
    now: () => 1 + GEOCODE_CACHE_TTL_MS + 1,
    fetchImpl: async () => { throw new Error('network down'); },
  }));
  assert.equal(stale.status, 200);
  assert.equal(stale.cacheState, 'STALE-ERROR');
  assert.deepEqual(stale.payload.results, [{ label: 'stale', lat: 1, lon: 2, kind: 'x', viewport: null }]);
});

test('resolveGeocodeRequest: a Nominatim 200 with zero rows is a legit no-match, not a failure', async () => {
  const outcome = await resolveGeocodeRequest(deps({
    searchParams: queryParams('?q=zzz%20no%20such%20place'),
    fetchImpl: async () => new Response('[]', { status: 200 }),
  }));
  assert.equal(outcome.status, 200);
  assert.deepEqual(outcome.payload.results, []);
  assert.equal(outcome.payload.attribution, '© OpenStreetMap contributors');
});

test('resolveGeocodeRequest: a joined refresh that fails is a 502, with one upstream call', async () => {
  let calls = 0;
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const shared = deps({
    fetchImpl: async () => {
      calls += 1;
      await gate;
      throw new Error('upstream died');
    },
  });
  const leader = resolveGeocodeRequest(shared);
  const joined = resolveGeocodeRequest(shared);
  release();
  const [a, b] = await Promise.all([leader, joined]);
  assert.equal(calls, 1, 'the second request joined the first refresh');
  assert.equal(a.status, 502, 'the leader reports the upstream failure');
  assert.equal(b.status, 502, 'the request that joined it fails the same way');
  assert.deepEqual(b.payload, { error: 'Geocoder unavailable' });
  assert.equal(b.cacheState, 'NONE');
  assert.equal(b.cacheControl, 'no-store');
});

test('resolveGeocodeRequest: caching evicts the oldest query once the ceiling is passed', async () => {
  const cache = new Map();
  for (let i = 0; i < GEOCODE_CACHE_MAX_ENTRIES; i++) cache.set(`old-${i}`, { at: 0, payload: {} });

  const outcome = await resolveGeocodeRequest(deps({ cache }));
  assert.equal(outcome.cacheState, 'MISS');

  assert.equal(cache.size, GEOCODE_CACHE_MAX_ENTRIES, 'the cache never grows past its ceiling');
  assert.equal(cache.has('old-0'), false, 'the oldest entry is evicted first');
  assert.equal(cache.has(`old-${GEOCODE_CACHE_MAX_ENTRIES - 1}`), true, 'newer entries survive');
  assert.equal(cache.get(JSON.stringify(['test', 5, null]))?.payload, outcome.payload,
    'the fresh answer is stored under its request key');
});
