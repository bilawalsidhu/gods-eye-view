import assert from 'node:assert/strict';
import test from 'node:test';
import { AzureMapsRestAdapter } from '../dist/adapters/azure-maps.js';
import { loadConfig } from '../dist/config.js';

const config = loadConfig({
  NODE_ENV: 'test',
  AZURE_MAPS_CLIENT_ID: 'maps-client-id',
});

const feature = {
  type: 'Feature',
  properties: {
    address: {
      countryRegion: { name: 'Finland', iso: 'FI' },
      formattedAddress: 'Helsinki, Finland',
      locality: 'Helsinki',
    },
    type: 'Municipality',
    confidence: 'High',
  },
  geometry: {
    type: 'Point',
    coordinates: [24.9384, 60.1699],
  },
};

function credential(scopes) {
  return {
    getToken: async (scope) => {
      scopes.push(scope);
      return { token: 'managed-identity-token', expiresOnTimestamp: Date.now() + 60_000 };
    },
  };
}

test('uses Search 2026-01-01 geocoding and normalizes GeoJSON features', async () => {
  const originalFetch = globalThis.fetch;
  const scopes = [];
  let requested;
  globalThis.fetch = async (url, init) => {
    requested = { url: new URL(url), init };
    return Response.json({ type: 'FeatureCollection', features: [feature] });
  };
  try {
    const adapter = new AzureMapsRestAdapter(config, credential(scopes));
    const response = await adapter.searchAddress(
      'Helsinki',
      { limit: 5, latitude: 60, longitude: 25 },
      { correlationId: 'cid' },
    );
    assert.equal(requested.url.pathname, '/geocode');
    assert.equal(requested.url.searchParams.get('api-version'), '2026-01-01');
    assert.equal(requested.url.searchParams.get('top'), '5');
    assert.equal(requested.url.searchParams.get('coordinates'), '25,60');
    assert.equal(requested.init.headers['x-ms-client-id'], 'maps-client-id');
    assert.deepEqual(scopes, ['https://atlas.microsoft.com/.default']);
    assert.deepEqual(response.results[0], {
      id: '24.9384,60.1699:0',
      type: 'Municipality',
      name: 'Helsinki, Finland',
      position: { latitude: 60.1699, longitude: 24.9384 },
      address: {
        freeformAddress: 'Helsinki, Finland',
        municipality: 'Helsinki',
        countryCode: 'FI',
        entityType: 'Municipality',
      },
      score: 'High',
    });
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('uses Search 2026-01-01 reverse geocoding coordinate order', async () => {
  const originalFetch = globalThis.fetch;
  let requestedUrl;
  globalThis.fetch = async (url) => {
    requestedUrl = new URL(url);
    return Response.json({ type: 'FeatureCollection', features: [feature] });
  };
  try {
    const adapter = new AzureMapsRestAdapter(config, credential([]));
    const response = await adapter.reverseGeocode(
      { latitude: 60.1699, longitude: 24.9384 },
      undefined,
      { correlationId: 'cid' },
    );
    assert.equal(requestedUrl.pathname, '/reverseGeocode');
    assert.equal(requestedUrl.searchParams.get('api-version'), '2026-01-01');
    assert.equal(requestedUrl.searchParams.get('coordinates'), '24.9384,60.1699');
    assert.equal(response.addresses[0].formattedAddress, 'Helsinki, Finland');
  } finally {
    globalThis.fetch = originalFetch;
  }
});
