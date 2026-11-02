import test from 'node:test';
import assert from 'node:assert/strict';
import { createNominatimProvider } from './nominatim.js';
import { createDefaultPlaceSearch } from './defaults.js';
import { createPlaceSearch } from './placeSearch.js';
import { createGeospatialServices } from './geospatial.js';
import { readResponseTextCapped } from '../sources/httpBody.js';

const hit = {
  lat: '51.5',
  lon: '-0.12',
  name: 'London',
  display_name: 'London, England',
  category: 'place',
  type: 'city',
  addresstype: 'city',
  boundingbox: ['51', '52', '-1', '0'],
  address: {
    city: 'London',
    state: 'England',
    country: 'United Kingdom',
    road: 'Whitehall',
  },
};
const endpoints = {
  searchEndpoint: 'https://places.example/search',
  reverseEndpoint: 'https://places.example/reverse',
};

test('Nominatim normalizes framing and reverse context through independent configured endpoints', async () => {
  const calls = [];
  const adapter = createNominatimProvider({
    ...endpoints,
    fetchImpl: async (url, init) => {
      calls.push({ url: new URL(url), init });
      return Response.json(url.includes('/search?') ? [hit] : hit);
    },
  });
  const answer = await adapter.geocode('London', { bias: '50,-2|53,1' });
  assert.equal(answer.answered, true);
  assert.equal(answer.place.name, 'London');
  assert.deepEqual(answer.place.types, ['locality', 'political']);
  assert.deepEqual(answer.place.viewport, {
    southwest: { lat: 51, lng: -1 },
    northeast: { lat: 52, lng: 0 },
  });
  const reverse = await adapter.reverseGeocode(51.5, -0.12);
  assert.equal(reverse.locality, 'London');
  assert.deepEqual(reverse.streetLabels, ['Whitehall']);
  assert.equal(calls[0].url.searchParams.get('viewbox'), '-2,53,1,50');
  assert.equal(calls[0].url.searchParams.get('bounded'), '0');
  assert.equal(calls[0].url.searchParams.get('format'), 'jsonv2');
  assert.equal(calls[1].url.pathname, '/reverse');
  assert.equal(calls[1].init.redirect, 'error');
  assert.equal(calls[1].init.headers, undefined);
  assert.deepEqual(
    createGeospatialServices({ providers: adapter }).capabilities,
    { reverseGeocode: true, textSearch: false, nearby: false, route: false },
  );
});

test('explicit Nominatim choice retains offline coordinates and bypasses the default geocoder chain', async () => {
  const calls = [];
  const search = createDefaultPlaceSearch({
    geocoding: { provider: 'nominatim', ...endpoints },
    resolveApiKey: () => {
      throw new Error('must not request a Google key');
    },
    fetchImpl: async (url) => {
      calls.push(url);
      return Response.json(url.includes('/search?') ? [hit] : hit);
    },
  });
  assert.equal((await search.geocode('London')).place.name, 'London');
  await search.reverseGeocode(51.5, -0.12);
  assert.equal(calls.length, 2);
  assert(calls.every((url) => new URL(url).hostname === 'places.example'));
  assert.equal(search.attribution.reverseGeocode, 'OpenStreetMap / Nominatim');
  assert.equal(search.attribution.route, 'OpenStreetMap / OSRM');
  await search.geocode('51.5, -0.12');
  assert.equal(calls.length, 2);
  assert.throws(() =>
    createDefaultPlaceSearch({ geocoding: { provider: 'unknown' } }),
  );
  assert.throws(() =>
    createDefaultPlaceSearch({ geocoding: { provider: 'nominatim' } }),
  );
});

test('outages and malformed answers are retryable; only an explicit empty array is a cached miss', async () => {
  for (const makeResponse of [
    () => Response.json({}, { status: 429 }),
    () => Response.json({ error: 'bad' }),
    () => Response.json([{ ...hit, lat: '' }]),
    () => new Response('{'),
    () =>
      Response.json([hit], { headers: { 'content-length': String(600000) } }),
  ]) {
    let count = 0;
    const adapter = createNominatimProvider({
      ...endpoints,
      fetchImpl: async () => {
        count++;
        return makeResponse();
      },
    });
    const service = createPlaceSearch({ providers: [adapter] });
    assert.equal((await service.geocode('missing')).place, null);
    assert.equal((await service.geocode('missing')).place, null);
    assert.equal(count, 2);
  }
  let count = 0;
  const adapter = createNominatimProvider({
    ...endpoints,
    fetchImpl: async () => {
      count++;
      return Response.json([]);
    },
  });
  const service = createPlaceSearch({ providers: [adapter] });
  await service.geocode('missing');
  await service.geocode('missing');
  assert.equal(count, 1);
});

test('aborting a pending Nominatim body cancels its stream and rejects instead of caching a miss', async () => {
  const controller = new AbortController();
  let cancelled = false;
  const adapter = createNominatimProvider({
    ...endpoints,
    fetchImpl: async () =>
      new Response(
        new ReadableStream({
          start() {
            setTimeout(() => controller.abort(), 10);
          },
          cancel() {
            cancelled = true;
          },
        }),
      ),
  });
  await assert.rejects(
    adapter.geocode('London', { signal: controller.signal }),
    { name: 'AbortError' },
  );
  assert.equal(cancelled, true);
});

test('portable response cap counts UTF-8 bytes and cancels oversized streams', async () => {
  await assert.rejects(
    readResponseTextCapped(
      { headers: new Headers(), text: async () => 'éé' },
      3,
    ),
    { code: 'RESPONSE_TOO_LARGE' },
  );
  let cancelled = false;
  const response = new Response(
    new ReadableStream({
      start(c) {
        c.enqueue(new Uint8Array(4));
      },
      cancel() {
        cancelled = true;
      },
    }),
  );
  await assert.rejects(readResponseTextCapped(response, 3), {
    code: 'RESPONSE_TOO_LARGE',
  });
  assert.equal(cancelled, true);
});

test('unconfigured operations stay absent and invalid coordinates do not make requests', async () => {
  assert.equal(createNominatimProvider().geocode, undefined);
  let calls = 0;
  const adapter = createNominatimProvider({
    ...endpoints,
    fetchImpl: async () => {
      calls++;
      return Response.json(hit);
    },
  });
  assert.equal(await adapter.reverseGeocode(100, 0), null);
  assert.equal(calls, 0);
  for (const searchEndpoint of [
    'https://u:p@example.com/search',
    'https://example.com/search?key=x',
    '//example.com/search',
    'file:///search',
  ])
    assert.throws(() => createNominatimProvider({ searchEndpoint }));
});
