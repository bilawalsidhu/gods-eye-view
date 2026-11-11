import { createSessionHandoff } from '../app/sessionHandoff.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { DataLayerManager } from './manager.js';
import { LAYER_STATE_REGISTRY, REGISTERED_LAYER_IDS } from './layerState.js';
import { LayerStateCoordinator } from './layerStateCoordinator.js';

let windParamWrites = 0;
function layer(id) {
  let params =
    id === 'wind'
      ? { model: 'gfs', overlay: 'none', units: 'km/h', paused: false }
      : null;
  return {
    id,
    name: id,
    icon: '',
    source: 'test',
    async init() {
      return true;
    },
    async enable() {
      return true;
    },
    async update() {
      return true;
    },
    async disable() {
      return true;
    },
    attachRenderer() {},
    ...(params
      ? {
          setParams(next = {}) {
            windParamWrites++;
            params = { ...params, ...next };
            return true;
          },
          getParams() {
            return { ...params };
          },
        }
      : {}),
  };
}
function manager() {
  const m = new DataLayerManager({});
  for (const id of REGISTERED_LAYER_IDS) m.register(layer(id));
  m.finalizeRegistrations(LAYER_STATE_REGISTRY);
  return m;
}
const storage = () => {
  const v = new Map();
  return { getItem: (k) => v.get(k) ?? null, setItem: (k, x) => v.set(k, x) };
};
const sink = () => ({ setLayerStateProvider() {}, onLayerStateChange() {} });
const cesiumEntry = {
  enabledLayerIds: ['wind'],
  options: { wind: { model: 'gfs' } },
};

test('same-engine Back to a gfs entry restores gfs (reference)', async () => {
  const m = manager();
  const c = new LayerStateCoordinator(m, sink(), { storage: storage() });
  await m.setEnabled('wind', true, { origin: 'user' });
  m.setLayerParams('wind', { model: 'ifs' }, { origin: 'user' });
  assert.equal(m.getLayerParams('wind').model, 'ifs');
  await c.applyShareLayerState({ shareLayerState: cesiumEntry });
  assert.equal(m.getLayerParams('wind').model, 'gfs');
});

const handoffOf = (manager, visit = false) =>
  createSessionHandoff({ manager, director: null }, { addressLayerIds: ['wind'], visit });

test('cross-engine Back to a gfs entry restores gfs', async () => {
  const m = manager();
  await m.setEnabled('wind', true, { origin: 'user' });
  m.setLayerParams('wind', { model: 'ifs' }, { origin: 'user' });
  const handoff = handoffOf(m, true);
  const c = new LayerStateCoordinator(m, sink(), { storage: storage() });
  await c.start({ shareLayerState: cesiumEntry, handoff });
  assert.equal(c.getDurableState().options.wind.model, 'gfs');
  assert.equal(
    m.getLayerParams('wind').model,
    'gfs',
    'live wind should follow the visited entry',
  );
});

test('a picked engine keeps the live layer options, not the address', async () => {
  const m = manager();
  await m.setEnabled('wind', true, { origin: 'user' });
  m.setLayerParams('wind', { model: 'ifs' }, { origin: 'user' });
  const writes = windParamWrites;
  const c = new LayerStateCoordinator(m, sink(), { storage: storage() });
  await c.start({ shareLayerState: cesiumEntry, handoff: handoffOf(m) });
  assert.equal(windParamWrites, writes, 'a pick writes no params');
  assert.equal(m.getLayerParams('wind').model, 'ifs');
});

test('an engine switch leaves a retained layer whose options match alone', async () => {
  const m = manager();
  await m.setEnabled('wind', true, { origin: 'user' });
  m.setLayerParams('wind', { model: 'gfs' }, { origin: 'user' });
  const writes = windParamWrites;
  const c = new LayerStateCoordinator(m, sink(), { storage: storage() });
  const results = await c.start({
    shareLayerState: cesiumEntry,
    handoff: handoffOf(m),
  });
  assert.equal(windParamWrites, writes, 'no params write for equal options');
  const wind = results.find((result) => result.layerId === 'wind');
  assert.equal(wind.phase, 'retained');
  assert.equal(wind.succeeded, true);
  assert.deepEqual(wind.appliedOptions, {});
});
