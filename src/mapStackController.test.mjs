// src/mapStackController.test.mjs
// Drives the map-stack state machine against a fake viewer and the REAL
// Cesium library. Cesium's ESM namespace is frozen (namespace members are
// read-only), so the seams here are the mutable parts of that surface:
// class statics (`IonImageryProvider.fromAssetId`, `CesiumTerrainProvider.
// fromUrl`, `Terrain.fromWorldTerrain`) are patched per test with
// save/restore, while the offline-safe constructors this module exercises
// (`ImageryLayer` with a fake tiling-scheme provider, `OpenStreetMapImagery
// Provider`, `EllipsoidTerrainProvider`) run for real — no network is
// touched, because none of them fetch until they're attached to a scene.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as Cesium from 'cesium';
import { MAP_STACKS, MapStackController } from './mapStackController.js';

const REEARTH_URL = 'https://terrain.reearth.land/cesium-mesh/ellipsoid';

/** Patch mutable Cesium class statics for one test; restores prior values. */
function stubCesiumStatics(overrides) {
  const restoreLog = [];
  for (const [fullName, replacement] of Object.entries(overrides)) {
    const [className, staticName] = fullName.split('.');
    const owner = Cesium[className];
    restoreLog.push([owner, staticName, owner[staticName]]);
    owner[staticName] = replacement;
  }
  return () => {
    for (const [owner, name, prior] of restoreLog.reverse()) {
      owner[name] = prior;
    }
  };
}

/** Minimal offline-safe imagery provider for the real ImageryLayer ctor. */
function fakeProvider() {
  return { tilingScheme: new Cesium.WebMercatorTilingScheme() };
}

/** Fake viewer: records imagery-layer ops, terrain installs, globe/tileset flags. */
function fakeViewer() {
  const ops = { added: [], removed: [], setTerrain: [] };
  const viewer = {
    scene: {
      globe: { show: undefined },
      setTerrain: (terrain) => ops.setTerrain.push(terrain),
    },
    imageryLayers: {
      add: (layer, index) => ops.added.push({ layer, index }),
      remove: (layer, destroy) => ops.removed.push({ layer, destroy }),
    },
    ops,
  };
  let installedTerrain;
  Object.defineProperty(viewer, 'terrainProvider', {
    get: () => installedTerrain,
    set: (provider) => {
      installedTerrain = provider;
      ops.terrainInstalls = (ops.terrainInstalls || 0) + 1;
    },
  });
  return viewer;
}

/** A controller with no ion token and (by default) no Google tileset. */
function keylessController({ tileset = null, onError = null } = {}) {
  return new MapStackController(fakeViewer(), {
    googleTileset: tileset,
    cesiumToken: '',
    onError,
  });
}

const changeEvents = (controller) => {
  const events = [];
  controller._onChange = (state) => events.push(state.status);
  return events;
};

test('MAP_STACKS: four stacks in contract order with the right kinds', () => {
  assert.deepEqual(MAP_STACKS.map((s) => s.id), ['photoreal', 'bing-aerial', 'bing-labels', 'osm']);
  assert.equal(MAP_STACKS.find((s) => s.id === 'photoreal').kind, 'photoreal');
  assert.equal(MAP_STACKS.find((s) => s.id === 'osm').requiresIon, false);
  assert.equal(MAP_STACKS.filter((s) => s.requiresIon).length, 2, 'both Bing stacks need ion');
});

test('constructor: keyless boot without a tileset lands on OSM; tileset boot lands on photoreal', () => {
  assert.equal(keylessController().getActiveId(), 'osm');
  assert.equal(new MapStackController(fakeViewer(), {
    googleTileset: { show: true }, cesiumToken: '',
  }).getActiveId(), 'photoreal');
  // An unknown initial stack falls back to what IS available.
  assert.equal(new MapStackController(fakeViewer(), {
    googleTileset: { show: true }, cesiumToken: '', initialStack: 'nonsense',
  }).getActiveId(), 'photoreal');
});

test('getStacks: availability and a reason from the single deciding place', () => {
  const keyless = Object.fromEntries(
    keylessController().getStacks().map((s) => [s.id, s]),
  );
  assert.equal(keyless['photoreal'].available, false);
  assert.equal(keyless['photoreal'].unavailableReason, 'Google 3D is unavailable');
  assert.equal(keyless['bing-aerial'].unavailableReason, 'Cesium ion token required for Bing stacks');
  assert.equal(keyless['osm'].available, true);
  assert.equal(keyless['osm'].unavailableReason, null);

  // With a token + tileset everything flips available and reasons disappear.
  const tokened = Object.fromEntries(new MapStackController(fakeViewer(), {
    googleTileset: { show: true }, cesiumToken: 'tok',
  }).getStacks().map((s) => [s.id, s]));
  assert.equal(tokened['bing-labels'].available, true);
  assert.equal(tokened['bing-labels'].unavailableReason, null);
  assert.equal(tokened['photoreal'].available, true);
});

test('setStack: an unavailable stack refuses without touching the scene', async () => {
  const errors = [];
  const controller = keylessController({ onError: (message) => errors.push(message) });
  const before = controller.getSwitchGeneration();
  const state = await controller.setStack('bing-aerial');
  assert.equal(errors.length, 1, 'the refusal is reported through onError');
  assert.match(errors[0], /ion token required/);
  assert.equal(state.lastError, errors[0]);
  assert.equal(state.activeId, 'osm', 'the active stack is unchanged');
  assert.equal(controller.getSwitchGeneration(), before, 'a refusal is not a switch');
  assert.equal(controller.getState().status, 'ready');
});

test('setStack: an unknown id falls back to photoreal, then refuses when unavailable', async () => {
  const errors = [];
  const controller = keylessController({ onError: (message) => errors.push(message) });
  const state = await controller.setStack('no-such-stack');
  assert.match(errors[0], /Google 3D is unavailable/);
  assert.equal(state.activeId, 'osm');
});

test('setStack to OSM: installs the provider at index 0, hides the tileset, installs Re:Earth terrain', async () => {
  const terrainProvider = { id: 'reearth' };
  const fromUrlCalls = [];
  const restore = stubCesiumStatics({
    'CesiumTerrainProvider.fromUrl': async (url) => {
      fromUrlCalls.push(url);
      return terrainProvider;
    },
  });
  try {
    const controller = keylessController({ tileset: { show: true } });
    const events = changeEvents(controller);
    const viewer = controller.viewer;
    const state = await controller.setStack('osm');
    assert.equal(state.status, 'ready');
    assert.equal(state.activeId, 'osm');
    assert.equal(state.activeStack.label, 'OSM');
    assert.equal(state.lastError, null);
    assert.equal(state.hasCesiumIonToken, false);
    assert.deepEqual(events, ['switching', 'ready']);
    // Imagery: one real layer at index 0 wrapping a real OSM provider.
    assert.equal(viewer.ops.added.length, 1);
    assert.equal(viewer.ops.added[0].index, 0);
    assert.ok(viewer.ops.added[0].layer instanceof Cesium.ImageryLayer);
    assert.match(viewer.ops.added[0].layer._imageryProvider.url, /^https:\/\/tile\.openstreetmap\.org\//);
    assert.equal(viewer.ops.added[0].layer._imageryProvider.credit.html, '© OpenStreetMap contributors');
    // Photoreal tileset hidden, globe shown, Re:Earth terrain installed once.
    assert.equal(controller.googleTileset.show, false);
    assert.equal(viewer.scene.globe.show, true);
    assert.equal(viewer.ops.terrainInstalls, 1);
    assert.equal(viewer.terrainProvider, terrainProvider);
    assert.deepEqual(fromUrlCalls, [REEARTH_URL]);
    assert.equal(controller._terrainMode, 'keyless');
    // The switch generation advanced by exactly this switch.
    assert.equal(controller.getSwitchGeneration(), 1);
  } finally {
    restore();
  }
});

test('provider and terrain caches: repeat switches neither refetch nor reinstall', async () => {
  const terrainProvider = { id: 'reearth' };
  const restore = stubCesiumStatics({
    'CesiumTerrainProvider.fromUrl': async () => terrainProvider,
  });
  try {
    const controller = keylessController({ tileset: { show: true } });
    const viewer = controller.viewer;
    await controller.setStack('osm');
    const cachedProvider = controller._imageryProviders.get('osm');
    assert.ok(cachedProvider, 'the OSM provider is cached after the first switch');
    const installsAfterFirst = viewer.ops.terrainInstalls;
    await controller.setStack('osm');
    assert.equal(controller._imageryProviders.get('osm'), cachedProvider);
    assert.equal(viewer.ops.added.length, 2, 'a new layer wraps the same cached provider');
    assert.equal(viewer.ops.added[1].layer._imageryProvider, cachedProvider);
    assert.equal(viewer.ops.terrainInstalls, installsAfterFirst, 'a same-mode terrain switch is a no-op');
  } finally {
    restore();
  }
});

test('keyless terrain: a failed Re:Earth fetch falls back to flat ellipsoid and stays cached', async () => {
  let fromUrlCalls = 0;
  const restore = stubCesiumStatics({
    'CesiumTerrainProvider.fromUrl': async () => {
      fromUrlCalls += 1;
      throw new Error('layer.json unreachable');
    },
  });
  const warnings = [];
  const originalWarn = console.warn;
  console.warn = (...args) => warnings.push(args.join(' '));
  try {
    const controller = keylessController({ tileset: { show: true } });
    const viewer = controller.viewer;
    await controller.setStack('osm');
    assert.equal(viewer.ops.terrainInstalls, 1, 'the fallback provider is still installed');
    assert.ok(viewer.terrainProvider instanceof Cesium.EllipsoidTerrainProvider, 'the fallback is the flat ellipsoid');
    assert.equal(controller._terrainMode, 'keyless');
    assert.match(warnings.join('\n'), /Re:Earth terrain unavailable/);
    // The fallback is cached — a later switch does not re-attempt the fetch.
    await controller.setStack('photoreal');
    await controller.setStack('osm');
    assert.equal(fromUrlCalls, 1, 'the flat fallback is cached like a success');
  } finally {
    console.warn = originalWarn;
    restore();
  }
});

test('setStack back to photoreal: imagery removed, tileset restored, terrain untouched', async () => {
  const terrainProvider = { id: 'reearth' };
  const restore = stubCesiumStatics({
    'CesiumTerrainProvider.fromUrl': async () => terrainProvider,
  });
  try {
    const controller = keylessController({ tileset: { show: false } });
    const viewer = controller.viewer;
    await controller.setStack('osm');
    const installsAfterOsm = viewer.ops.terrainInstalls;
    const layer = viewer.ops.added[0].layer;
    const state = await controller.setStack('photoreal');
    assert.equal(state.status, 'ready');
    assert.equal(state.activeId, 'photoreal');
    assert.equal(viewer.ops.removed.length, 1, 'the imagery layer is removed');
    assert.equal(viewer.ops.removed[0].layer, layer);
    assert.equal(viewer.ops.removed[0].destroy, false, 'the provider stays cached for the next switch');
    assert.equal(controller._imageryLayer, null);
    assert.equal(controller.googleTileset.show, true);
    assert.equal(viewer.scene.globe.show, false);
    assert.equal(viewer.ops.terrainInstalls, installsAfterOsm, 'terrain is untouched on photoreal');
    assert.equal(controller._terrainMode, 'keyless', 'the terrain mode survives the round trip');
    // And returning to OSM re-uses the cached provider + already-correct terrain.
    await controller.setStack('osm');
    assert.equal(viewer.ops.terrainInstalls, installsAfterOsm);
  } finally {
    restore();
  }
});

test('M7: a slow ion switch resolving after a newer one must not commit or restomp imagery', async () => {
  let resolveBing;
  const restore = stubCesiumStatics({
    'IonImageryProvider.fromAssetId': () => new Promise((resolve) => { resolveBing = resolve; }),
    'CesiumTerrainProvider.fromUrl': async () => ({ id: 'reearth' }),
  });
  try {
    const controller = new MapStackController(fakeViewer(), {
      googleTileset: { show: true }, cesiumToken: 'tok',
    });
    const viewer = controller.viewer;
    const slow = controller.setStack('bing-aerial'); // starts, stalls on the provider
    await Promise.resolve();
    assert.equal(controller._isSwitching, true);
    const fastState = await controller.setStack('osm'); // wins the globe
    assert.equal(fastState.activeId, 'osm');
    const installedLayer = viewer.ops.added[0].layer;
    const removesBeforeStaleCommit = viewer.ops.removed.length;
    resolveBing(fakeProvider());
    const staleState = await slow;
    // The stale switch returns the CURRENT state and commits nothing.
    assert.equal(staleState.activeId, 'osm');
    assert.equal(viewer.ops.removed.length, removesBeforeStaleCommit, 'the stale switch must not remove the winner imagery');
    assert.equal(viewer.ops.added.length, 1);
    assert.equal(viewer.ops.added[0].layer, installedLayer);
    assert.equal(controller._isSwitching, false, 'only the latest switch owns the flag');
    assert.equal(controller.getActiveId(), 'osm');
  } finally {
    restore();
  }
});

test('a failed provider creation rolls back to photoreal and reports through onError', async () => {
  const errors = [];
  const restore = stubCesiumStatics({
    'IonImageryProvider.fromAssetId': async () => { throw new Error('ion exploded'); },
  });
  try {
    const controller = new MapStackController(fakeViewer(), {
      googleTileset: { show: false }, cesiumToken: 'tok',
      onError: (message) => errors.push(message),
    });
    const events = changeEvents(controller);
    const viewer = controller.viewer;
    const state = await controller.setStack('bing-aerial');
    assert.match(errors.join('|'), /ion exploded/);
    assert.equal(state.activeId, 'photoreal', 'the boot stack is restored');
    assert.equal(state.lastError, 'ion exploded');
    assert.equal(controller.googleTileset.show, true, 'the tileset is re-shown');
    assert.equal(viewer.scene.globe.show, false);
    assert.deepEqual(events, ['switching', 'error'], 'no ready is emitted for a failed switch');
    assert.equal(controller._isSwitching, false);
  } finally {
    restore();
  }
});

test('ion regime: world terrain installs once and each Bing style maps to its own cached provider', async () => {
  const worldTerrain = { id: 'world' };
  const fromAssetIdCalls = [];
  const restore = stubCesiumStatics({
    'IonImageryProvider.fromAssetId': async (style) => {
      fromAssetIdCalls.push(style);
      return fakeProvider();
    },
    'Terrain.fromWorldTerrain': (options) => ({ ...options, source: worldTerrain }),
  });
  try {
    const controller = new MapStackController(fakeViewer(), {
      googleTileset: { show: true }, cesiumToken: 'tok',
    });
    const viewer = controller.viewer;
    await controller.setStack('bing-aerial');
    // World terrain is installed through scene.setTerrain, exactly once.
    assert.equal(viewer.ops.setTerrain.length, 1);
    assert.equal(viewer.ops.setTerrain[0].source, worldTerrain);
    assert.equal(viewer.ops.setTerrain[0].requestVertexNormals, true);
    assert.equal(controller._terrainMode, 'world');
    assert.equal(controller.getState().hasCesiumIonToken, true);
    // Style threading: AERIAL went through fromAssetId, un-cached.
    assert.deepEqual(fromAssetIdCalls, [Cesium.IonWorldImageryStyle.AERIAL]);
    // A second ion stack in the same terrain mode must not reinstall terrain,
    // and its own style gets its own provider.
    await controller.setStack('bing-labels');
    assert.equal(viewer.ops.setTerrain.length, 1, 'same-mode terrain switch is a no-op');
    assert.deepEqual(fromAssetIdCalls, [
      Cesium.IonWorldImageryStyle.AERIAL,
      Cesium.IonWorldImageryStyle.AERIAL_WITH_LABELS,
    ]);
    // Returning to the first Bing stack reuses its cached provider.
    const aerialProvider = controller._imageryProviders.get('bing-aerial');
    await controller.setStack('bing-aerial');
    assert.equal(fromAssetIdCalls.length, 2, 'the aerial provider is cached');
    assert.equal(viewer.ops.added.at(-1).layer._imageryProvider, aerialProvider);
  } finally {
    restore();
  }
});

test('silent switches commit the same state without emitting change events', async () => {
  const restore = stubCesiumStatics({
    'CesiumTerrainProvider.fromUrl': async () => ({ id: 'reearth' }),
  });
  try {
    const controller = keylessController({ tileset: { show: true } });
    const events = changeEvents(controller);
    const state = await controller.setStack('osm', { silent: true });
    assert.equal(state.status, 'ready');
    assert.equal(state.activeId, 'osm');
    assert.deepEqual(events, [], 'silent mode suppresses switching/ready broadcasts');
  } finally {
    restore();
  }
});

test('an unsupported stack kind throws into the rollback path, never a raw crash', async () => {
  const controller = keylessController({ tileset: { show: true }, onError: () => {} });
  await assert.rejects(
    controller._getImageryProvider({ id: 'alien', kind: 'holodeck' }),
    /Unsupported map stack: alien/,
  );
});
