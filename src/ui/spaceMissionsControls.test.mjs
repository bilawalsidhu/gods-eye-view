// The Space Missions layer's wiring to its list, apart from Context.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createPinia, setActivePinia } from 'pinia';
import { useSpaceMissionsStore } from './stores/spaceMissions.js';
import { useContextStore } from './stores/context.js';
import { applicationPinia } from './vueRuntime.js';
import { SpaceMissionsControls } from './spaceMissionsControls.js';

function layerDouble() {
  const panelListeners = new Set();
  const pickListeners = new Set();
  return {
    panelListeners,
    pickListeners,
    subscribePanel(listener) {
      panelListeners.add(listener);
      return () => panelListeners.delete(listener);
    },
    subscribeGlobePick(listener) {
      pickListeners.add(listener);
      return () => pickListeners.delete(listener);
    },
    publish(view) {
      for (const listener of panelListeners) listener(view);
    },
    pick(id) {
      for (const listener of pickListeners) listener(id);
    },
  };
}

// A data manager whose layers change only as a test announces them. Every
// way to switch a layer, the manager's or a layer's own, records the call in
// `switched` and changes nothing, so a switch the controls make is caught.
const SWITCHES = ['setEnabled', 'enable', 'disable', 'toggle'];
function managerDouble(layerIds = []) {
  const listeners = new Set();
  const enabled = new Set();
  const switched = [];
  const recorder = (target, where) => {
    for (const name of SWITCHES)
      target[name] = (...args) => {
        switched.push([`${where}.${name}`, ...args]);
        return true;
      };
    return target;
  };
  const layers = new Map(
    ['rocket-launches', 'satellites', 'radio', ...layerIds].map((id) => [
      id,
      recorder({}, id),
    ]),
  );
  const manager = recorder(
    {
      listeners,
      enabled,
      switched,
      layers,
      isEnabled: (id) => enabled.has(id),
      subscribe(listener) {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
      emit(change) {
        if (change.type === 'visibility') {
          if (change.enabled) enabled.add(change.layerId);
          else enabled.delete(change.layerId);
        }
        for (const listener of listeners) listener(change);
      },
    },
    'manager',
  );
  return manager;
}

function rig({ cockpit = false, layers = [] } = {}) {
  setActivePinia(createPinia());
  const store = useSpaceMissionsStore();
  const layer = layerDouble();
  const manager = managerDouble(layers);
  const reveals = [];
  const state = { cockpit };
  const controls = new SpaceMissionsControls({
    layer,
    store,
    actions: {
      showMissions: ({ keepFollow }) => reveals.push(keepFollow),
      isCockpitActive: () => state.cockpit,
    },
  });
  controls.connect(manager);
  return { controls, store, layer, manager, reveals, state };
}

const settle = () => new Promise((resolve) => setImmediate(resolve));

const userOn = {
  type: 'visibility',
  layerId: 'rocket-launches',
  enabled: true,
  origin: 'user',
};

test('the layer publishes its roster and mission to its own store', () => {
  const r = rig();
  assert.equal(r.store.layer, r.layer);
  assert.equal(r.store.roster, null);
  const view = { roster: { entries: [] }, mission: { id: 'L1' } };
  r.layer.publish(view);
  assert.equal(r.store.roster, view.roster);
  assert.equal(r.store.mission, view.mission);
});

test('the panel shows while the layer is on', () => {
  const r = rig();
  assert.equal(r.store.enabled, false);
  r.manager.emit({ ...userOn, origin: 'programmatic' });
  assert.equal(r.store.enabled, true);
  r.manager.emit({ ...userOn, enabled: false });
  assert.equal(r.store.enabled, false);
  // Another layer's change says nothing about Space Missions.
  r.manager.enabled.add('rocket-launches');
  r.manager.emit({ ...userOn, layerId: 'satellites' });
  assert.equal(r.store.enabled, false);
});

test('a person switching the layer on shows its list in Context; a restore does not', () => {
  const r = rig();
  r.manager.emit({ ...userOn, origin: 'share-restore' });
  r.manager.emit({ ...userOn, type: 'visibility-requested' });
  assert.deepEqual(r.reveals, []);
  r.manager.emit(userOn);
  assert.deepEqual(r.reveals, [true]);
});

test('delayed Data Layers or generic voice activation leaves a newer tab in place', () => {
  for (const origin of ['user', 'voice']) {
    const r = rig();
    const context = useContextStore(applicationPinia());
    let request;
    r.manager.subscribeVisibilityRequests = (listener) => {
      request = listener;
      return () => {
        request = null;
      };
    };
    r.controls.connect(r.manager);
    try {
      const change = { ...userOn, origin, intentEpoch: 1 };
      request({ ...change, type: 'visibility-requested' });
      context.setInspectorTab('pinned');
      r.manager.emit(change);
      assert.equal(r.store.enabled, true);
      assert.deepEqual(r.reveals, []);
      const next = { ...change, intentEpoch: 2 };
      request({ ...next, type: 'visibility-requested' });
      r.manager.emit(next);
      assert.deepEqual(
        r.reveals,
        [true],
        'an undisturbed new request still reveals',
      );
    } finally {
      r.controls.destroy();
      context.setInspectorTab('inspect');
    }
    assert.equal(request, null);
  }
});

test('a mission picked on the globe shows the Missions list', () => {
  const r = rig();
  r.layer.pick('L1');
  assert.deepEqual(r.reveals, [false]);
});

test('the Cockpit keeps the screen: no reveal while it is on', () => {
  const r = rig({ cockpit: true });
  r.layer.pick('L1');
  r.manager.emit(userOn);
  r.manager.emit({ ...userOn, origin: 'voice' });
  assert.deepEqual(r.reveals, []);
  r.state.cockpit = false;
  r.layer.pick('L1');
  assert.equal(r.reveals.length, 1);
});

test('reconnecting and destroy release every subscription and clear the store', () => {
  const r = rig();
  r.controls.connect(r.manager);
  assert.equal(r.manager.listeners.size, 1, 'no duplicate subscription');
  r.layer.publish({ roster: { entries: [] }, mission: null });
  r.manager.emit(userOn);
  r.controls.destroy();
  assert.equal(r.manager.listeners.size, 0);
  assert.equal(r.layer.panelListeners.size, 0);
  assert.equal(r.layer.pickListeners.size, 0);
  assert.equal(r.store.layer, null);
  assert.equal(r.store.roster, null);
  assert.equal(r.store.enabled, false);
  r.layer.pick('L1');
  assert.equal(r.reveals.length, 1, 'a destroyed control reveals nothing');
});

// Space Missions is an ordinary layer: its wiring switches no other layer.
// (The layer's own Satellites dependency is tested with the layer.)
test('Space Missions on or off switches no other layer, and another layer on leaves it on', async () => {
  const r = rig({ layers: ['flights', 'cctv', 'earthquakes'] });
  const announce = (layerId, enabled, origin) =>
    r.manager.emit({ type: 'visibility', layerId, enabled, origin });

  announce('flights', true, 'user');
  announce('cctv', true, 'user');
  announce('rocket-launches', true, 'user');
  await settle();
  assert.deepEqual(r.reveals, [true]);
  assert.equal(r.store.enabled, true);

  announce('earthquakes', true, 'voice');
  await settle();
  assert.equal(r.store.enabled, true, 'Missions stays on');

  announce('rocket-launches', false, 'user');
  await settle();
  assert.equal(r.store.enabled, false);
  assert.deepEqual(
    r.manager.switched,
    [],
    'the controls switch no layer themselves',
  );
});
