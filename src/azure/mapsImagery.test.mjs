import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  AZURE_MAPS_DEFAULT_ATTRIBUTION,
  AZURE_MAPS_IMAGERY_BFF_CONTRACTS,
  AZURE_MAPS_IMAGERY_STYLES,
  OSM_FALLBACK_METADATA,
  buildAzureMapsTileUrl,
  buildAzureMapsTileUrls,
  createAzureMapsCesiumImageryProviders,
  createOsmFallbackProvider,
  fetchAzureMapsAttribution,
  resolveAzureMapsCesiumImagery,
} from './mapsImagery.js';

class FakeResource {
  constructor(options) {
    Object.assign(this, options);
  }
}

class FakeCredit {
  constructor(html) {
    this.html = html;
  }
}

class FakeOsmProvider {
  constructor(options) {
    this.options = options;
  }
}

class FakeTilingScheme {
  constructor() {
    this.rectangle = { west: -Math.PI, south: -1, east: Math.PI, north: 1 };
  }
}

const FakeCesium = {
  Resource: FakeResource,
  Credit: FakeCredit,
  Event: class {},
  WebMercatorTilingScheme: FakeTilingScheme,
  OpenStreetMapImageryProvider: FakeOsmProvider,
  ImageryProvider: {
    loadImage() {
      throw new Error('test must inject loadImage');
    },
  },
};

function absolute(relative) {
  return new URL(relative, 'https://satview.test');
}

test('raster styles build finalized same-origin tile BFF URLs', () => {
  const expected = {
    satellite: ['microsoft.imagery'],
    hybrid: ['microsoft.imagery', 'microsoft.base.hybrid.road'],
    streets: ['microsoft.base.road'],
  };
  for (const [style, tilesetIds] of Object.entries(expected)) {
    const relativeUrls = buildAzureMapsTileUrls(style, 3, 5, 7);
    assert.ok(relativeUrls.every((url) => url.startsWith('/api/azure/maps/tile?')));
    const urls = relativeUrls.map(absolute);
    assert.deepEqual(urls.map((url) => url.searchParams.get('tilesetId')), tilesetIds);
    for (const url of urls) {
      assert.equal(url.pathname, AZURE_MAPS_IMAGERY_BFF_CONTRACTS.tile.path);
      assert.equal(url.searchParams.get('zoom'), '7');
      assert.equal(url.searchParams.get('x'), '3');
      assert.equal(url.searchParams.get('y'), '5');
      assert.equal(url.searchParams.get('tileSize'), '256');
      assert.equal(url.searchParams.has('api-version'), false);
      assert.equal(url.searchParams.has('subscription-key'), false);
      assert.equal(url.searchParams.has('access_token'), false);
    }
  }
  assert.equal(absolute(buildAzureMapsTileUrl('satellite', 3, 5, 7))
    .searchParams.get('tilesetId'), 'microsoft.imagery');
  assert.throws(() => buildAzureMapsTileUrl('hybrid', 3, 5, 7), /composite/);
  assert.equal(AZURE_MAPS_IMAGERY_STYLES.satellite.minimumLevel, 1);
  assert.equal(AZURE_MAPS_IMAGERY_STYLES.satellite.maximumLevel, 19);
});

test('Cesium hybrid constructs unauthenticated same-origin base and overlay providers', () => {
  const loaded = [];
  const providers = createAzureMapsCesiumImageryProviders(FakeCesium, {
    style: 'hybrid',
    loadImage: (owner, resource) => {
      loaded.push({ owner, resource });
      return { image: true };
    },
  });

  assert.equal(providers.length, 2);
  assert.equal(providers[0].azureMapsLayer.role, 'base');
  assert.equal(providers[0].minimumLevel, 1);
  assert.equal(providers[0].maximumLevel, 19);
  assert.equal(providers[0].hasAlphaChannel, false);
  assert.equal(providers[1].azureMapsLayer.role, 'overlay');
  assert.equal(providers[1].hasAlphaChannel, true);
  assert.deepEqual(
    providers.map((provider) => provider.requestImage(1, 2, 3, { throttle: true })),
    [{ image: true }, { image: true }],
  );
  assert.deepEqual(
    loaded.map(({ resource }) => absolute(resource.url).searchParams.get('tilesetId')),
    ['microsoft.imagery', 'microsoft.base.hybrid.road'],
  );
  for (let index = 0; index < loaded.length; index += 1) {
    assert.equal(loaded[index].owner, providers[index]);
    assert.equal('headers' in loaded[index].resource, false);
    assert.equal(providers[index].getTileCredits()[0].html, AZURE_MAPS_DEFAULT_ATTRIBUTION);
  }
});

test('attribution uses one same-origin BFF request without browser credentials', async () => {
  let request;
  const result = await fetchAzureMapsAttribution({
    style: 'satellite',
    bounds: { west: 24, south: 60, east: 25, north: 61 },
    zoom: 8,
    fetchImpl: async (url, init) => {
      request = { url, init };
      return new Response(JSON.stringify({
        copyrights: [{ copyright: '© Test imagery supplier' }, '© Microsoft'],
      }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    },
  });

  assert.deepEqual(result, ['© Test imagery supplier', '© Microsoft']);
  const url = absolute(request.url);
  assert.equal(url.pathname, AZURE_MAPS_IMAGERY_BFF_CONTRACTS.attribution.path);
  assert.equal(url.searchParams.get('tilesetId'), 'microsoft.imagery');
  assert.equal(url.searchParams.get('bounds'), '24,60,25,61');
  assert.equal(url.searchParams.get('zoom'), '8');
  assert.equal('headers' in request.init, false);
});

test('hybrid attribution sends both raster tilesets as one CSV parameter', async () => {
  const requests = [];
  const result = await fetchAzureMapsAttribution({
    style: 'hybrid',
    bounds: [24, 60, 25, 61],
    zoom: 20,
    fetchImpl: async (url, init) => {
      requests.push({ url, init });
      return new Response(JSON.stringify({
        copyrights: ['© imagery supplier', '© road supplier'],
      }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    },
  });

  assert.equal(requests.length, 1);
  assert.equal(
    absolute(requests[0].url).searchParams.get('tilesetId'),
    'microsoft.imagery,microsoft.base.hybrid.road',
  );
  assert.equal(absolute(requests[0].url).searchParams.get('zoom'), '19');
  assert.deepEqual(result, ['© imagery supplier', '© road supplier']);
});

test('hybrid resolution exposes providers in Cesium bottom-to-top order', async () => {
  const result = await resolveAzureMapsCesiumImagery(FakeCesium, {
    style: 'hybrid',
    loadImage: () => ({ image: true }),
  });

  assert.equal(result.provider, null, 'a composite must not masquerade as one Cesium provider');
  assert.equal(result.baseProvider.azureMapsLayer.tilesetId, 'microsoft.imagery');
  assert.deepEqual(
    result.overlayProviders.map(({ azureMapsLayer }) => azureMapsLayer.tilesetId),
    ['microsoft.base.hybrid.road'],
  );
  assert.deepEqual(result.providers, [result.baseProvider, ...result.overlayProviders]);
  assert.equal(result.fallback, null);
});

test('OSM fallback remains available as explicit metadata and provider helper', () => {
  const provider = createOsmFallbackProvider(FakeCesium);
  assert.equal(provider.options.url, OSM_FALLBACK_METADATA.url);
  assert.equal(provider.options.credit, OSM_FALLBACK_METADATA.credit);
});
