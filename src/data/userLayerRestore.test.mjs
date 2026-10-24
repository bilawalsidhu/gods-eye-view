/**
 * A user layer's enabled state has to reach the layer, not just the codec.
 *
 * userLayerState.test.mjs proves `ul` round-trips through the state object.
 * These drive the real DataLayerManager through LayerStateCoordinator, from a
 * share link and from local storage, and check what actually got switched on.
 */
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import { DataLayerManager } from './manager.js';
import {
  LAYER_STATE_REGISTRY,
  LAYER_STATE_STORAGE_KEY,
  REGISTERED_LAYER_IDS,
  createDefaultLayerState,
  decodeLayerStateParams,
  registerUserLayers,
  resetUserLayersForTest,
  serializeStoredLayerState,
  userLayerMetadata,
} from './layerState.js';
import { LayerStateCoordinator } from './layerStateCoordinator.js';

function stubLayer(id, calls) {
  return {
    id,
    name: id,
    icon: '',
    source: 'test',
    async init() {
      return true;
    },
    async enable() {
      calls.push(['enable', id]);
      return true;
    },
    async update() {
      return true;
    },
    async disable() {
      return true;
    },
  };
}

function managerWithUserLayer(userLayerId, calls) {
  registerUserLayers([
    { id: userLayerId, createLayer: () => stubLayer(userLayerId, calls) },
  ]);
  const manager = new DataLayerManager({});
  for (const id of REGISTERED_LAYER_IDS) manager.register(stubLayer(id, calls));
  manager.register(stubLayer(userLayerId, calls));
  manager.finalizeRegistrations([
    ...LAYER_STATE_REGISTRY,
    ...userLayerMetadata(),
  ]);
  return manager;
}

function memoryStorage(initial = null) {
  const values = new Map();
  if (initial !== null) values.set(LAYER_STATE_STORAGE_KEY, initial);
  return {
    getItem: (key) => (values.has(key) ? values.get(key) : null),
    setItem: (key, value) => values.set(key, value),
  };
}

const shareSink = () => ({
  setLayerStateProvider() {},
  onLayerStateChange() {},
});

beforeEach(() => resetUserLayersForTest());

test('a user layer named in a share link is switched on', async () => {
  const calls = [];
  const manager = managerWithUserLayer('boilers', calls);
  const shareLayerState = decodeLayerStateParams(
    new URLSearchParams('v=2&l=&ul=boilers'),
  );
  assert.deepEqual(shareLayerState.enabledLayerIds, ['boilers']);

  const coordinator = new LayerStateCoordinator(manager, shareSink(), {
    storage: memoryStorage(),
  });
  const results = await coordinator.start({ shareLayerState });

  assert.equal(manager.isEffectivelyEnabled('boilers'), true);
  assert.deepEqual(
    calls.filter(([kind]) => kind === 'enable').map(([, id]) => id),
    ['boilers'],
  );
  const restored = results.find((result) => result.layerId === 'boilers');
  assert.ok(restored, 'the restore results report the user layer');
  assert.equal(restored.succeeded, true);
  coordinator.destroy();
});

test('a user layer saved in local storage is switched on after reload', async () => {
  const calls = [];
  const manager = managerWithUserLayer('boilers', calls);
  const saved = createDefaultLayerState();
  saved.enabledLayerIds = ['boilers'];

  const coordinator = new LayerStateCoordinator(manager, shareSink(), {
    storage: memoryStorage(serializeStoredLayerState(saved)),
  });
  await coordinator.start();

  assert.equal(coordinator.source, 'local');
  assert.equal(manager.isEffectivelyEnabled('boilers'), true);
  coordinator.destroy();
});

test('a registered user layer that the restored state leaves off stays off', async () => {
  const calls = [];
  const manager = managerWithUserLayer('boilers', calls);
  const shareLayerState = decodeLayerStateParams(
    new URLSearchParams('v=2&l=c'),
  );

  const coordinator = new LayerStateCoordinator(manager, shareSink(), {
    storage: memoryStorage(),
  });
  const results = await coordinator.start({ shareLayerState });

  assert.equal(manager.isEffectivelyEnabled('boilers'), false);
  assert.equal(manager.isEffectivelyEnabled('cctv'), true);
  const restored = results.find((result) => result.layerId === 'boilers');
  assert.equal(restored?.targetEnabled, false);
  coordinator.destroy();
});
