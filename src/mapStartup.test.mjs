import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { createGoogleTokenSource } from './maps/googleTokens.js';
import {
  loadPhotorealisticTileset,
  selectMapStartupRoute,
} from './mapStartup.js';

function fakeCesium(outcomes = []) {
  const calls = [];
  const next = () => {
    const outcome = outcomes.shift();
    if (outcome instanceof Error) throw outcome;
    return outcome;
  };
  return {
    calls,
    Ion: { defaultAccessToken: undefined },
    GoogleMaps: {
      defaultApiKey: undefined,
      mapTilesApiEndpoint: 'https://tile.googleapis.com/',
      getDefaultCredit: () => undefined,
    },
    Resource: class {
      constructor(options) {
        Object.assign(this, options);
      }
    },
    async createGooglePhotorealistic3DTileset(options) {
      calls.push({ options, googleKey: options.key });
      return next();
    },
    IonResource: {
      async fromAssetId(assetId, options) {
        return { assetId, ...options };
      },
    },
    Cesium3DTileset: {
      async fromUrl(resource, options) {
        calls.push({
          options,
          resource,
          ionToken: resource.accessToken,
          assetId: resource.assetId,
        });
        return next();
      },
    },
  };
}

async function standaloneStartup(Cesium, credentials, fetchImpl) {
  // Exercise the actual assembly; replace browser-only imports at its scene seam.
  const source = readFileSync(
    new URL('./standalone/application.js', import.meta.url),
    'utf8',
  )
    .replace(/^import .*;\n/gm, '')
    .replace(/^export /gm, '');
  const context = vm.createContext({
    document: {
      getElementById: () => ({ querySelector: () => ({}) }),
    },
    resolveLocale: () => 'en',
    setLocale() {},
    applyDocumentLanguage() {},
    applyDocumentTranslations() {},
    CITY_POIS: [],
    createApplication: (options) => options,
    createStandalonePlaceSearch: () => ({}),
    createStandaloneCatalog: () => ({}),
    createGoogleTokenSource: () => createGoogleTokenSource({ fetchImpl }),
    selectMapStartupRoute,
    // The real scene forwards these credentials to this same loader.
    createStandaloneScene: async (options) => ({
      ...(await loadPhotorealisticTileset(Cesium, options)),
      operations: {},
    }),
  });
  vm.runInContext(source, context);
  const app = context.createStandaloneApplication(credentials);
  return app.createScene({ signal: new AbortController().signal });
}

test('standalone falls back to ion when the server token route is unavailable', async () => {
  const tileset = { id: 'ion' };
  const Cesium = fakeCesium([tileset]);
  const requests = [];
  const result = await standaloneStartup(
    Cesium,
    { cesiumToken: 'ion-fixture' },
    async (url) => {
      requests.push(url);
      return { ok: false };
    },
  );
  assert.equal(result.route, 'google-ion');
  assert.equal(result.tileset, tileset);
  assert.deepEqual(requests, ['/api/google/tiles-token']);
  assert.equal(result.errors.length, 1);
  assert.equal(Cesium.calls[0].assetId, 2275207);
});

test('standalone uses server tokens without a browser key and preserves keyless fallback', async () => {
  const tileset = { id: 'server-token' };
  const Cesium = fakeCesium([tileset]);
  const requests = [];
  const result = await standaloneStartup(Cesium, {}, async (url) => {
    requests.push(url);
    return {
      ok: true,
      json: async () => ({
        accessToken: 'server-fixture',
        expiresAt: Date.now() + 120_000,
      }),
    };
  });
  assert.equal(result.route, 'google-token');
  assert.equal(result.tileset, tileset);
  assert.deepEqual(requests, ['/api/google/tiles-token']);
  assert.equal(
    Cesium.calls[0].resource.headers.Authorization,
    'Bearer server-fixture',
  );
  assert.deepEqual(result.errors, []);
  const fallback = await standaloneStartup(fakeCesium(), {}, async () => ({
    status: 204,
  }));
  assert.equal(fallback.route, 'osm');
  assert.equal(fallback.tileset, null);
});

test('map startup route reflects the best configured provider', () => {
  assert.equal(
    selectMapStartupRoute({ googleApiKey: 'google', cesiumToken: 'ion' }),
    'google-direct',
  );
  assert.equal(selectMapStartupRoute({ cesiumToken: 'ion' }), 'google-ion');
  assert.equal(selectMapStartupRoute(), 'osm');
});

test('no credentials skip photoreal loading and preserve keyless startup', async () => {
  const Cesium = fakeCesium();
  const result = await loadPhotorealisticTileset(Cesium);
  assert.equal(result.tileset, null);
  assert.equal(result.route, 'osm');
  assert.equal(Cesium.calls.length, 0);
});

test('a direct Google key is preferred', async () => {
  const tileset = { id: 'direct' };
  const Cesium = fakeCesium([tileset]);
  let tokenRequests = 0;
  const result = await standaloneStartup(
    Cesium,
    {
      googleApiKey: 'google-secret',
      cesiumToken: 'ion-secret',
    },
    async () => {
      tokenRequests++;
      return { status: 204 };
    },
  );
  assert.equal(result.tileset, tileset);
  assert.equal(result.route, 'google-direct');
  assert.equal(Cesium.calls[0].googleKey, 'google-secret');
  assert.equal(tokenRequests, 0);
});

test('an ion-only setup loads the hosted Google 3D asset', async () => {
  const tileset = { id: 'ion' };
  const Cesium = fakeCesium([tileset]);
  const result = await loadPhotorealisticTileset(Cesium, {
    cesiumToken: 'ion-secret',
  });
  assert.equal(result.tileset, tileset);
  assert.equal(result.route, 'google-ion');
  assert.equal(Cesium.calls.length, 1);
  assert.equal(Cesium.calls[0].googleKey, undefined);
  assert.equal(Cesium.calls[0].ionToken, 'ion-secret');
  assert.equal(Cesium.Ion.defaultAccessToken, undefined);
  assert.equal(Cesium.calls[0].assetId, 2275207);
  assert.equal(Cesium.calls[0].options.enableCollision, true);
});

test('a failed direct request retries through ion before falling back', async () => {
  const tileset = { id: 'ion-fallback' };
  const Cesium = fakeCesium([new Error('direct denied'), tileset]);
  const result = await loadPhotorealisticTileset(Cesium, {
    googleApiKey: 'google-secret',
    cesiumToken: 'ion-secret',
  });
  assert.equal(result.tileset, tileset);
  assert.equal(result.route, 'google-ion');
  assert.equal(result.errors.length, 1);
  assert.equal(Cesium.calls[0].googleKey, 'google-secret');
  assert.equal(Cesium.calls[1].googleKey, undefined);
  assert.equal(Cesium.calls.length, 2);
});

test('a failed direct-only request does not consume an implicit Cesium token', async () => {
  const Cesium = fakeCesium([new Error('direct denied')]);
  const result = await loadPhotorealisticTileset(Cesium, {
    googleApiKey: 'google-secret',
  });
  assert.equal(result.tileset, null);
  assert.equal(result.route, 'osm');
  assert.equal(result.errors.length, 1);
  assert.equal(Cesium.calls.length, 1);
  assert.equal(Cesium.calls[0].googleKey, 'google-secret');
  assert.equal(Cesium.GoogleMaps.defaultApiKey, undefined);
});

test('failed direct and ion requests preserve the keyless OSM fallback', async () => {
  const Cesium = fakeCesium([
    new Error('direct denied'),
    new Error('ion denied'),
  ]);
  const result = await loadPhotorealisticTileset(Cesium, {
    googleApiKey: 'google-secret',
    cesiumToken: 'ion-secret',
  });
  assert.equal(result.tileset, null);
  assert.equal(result.route, 'osm');
  assert.equal(result.errors.length, 2);
  assert.equal(Cesium.calls.length, 2);
  assert.equal(Cesium.GoogleMaps.defaultApiKey, undefined);
});

test('independent source configurations never mutate shared SDK credentials', async () => {
  const Cesium = fakeCesium([{ id: 'a' }, { id: 'b' }]);
  Cesium.Ion.defaultAccessToken = 'untouched-ion';
  Cesium.GoogleMaps.defaultApiKey = 'untouched-google';
  await Promise.all([
    loadPhotorealisticTileset(Cesium, { googleApiKey: 'source-a' }),
    loadPhotorealisticTileset(Cesium, { cesiumToken: 'source-b' }),
  ]);
  assert.equal(Cesium.calls[0].googleKey, 'source-a');
  assert.equal(Cesium.calls[1].ionToken, 'source-b');
  assert.equal(Cesium.Ion.defaultAccessToken, 'untouched-ion');
  assert.equal(Cesium.GoogleMaps.defaultApiKey, 'untouched-google');
});

function tokenSource(...issued) {
  const requests = [];
  return {
    requests,
    async token(options = {}) {
      requests.push(options);
      return issued.shift() ?? null;
    },
  };
}

test('without a key, server tokens load Google 3D directly', async () => {
  const tileset = { id: 'token' };
  const Cesium = fakeCesium([tileset]);
  const result = await loadPhotorealisticTileset(Cesium, {
    googleTokens: tokenSource('short-lived'),
    cesiumToken: 'ion-secret',
  });
  assert.equal(result.tileset, tileset);
  assert.equal(result.route, 'google-token');
  const { resource, options } = Cesium.calls[0];
  assert.equal(
    resource.url,
    'https://tile.googleapis.com/v1/3dtiles/root.json',
  );
  assert.equal(resource.headers.Authorization, 'Bearer short-lived');
  assert.equal(resource.queryParameters, undefined);
  assert.equal(options.enableCollision, true);
});

test('a tile refused for an expired token retries once with a renewed one', async () => {
  const Cesium = fakeCesium([{ id: 'token' }]);
  const tokens = tokenSource('first', 'second');
  await loadPhotorealisticTileset(Cesium, { googleTokens: tokens });
  const { resource } = Cesium.calls[0];
  const tile = { headers: { ...resource.headers } };
  assert.equal(await resource.retryCallback(tile, { statusCode: 401 }), true);
  assert.equal(tile.headers.Authorization, 'Bearer second');
  assert.deepEqual(tokens.requests.at(-1), { replacing: 'first' });
  assert.equal(resource.retryAttempts, 1);
  assert.equal(await resource.retryCallback(tile, { statusCode: 500 }), false);
});

test('a key takes precedence over server tokens', async () => {
  const Cesium = fakeCesium([{ id: 'direct' }]);
  const tokens = tokenSource('short-lived');
  const result = await loadPhotorealisticTileset(Cesium, {
    googleApiKey: 'google-secret',
    googleTokens: tokens,
  });
  assert.equal(result.route, 'google-direct');
  assert.equal(tokens.requests.length, 0);
});

test('a server without tokens falls back to ion', async () => {
  const tileset = { id: 'ion' };
  const Cesium = fakeCesium([tileset]);
  const result = await loadPhotorealisticTileset(Cesium, {
    googleTokens: tokenSource(),
    cesiumToken: 'ion-secret',
  });
  assert.equal(result.route, 'google-ion');
  assert.equal(result.errors.length, 1);
  assert.equal(Cesium.calls.length, 1);
});
