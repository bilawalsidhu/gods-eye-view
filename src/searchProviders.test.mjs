import test from 'node:test';
import assert from 'node:assert/strict';
import { normaliseNominatimResult } from './searchProviders.js';
import { _test } from './server/searchProvidersProxy.mjs';

test('Nominatim locality normalises to existing city semantics', () => {
  const result = normaliseNominatimResult({
    lat: '-32.2569',
    lon: '148.6011',
    display_name: 'Dubbo, Dubbo Regional Council, New South Wales, Australia',
    category: 'boundary',
    type: 'administrative',
    addresstype: 'city',
    boundingbox: ['-32.40', '-32.10', '148.45', '148.75'],
    namedetails: { name: 'Dubbo' },
  });
  assert.equal(result.lat, -32.2569);
  assert.equal(result.lon, 148.6011);
  assert.deepEqual(result.types, ['locality']);
  assert.equal(result.primaryName, 'Dubbo');
  assert.deepEqual(result.viewport, {
    southwest: { lat: -32.4, lng: 148.45 },
    northeast: { lat: -32.1, lng: 148.75 },
  });
});

test('Nominatim rejects non-finite coordinates', () => {
  assert.equal(normaliseNominatimResult({ lat: 'nope', lon: '148' }), null);
});

test('viewport bias parses for Nominatim viewbox translation', () => {
  assert.deepEqual(_test.parseBias('-33,148|-31,150'), {
    south: -33, west: 148, north: -31, east: 150,
  });
  assert.equal(_test.parseBias('garbage'), null);
});

test('Foursquare result normalises to Places-compatible shape', () => {
  const place = _test.normaliseFsqPlace({
    fsq_place_id: 'abc',
    name: 'Taronga Western Plains Zoo',
    latitude: -32.272,
    longitude: 148.581,
    locality: 'Dubbo',
    region: 'NSW',
    categories: [{ name: 'Zoo' }],
  });
  assert.equal(place.id, 'abc');
  assert.equal(place.name, 'Taronga Western Plains Zoo');
  assert.equal(place.latitude, -32.272);
  assert.equal(place.longitude, 148.581);
  assert.deepEqual(place.types, ['zoo']);
  assert.equal(place.provider, 'foursquare');
});

test('Foursquare proxy uses current Places API contract and server-side bearer key', async () => {
  let captured = null;
  const fetchImpl = async (url, options) => {
    captured = { url: new URL(url), options };
    return {
      ok: true,
      status: 200,
      json: async () => ({
        results: [{
          fsq_place_id: 'zoo-1',
          name: 'Taronga Western Plains Zoo',
          latitude: -32.272,
          longitude: 148.581,
          location: { locality: 'Dubbo', region: 'NSW' },
          categories: [{ name: 'Zoo' }],
        }],
      }),
    };
  };
  const request = new URL('http://localhost/?q=Taronga%20Western%20Plains%20Zoo&lat=-32.25&lon=148.60&radiusM=6000');
  const result = await _test.foursquareSearch(request, fetchImpl, {
    FOURSQUARE_SERVICE_KEY: 'secret-test-key',
  });
  assert.equal(result.status, 200);
  assert.equal(captured.url.origin, 'https://places-api.foursquare.com');
  assert.equal(captured.url.pathname, '/places/search');
  assert.equal(captured.url.searchParams.get('query'), 'Taronga Western Plains Zoo');
  assert.equal(captured.url.searchParams.get('ll'), '-32.25,148.6');
  assert.equal(captured.url.searchParams.get('radius'), '6000');
  assert.equal(captured.options.headers.Authorization, 'Bearer secret-test-key');
  assert.equal(captured.options.headers['X-Places-Api-Version'], '2025-06-17');
  assert.equal(result.body.places[0].provider, 'foursquare');
});

test('Foursquare proxy accepts only a Service API Key', async () => {
  const request = new URL('http://localhost/?q=Dubbo&lat=-32.25&lon=148.60&radiusM=6000');
  const result = await _test.foursquareSearch(request, async () => {
    throw new Error('legacy key should not reach Foursquare');
  }, {
    FOURSQUARE_API_KEY: 'legacy-key',
  });
  assert.equal(result.status, 503);
  assert.deepEqual(result.body.places, []);
});

test('Nominatim proxy identifies GEV and supports configurable base URL', async () => {
  let captured = null;
  const fetchImpl = async (url, options) => {
    captured = { url: new URL(url), options };
    return {
      ok: true,
      status: 200,
      json: async () => [{
        lat: '-32.2569',
        lon: '148.6011',
        display_name: 'Dubbo, New South Wales, Australia',
      }],
    };
  };
  const request = new URL('http://localhost/?q=Dubbo%20NSW%20Australia&bias=-33,148|-31,150');
  const result = await _test.nominatimSearch(request, fetchImpl, {
    NOMINATIM_BASE_URL: 'https://nominatim.example.test',
  });
  assert.equal(result.status, 200);
  assert.equal(captured.url.origin, 'https://nominatim.example.test');
  assert.equal(captured.url.pathname, '/search');
  assert.equal(captured.url.searchParams.get('q'), 'Dubbo NSW Australia');
  assert.equal(captured.url.searchParams.get('viewbox'), '148,-31,150,-33');
  assert.equal(captured.url.searchParams.get('format'), 'jsonv2');
  assert.match(captured.options.headers['User-Agent'], /^GodsEyeView-/);
  assert.equal(result.body.result.display_name, 'Dubbo, New South Wales, Australia');
});
