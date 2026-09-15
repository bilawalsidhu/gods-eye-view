import test from 'node:test';
import assert from 'node:assert/strict';
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
    GoogleMaps: { defaultApiKey: undefined },
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
          ionToken: resource.accessToken,
          assetId: resource.assetId,
        });
        return next();
      },
    },
  };
}

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
  const result = await loadPhotorealisticTileset(Cesium, {
    googleApiKey: 'google-secret',
    cesiumToken: 'ion-secret',
  });
  assert.equal(result.tileset, tileset);
  assert.equal(result.route, 'google-direct');
  assert.equal(Cesium.calls[0].googleKey, 'google-secret');
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
