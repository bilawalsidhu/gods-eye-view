// The Space Missions panel's wiring, apart from Context.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createPinia, setActivePinia } from 'pinia';
import { useSpaceMissionsStore } from './stores/spaceMissions.js';
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

function managerDouble() {
  const listeners = new Set();
  const enabled = new Set();
  return {
    listeners,
    enabled,
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
  };
}

function rig({ cockpit = false } = {}) {
  setActivePinia(createPinia());
  const store = useSpaceMissionsStore();
  const layer = layerDouble();
  const manager = managerDouble();
  const reveals = [];
  const sheets = [];
  const state = { cockpit };
  const controls = new SpaceMissionsControls({
    layer,
    store,
    actions: {
      setPanelCollapsed: (...args) => reveals.push(args),
      isCockpitActive: () => state.cockpit,
      revealPanel: () => sheets.push('space-missions-panel'),
    },
  });
  controls.connect(manager);
  return { controls, store, layer, manager, reveals, sheets, state };
}

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

test('a person switching the layer on opens its panel; a restore does not', () => {
  const r = rig();
  r.manager.emit({ ...userOn, origin: 'share-restore' });
  r.manager.emit({ ...userOn, type: 'visibility-requested' });
  assert.deepEqual(r.reveals, []);
  r.manager.emit(userOn);
  assert.deepEqual(r.reveals, [
    ['space-missions-panel', false, { explicit: true }],
  ]);
  // On a phone the rail shows only as tab sheets: the Missions sheet opens too.
  assert.deepEqual(r.sheets, ['space-missions-panel']);
});

test('a mission picked on the globe opens the panel', () => {
  const r = rig();
  r.layer.pick('L1');
  assert.deepEqual(r.reveals, [
    ['space-missions-panel', false, { explicit: true }],
  ]);
  assert.deepEqual(r.sheets, ['space-missions-panel']);
});

test('the Cockpit keeps the screen: no reveal while it is on', () => {
  const r = rig({ cockpit: true });
  r.layer.pick('L1');
  r.manager.emit(userOn);
  r.manager.emit({ ...userOn, origin: 'voice' });
  assert.deepEqual(r.reveals, []);
  assert.deepEqual(r.sheets, [], 'no phone sheet over the Cockpit either');
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
