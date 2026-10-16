import test from 'node:test';
import assert from 'node:assert/strict';
import * as Cesium from 'cesium';
import {
  createIonImagery,
  createKartverketImagery,
  KARTVERKET_ATTRIBUTION_HTML,
} from './imagery.js';
import { createWorldTerrain, createKeylessTerrain } from './terrain.js';
import { createDefaultMapSources } from './defaultSources.js';

test('Esri uses Re:Earth without keys and preserves ion terrain when configured', async () => {
  const originalTerrain = Cesium.CesiumTerrainProvider.fromUrl;
  const originalResource = Cesium.IonResource.fromAssetId;
  const calls = [];
  try {
    Cesium.CesiumTerrainProvider.fromUrl = async (resource) => {
      calls.push(resource);
      return { resource };
    };
    Cesium.IonResource.fromAssetId = async () =>
      assert.fail('keyless mode must not acquire ion terrain');
    const keyless = createDefaultMapSources();
    const esri = keyless.sources.find(
      ({ descriptor }) => descriptor.id === 'esri-imagery',
    );
    assert.equal(esri.available, true);
    assert.equal(esri.terrain.id, 'keyless');
    assert.equal(esri.terrain.create, createKeylessTerrain);
    await esri.terrain.create();
    // A Resource, not a bare URL: the retry policy rides on it (terrainRetry.js).
    assert.equal(calls.length, 1);
    assert.ok(calls[0] instanceof Cesium.Resource);
    assert.equal(
      calls[0].url,
      'https://terrain.reearth.land/cesium-mesh/ellipsoid',
    );
    assert.equal(calls[0].retryAttempts, 3);
    assert.equal(typeof calls[0].retryCallback, 'function');
    assert.equal(
      keyless.sources.find(({ descriptor }) => descriptor.id === 'photoreal')
        .available,
      false,
    );
    for (const credentials of [
      { googleApiKey: 'test-key' },
      { cesiumToken: 'test-token' },
    ]) {
      const keyed = createDefaultMapSources({
        ...credentials,
        googleTileset: { show: true },
      });
      assert.equal(
        keyed.sources.find(({ descriptor }) => descriptor.id === 'photoreal')
          .available,
        true,
      );
      assert.equal(
        keyed.sources.find(({ descriptor }) => descriptor.id === 'esri-imagery')
          .terrain.id,
        credentials.cesiumToken ? 'world' : 'keyless',
      );
      const failedTileset = createDefaultMapSources(credentials);
      assert.equal(
        failedTileset.sources.find(
          ({ descriptor }) => descriptor.id === 'photoreal',
        ).available,
        false,
      );
    }
  } finally {
    Cesium.CesiumTerrainProvider.fromUrl = originalTerrain;
    Cesium.IonResource.fromAssetId = originalResource;
  }
});

test('imagery and terrain pass their own ion token without relying on SDK defaults', async () => {
  const originalImagery = Cesium.IonImageryProvider.fromAssetId;
  const originalResource = Cesium.IonResource.fromAssetId;
  const originalTerrain = Cesium.CesiumTerrainProvider.fromUrl;
  const calls = [];
  const defaultToken = Cesium.Ion.defaultAccessToken;
  try {
    Cesium.IonImageryProvider.fromAssetId = async (id, options) => {
      calls.push({ kind: 'imagery', id, options });
      return { id };
    };
    Cesium.IonResource.fromAssetId = async (id, options) => {
      calls.push({ kind: 'resource', id, options });
      return { id };
    };
    Cesium.CesiumTerrainProvider.fromUrl = async (resource, options) => {
      calls.push({ kind: 'terrain', resource, options });
      return { id: 'terrain' };
    };
    await createIonImagery(12345, 'imagery-token');
    const result = await createWorldTerrain('terrain-token');
    assert.equal(calls[0].options.accessToken, 'imagery-token');
    assert.equal(calls[1].options.accessToken, 'terrain-token');
    assert.equal(calls[1].id, 1);
    assert.equal(calls[2].options.requestVertexNormals, true);
    assert.equal(result.provider.id, 'terrain');
    assert.equal(Cesium.Ion.defaultAccessToken, defaultToken);
  } finally {
    Cesium.IonImageryProvider.fromAssetId = originalImagery;
    Cesium.IonResource.fromAssetId = originalResource;
    Cesium.CesiumTerrainProvider.fromUrl = originalTerrain;
  }
});

test('both Bing ion stacks use HTTPS and retain ion and per-tile attribution', async (t) => {
  const defaultToken = Cesium.Ion.defaultAccessToken;
  const metadataCalls = [];
  const bingCalls = [];
  const perTileCalls = [];
  const bingCredit = new Cesium.Credit('Bing tile credit', true);
  const endpoint = {
    type: 'IMAGERY',
    externalType: 'BING',
    options: Object.freeze({
      url: 'https://dev.virtualearth.net',
      key: 'ion-issued-bing-fixture',
      mapStyle: 'Aerial',
      tileProtocol: 'http',
    }),
    attributions: [
      { html: 'Ion required credit', collapsible: false },
      { html: 'Ion optional credit', collapsible: true },
    ],
  };
  t.mock.method(Cesium.Resource.prototype, 'fetchJson', async function () {
    metadataCalls.push({
      url: this.url,
      token: this.queryParameters.access_token,
    });
    const mapStyle = this.url.includes(
      `/assets/${Cesium.IonWorldImageryStyle.AERIAL_WITH_LABELS}/`,
    )
      ? 'AerialWithLabels'
      : 'Aerial';
    return {
      ...endpoint,
      options: Object.freeze({ ...endpoint.options, mapStyle }),
    };
  });
  t.mock.method(Cesium.IonImageryProvider, 'fromAssetId', () =>
    assert.fail('Bing must not inherit the local HTTP page protocol'),
  );
  t.mock.method(
    Cesium.BingMapsImageryProvider,
    'fromUrl',
    async (url, options) => {
      bingCalls.push({ url, options });
      const provider = {
        errorEvent: new Cesium.Event(),
        getTileCredits(x, y, level) {
          assert.equal(this, provider);
          perTileCalls.push([x, y, level]);
          return level === 0 ? undefined : [bingCredit];
        },
      };
      return provider;
    },
  );
  for (const style of [
    Cesium.IonWorldImageryStyle.AERIAL,
    Cesium.IonWorldImageryStyle.AERIAL_WITH_LABELS,
  ]) {
    const provider = await createIonImagery(style, ' own-ion-token ');
    const credits = provider.getTileCredits(3, 4, 5);
    assert.deepEqual(
      credits.map(({ html, showOnScreen }) => ({ html, showOnScreen })),
      [
        { html: 'Ion required credit', showOnScreen: true },
        { html: 'Ion optional credit', showOnScreen: false },
        { html: 'Bing tile credit', showOnScreen: true },
      ],
    );
    assert.equal(credits[2], bingCredit);
    assert.equal(provider.getTileCredits(0, 0, 0).length, 2);
    assert.ok(provider.errorEvent instanceof Cesium.Event);
    assert.equal(metadataCalls.at(-1).token, 'own-ion-token');
    const requested = new URL(metadataCalls.at(-1).url);
    assert.equal(requested.origin, 'https://api.cesium.com');
    assert.equal(requested.pathname, `/v1/assets/${style}/endpoint`);
  }
  assert.deepEqual(perTileCalls, [
    [3, 4, 5],
    [0, 0, 0],
    [3, 4, 5],
    [0, 0, 0],
  ]);
  assert.equal(bingCalls.length, 2);
  for (const [index, { url, options }] of bingCalls.entries()) {
    assert.equal(url, 'https://dev.virtualearth.net');
    assert.deepEqual(options, {
      key: 'ion-issued-bing-fixture',
      mapStyle: index === 0 ? 'Aerial' : 'AerialWithLabels',
      tileProtocol: 'https',
    });
  }
  assert.equal(endpoint.options.tileProtocol, 'http');
  assert.equal(Cesium.Ion.defaultAccessToken, defaultToken);
});

test('Bing ion metadata and construction failures propagate without another source', async (t) => {
  const style = Cesium.IonWorldImageryStyle.AERIAL;
  const metadataError = new Error('ion metadata fixture failure');
  const providerError = new Error('Bing construction fixture failure');
  let metadata = () => {
    throw metadataError;
  };
  let bingCalls = 0;
  t.mock.method(Cesium.Resource.prototype, 'fetchJson', async () => metadata());
  t.mock.method(Cesium.BingMapsImageryProvider, 'fromUrl', async () => {
    bingCalls += 1;
    throw providerError;
  });
  t.mock.method(Cesium.IonImageryProvider, 'fromAssetId', () =>
    assert.fail('Bing failures must not silently use an alternate provider'),
  );
  await assert.rejects(createIonImagery(style, 'test-token'), metadataError);
  for (const endpoint of [
    undefined,
    {
      type: 'TERRAIN',
      externalType: 'BING',
      options: { url: 'https://example.test' },
    },
    {
      type: 'IMAGERY',
      externalType: 'OTHER',
      options: { url: 'https://example.test' },
    },
    { type: 'IMAGERY', externalType: 'BING', options: {} },
  ]) {
    metadata = () => endpoint;
    await assert.rejects(
      createIonImagery(style, 'test-token'),
      /Bing imagery endpoint/,
    );
  }
  assert.equal(bingCalls, 0);
  metadata = () => ({
    type: 'IMAGERY',
    externalType: 'BING',
    options: { url: 'https://dev.virtualearth.net', key: 'bing-fixture' },
  });
  await assert.rejects(createIonImagery(style, 'test-token'), providerError);
  assert.equal(bingCalls, 1);
});

test('other ion imagery assets keep the standard SDK factory', async (t) => {
  const expected = {};
  const calls = [];
  t.mock.method(Cesium.Resource.prototype, 'fetchJson', () =>
    assert.fail('generic assets must use the SDK ion factory'),
  );
  t.mock.method(Cesium.IonImageryProvider, 'fromAssetId', async (...args) => {
    calls.push(args);
    return expected;
  });
  assert.equal(await createIonImagery(12345, ' custom-token '), expected);
  assert.deepEqual(calls, [[12345, { accessToken: 'custom-token' }]]);
});

test('cancellation after ion metadata prevents terrain construction', async () => {
  const originalResource = Cesium.IonResource.fromAssetId;
  const originalTerrain = Cesium.CesiumTerrainProvider.fromUrl;
  const controller = new AbortController();
  try {
    Cesium.IonResource.fromAssetId = async () => {
      controller.abort();
      return {};
    };
    Cesium.CesiumTerrainProvider.fromUrl = () =>
      assert.fail('cancelled terrain construction');
    await assert.rejects(
      createWorldTerrain('test-token', { signal: controller.signal }),
      { name: 'AbortError' },
    );
  } finally {
    Cesium.IonResource.fromAssetId = originalResource;
    Cesium.CesiumTerrainProvider.fromUrl = originalTerrain;
  }
});

test('credentialed source factories reject an omitted token instead of consuming an SDK default', async () => {
  assert.throws(
    () => createIonImagery(Cesium.IonWorldImageryStyle.AERIAL, ''),
    /explicit token/,
  );
  await assert.rejects(createWorldTerrain(' '), /explicit ion token/);
});

test('both Google 3D routes keep tiles drawing while draped imagery loads', async () => {
  const { createGoogleDirectTileset, createGoogleIonTileset } =
    await import('./google3d.js');
  const calls = [];
  const sdk = {
    createGooglePhotorealistic3DTileset: async (...args) => {
      calls.push(args);
      return 'direct';
    },
    IonResource: { fromAssetId: async (id, options) => ({ id, ...options }) },
    Cesium3DTileset: {
      fromUrl: async (...args) => {
        calls.push(args);
        return 'ion';
      },
    },
  };
  assert.equal(await createGoogleDirectTileset(sdk, 'key'), 'direct');
  assert.equal(await createGoogleIonTileset(sdk, 'token'), 'ion');
  assert.deepEqual(calls[0], [
    { key: 'key', onlyUsingWithGoogleGeocoder: true },
    { asynchronouslyLoadImagery: true },
  ]);
  assert.equal(calls[1][0].id, 2275207);
  assert.equal(calls[1][0].accessToken, 'token');
  assert.equal(calls[1][1].asynchronouslyLoadImagery, true);
  assert.equal(calls[1][1].enableCollision, true);
});

test('Kartverket topo and nautical charts are keyless web-mercator tiles bounded to their extent, falling back to OSM', () => {
  const { sources } = createDefaultMapSources();
  for (const [id, layer] of [
    ['kartverket-topo', 'topo'],
    ['kartverket-nautical', 'sjokartraster'],
  ]) {
    const source = sources.find(({ descriptor }) => descriptor.id === id);
    assert.equal(source.available, true, `${id} needs no key`);
    assert.equal(source.terrain.id, 'keyless');
    assert.equal(source.credit, KARTVERKET_ATTRIBUTION_HTML);
    assert.deepEqual(source.tileFailureFallback.id, 'osm');
    const provider = source.imagery();
    assert.ok(provider instanceof Cesium.UrlTemplateImageryProvider);
    assert.ok(provider.tilingScheme instanceof Cesium.WebMercatorTilingScheme);
    assert.equal(provider.maximumLevel, 18);
    assert.equal(
      provider.url,
      `https://cache.kartverket.no/v1/wmts/1.0.0/${layer}/default/webmercator/{z}/{y}/{x}.png`,
    );
    // Oslo is inside both extents; New York is outside them.
    const oslo = Cesium.Cartographic.fromDegrees(10.75, 59.91);
    const newYork = Cesium.Cartographic.fromDegrees(-74, 40.7);
    assert.ok(Cesium.Rectangle.contains(provider.rectangle, oslo));
    assert.ok(!Cesium.Rectangle.contains(provider.rectangle, newYork));
  }
  assert.throws(() => createKartverketImagery('norge-i-bilder'), /Unknown/);
});
