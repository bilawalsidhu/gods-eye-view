import test from 'node:test';
import assert from 'node:assert/strict';
import {
  browserMemoryClass,
  createGoogleDirectTileset,
  createGoogleIonTileset,
  createGoogleTokenTileset,
  loadPhotorealisticTileset,
  photorealCacheBudget,
} from './google3d.js';

const MIB = 1024 * 1024;
const DESKTOP = {
  cacheBytes: 1536 * MIB,
  maximumCacheOverflowBytes: 1024 * MIB,
};
const PHONE = { cacheBytes: 384 * MIB, maximumCacheOverflowBytes: 128 * MIB };

/** A Cesium stand-in recording the tileset options each route passes. */
function fakeCesium() {
  const options = [];
  return {
    options,
    GoogleMaps: {
      mapTilesApiEndpoint: 'https://tile.googleapis.com/',
      getDefaultCredit: () => undefined,
    },
    Resource: class {
      constructor(init) {
        Object.assign(this, init);
      }
    },
    async createGooglePhotorealistic3DTileset(api, tilesetOptions) {
      options.push(tilesetOptions);
      return { route: 'direct' };
    },
    IonResource: { fromAssetId: async (id, init) => ({ id, ...init }) },
    Cesium3DTileset: {
      async fromUrl(resource, tilesetOptions) {
        options.push(tilesetOptions);
        return { route: 'url' };
      },
    },
  };
}

const tokens = { token: async () => 'fixture-token' };

/** Runs `fn` with the browser's pointer media and memory as given. */
async function inBrowser({ coarse, fine, deviceMemory }, fn) {
  const had = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
  const hadMedia = globalThis.matchMedia;
  globalThis.matchMedia = (query) => ({
    matches:
      (query === '(pointer: coarse)' && coarse) ||
      (query === '(any-pointer: fine)' && fine),
  });
  Object.defineProperty(globalThis, 'navigator', {
    configurable: true,
    value: { deviceMemory },
  });
  try {
    return await fn();
  } finally {
    globalThis.matchMedia = hadMedia;
    if (had) Object.defineProperty(globalThis, 'navigator', had);
    else delete globalThis.navigator;
  }
}

test('desktops keep the cache Cesium gives Google 3D', () => {
  assert.deepEqual(photorealCacheBudget(), DESKTOP);
  assert.deepEqual(
    photorealCacheBudget({ touchOnly: false, deviceMemory: 8 }),
    DESKTOP,
  );
  // Safari and Firefox report no memory.
  assert.deepEqual(photorealCacheBudget({ deviceMemory: undefined }), DESKTOP);
  assert.deepEqual(photorealCacheBudget({ deviceMemory: NaN }), DESKTOP);
});

test('touch-only and low-memory devices get 384 MiB and 128 MiB over', () => {
  assert.deepEqual(photorealCacheBudget({ touchOnly: true }), PHONE);
  assert.deepEqual(
    photorealCacheBudget({ touchOnly: true, deviceMemory: 8 }),
    PHONE,
  );
  assert.deepEqual(photorealCacheBudget({ deviceMemory: 4 }), PHONE);
  assert.deepEqual(photorealCacheBudget({ deviceMemory: 0.5 }), PHONE);
});

test('the browser is touch only with a coarse pointer and no fine one', async () => {
  assert.deepEqual(
    await inBrowser({ coarse: true, fine: false, deviceMemory: 4 }, () =>
      browserMemoryClass(),
    ),
    { touchOnly: true, deviceMemory: 4 },
  );
  // A tablet with a trackpad, or a touch laptop.
  assert.equal(
    await inBrowser(
      { coarse: true, fine: true },
      () => browserMemoryClass().touchOnly,
    ),
    false,
  );
  assert.equal(
    await inBrowser(
      { coarse: false, fine: true },
      () => browserMemoryClass().touchOnly,
    ),
    false,
  );
});

test('every Google 3D route caches within the budget it is given', async () => {
  const Cesium = fakeCesium();
  await createGoogleDirectTileset(Cesium, 'key', { budget: PHONE });
  await createGoogleTokenTileset(Cesium, tokens, { budget: PHONE });
  await createGoogleIonTileset(Cesium, 'ion', { budget: PHONE });
  const routes = [];
  for (const source of [
    { googleApiKey: 'key' },
    { googleTokens: tokens },
    { cesiumToken: 'ion' },
  ]) {
    const result = await loadPhotorealisticTileset(Cesium, source, {
      budget: PHONE,
    });
    routes.push(result.route);
  }
  assert.deepEqual(routes, ['google-direct', 'google-token', 'google-ion']);
  assert.equal(Cesium.options.length, 6);
  for (const options of Cesium.options) {
    assert.equal(options.cacheBytes, PHONE.cacheBytes);
    assert.equal(
      options.maximumCacheOverflowBytes,
      PHONE.maximumCacheOverflowBytes,
    );
    assert.equal(options.enableCollision, true);
    assert.equal(options.asynchronouslyLoadImagery, true);
  }
});

test('every Google 3D route reads the budget from the browser by default', async () => {
  for (const [browser, budget] of [
    [{ coarse: true, fine: false }, PHONE],
    [{ coarse: false, fine: true, deviceMemory: 2 }, PHONE],
    [{ coarse: false, fine: true, deviceMemory: 8 }, DESKTOP],
  ]) {
    const Cesium = fakeCesium();
    const routes = await inBrowser(browser, async () => [
      (await loadPhotorealisticTileset(Cesium, { googleApiKey: 'key' })).route,
      (await loadPhotorealisticTileset(Cesium, { googleTokens: tokens })).route,
      (await loadPhotorealisticTileset(Cesium, { cesiumToken: 'ion' })).route,
    ]);
    assert.deepEqual(routes, ['google-direct', 'google-token', 'google-ion']);
    assert.equal(Cesium.options.length, 3);
    for (const options of Cesium.options) {
      assert.equal(options.cacheBytes, budget.cacheBytes);
      assert.equal(
        options.maximumCacheOverflowBytes,
        budget.maximumCacheOverflowBytes,
      );
    }
  }
});
