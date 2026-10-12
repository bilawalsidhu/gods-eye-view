import test from 'node:test';
import assert from 'node:assert/strict';
import {
  isMobileResourceConstrained,
  mobileTilesetOptions,
} from './mobileResourcePolicy.js';
import {
  createGoogleDirectTileset,
  createGoogleTokenTileset,
  createGoogleIonTileset,
} from './maps/google3d.js';

test('phone budget requires a touch pointer and a short viewport; narrow desktop is unchanged', () => {
  assert.equal(
    isMobileResourceConstrained({ coarsePointer: true, shortViewport: true }),
    true,
  );
  assert.equal(
    isMobileResourceConstrained({ coarsePointer: false, shortViewport: true }),
    false,
  );
  assert.equal(
    isMobileResourceConstrained({ coarsePointer: true, shortViewport: false }),
    false,
  );
  assert.deepEqual(mobileTilesetOptions(false), {});
});

test('all three Google tile routes apply the phone cache and detail budget before loading', async () => {
  const old = globalThis.matchMedia;
  globalThis.matchMedia = () => ({ matches: true });
  const calls = [];
  class Resource {
    constructor(options) {
      Object.assign(this, options);
    }
  }
  const sdk = {
    Resource,
    GoogleMaps: { mapTilesApiEndpoint: 'https://example.invalid/' },
    createGooglePhotorealistic3DTileset: async (_key, options) =>
      calls.push(options),
    Cesium3DTileset: { fromUrl: async (_url, options) => calls.push(options) },
    IonResource: { fromAssetId: async () => ({}) },
  };
  try {
    await createGoogleDirectTileset(sdk, 'fixture');
    await createGoogleTokenTileset(sdk, { token: async () => 'fixture' });
    await createGoogleIonTileset(sdk, 'fixture');
    for (const options of calls) {
      assert.equal(options.cacheBytes, 128 * 1024 * 1024);
      assert.equal(options.maximumCacheOverflowBytes, 32 * 1024 * 1024);
      assert.equal(options.maximumScreenSpaceError, 32);
      assert.equal(options.asynchronouslyLoadImagery, true);
    }
    assert.equal(calls.length, 3);
  } finally {
    if (old) globalThis.matchMedia = old;
    else delete globalThis.matchMedia;
  }
});
