import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  AZURE_MAPS_BFF_CONTRACTS,
  AzureMapsBffClient,
} from './mapsClient.js';

function jsonResponse(body, init = {}) {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
    ...init,
  });
}

test('Azure Maps search uses the same-origin BFF and encodes optional location', async () => {
  const calls = [];
  const client = new AzureMapsBffClient({
    fetchImpl: async (url, init) => {
      calls.push({ url, init });
      return jsonResponse({ results: [{ id: 'place-1' }] });
    },
  });

  const result = await client.search('Helsinki & Espoo', {
    limit: 4,
    language: 'fi-FI',
    countrySet: ['FI', 'SE'],
    latitude: 60.17,
    longitude: 24.94,
  });

  assert.equal(result.results[0].id, 'place-1');
  const url = new URL(calls[0].url, 'https://satview.test');
  assert.equal(url.pathname, AZURE_MAPS_BFF_CONTRACTS.search.path);
  assert.equal(url.searchParams.get('query'), 'Helsinki & Espoo');
  assert.equal(url.searchParams.get('countrySet'), 'FI,SE');
  assert.equal(url.searchParams.get('lat'), '60.17');
  assert.equal(calls[0].init.credentials, 'same-origin');
  assert.equal(calls[0].init.headers.get('Accept'), 'application/json');
});

test('route posts a normalized JSON contract without Azure credentials', async () => {
  let request;
  const client = new AzureMapsBffClient({
    fetchImpl: async (url, init) => {
      request = { url, init };
      return jsonResponse({ routes: [{ summary: { lengthInMeters: 1200 } }] });
    },
  });

  const result = await client.route([
    { latitude: 60.17, longitude: 24.94 },
    { latitude: 60.2, longitude: 25.01 },
  ], { travelMode: 'car', traffic: true });

  assert.equal(request.url, '/api/azure/maps/route');
  assert.equal(request.init.method, 'POST');
  assert.equal(request.init.headers.get('Content-Type'), 'application/json');
  assert.deepEqual(JSON.parse(request.init.body), {
    coordinates: [
      { latitude: 60.17, longitude: 24.94 },
      { latitude: 60.2, longitude: 25.01 },
    ],
    travelMode: 'car',
    traffic: true,
  });
  assert.equal(request.init.headers.has('Authorization'), false);
  assert.equal(result.routes[0].summary.lengthInMeters, 1200);
});

test('maps client exposes traffic status without exporting a managed-identity token', async () => {
  const paths = [];
  const client = new AzureMapsBffClient({
    fetchImpl: async (url) => {
      paths.push(url);
      return jsonResponse({ configured: true, available: true });
    },
  });

  assert.equal((await client.trafficStatus()).available, true);
  assert.deepEqual(paths, ['/api/azure/maps/traffic/status']);
  assert.equal('getTrafficToken' in client, false);
});

test('client rejects invalid coordinates before making a request', async () => {
  let called = false;
  const client = new AzureMapsBffClient({
    fetchImpl: async () => {
      called = true;
      return jsonResponse({});
    },
  });
  await assert.rejects(
    client.reverseGeocode({ latitude: 100, longitude: 0 }),
    /latitude must be between/,
  );
  await assert.rejects(client.route([{ latitude: 0, longitude: 0 }]), /at least two/);
  assert.equal(called, false);
});
