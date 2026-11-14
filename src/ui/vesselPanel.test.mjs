import test from 'node:test';
import assert from 'node:assert/strict';
import { createVesselPanel } from './vesselPanel.js';
import { normalizeVesselFilters } from '../data/vesselDisplayFilters.js';
import { createOwners } from './stores/owners.js';

test('vessel panel hides with its feed, preserves preferences and stops timers when closed/hidden', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const owners = createOwners(),
    store = {
      visible: false,
      search: '',
      connect: owners.connect,
      detach: owners.detach,
    };
  const id = 'ais-live-vessels',
    subscribers = new Set(),
    callbacks = {},
    memory = new Map();
  let enabled = false,
    reads = 0,
    opened = 0,
    selected = null,
    filters = normalizeVesselFilters();
  const doc = {
    hidden: false,
    addEventListener: (name, fn) => (callbacks[name] = fn),
    removeEventListener: (name) => delete callbacks[name],
  };
  const layer = {
    getParams: () => ({ displayFilters: filters }),
    getVesselList: () => {
      reads++;
      return { rows: [], matching: 120, total: 120, page: 0, pages: 3 };
    },
    attachVesselPanel: (fn) => (callbacks.open = fn),
    selectById: (target) => (selected = target),
  };
  const notify = (change) => {
    for (const fn of subscribers) fn({ layerId: id, ...change });
  };
  const manager = {
    layers: new Map([[id, { module: layer }]]),
    isEnabled: () => enabled,
    subscribe(fn) {
      subscribers.add(fn);
      return () => subscribers.delete(fn);
    },
    setLayerParams(layerId, params) {
      assert.equal(layerId, id);
      filters = normalizeVesselFilters(params.displayFilters, filters);
      notify({ type: 'params', requestedParams: params });
    },
  };
  const storage = {
    getItem: (key) => memory.get(key),
    setItem: (key, value) => memory.set(key, value),
  };
  const panel = createVesselPanel({
    store,
    doc,
    storage,
    reveal: () => opened++,
  });
  panel.connect(manager);
  assert.equal(store.available, false);
  const initial = reads;
  t.mock.timers.tick(10000);
  assert.equal(reads, initial);
  enabled = true;
  notify({ type: 'visibility' });
  assert.equal(store.available, true);
  callbacks.open();
  assert.equal(opened, 1);
  store.visible = true;
  owners.act('visibility');
  t.mock.timers.tick(1000);
  assert.ok(reads > initial);
  owners.act('filter', { underwayOnly: true });
  assert.equal(filters.underwayOnly, true);
  assert.equal(JSON.parse([...memory.values()][0])[id].underwayOnly, true);
  owners.act('select', '123');
  assert.equal(selected, '123');
  enabled = false;
  notify({ type: 'visibility' });
  assert.equal(store.available, false);
  let before = reads;
  t.mock.timers.tick(10000);
  assert.equal(reads, before);
  selected = null;
  owners.act('select', '456');
  assert.equal(selected, null);
  store.visible = false;
  enabled = true;
  notify({ type: 'visibility' });
  assert.equal(store.available, true);
  assert.equal(filters.underwayOnly, true);
  panel.connect(manager);
  assert.equal(
    store.filters.underwayOnly,
    true,
    'saved preferences restore on reconnect',
  );
  store.visible = true;
  owners.act('visibility');
  doc.hidden = true;
  callbacks.visibilitychange();
  before = reads;
  t.mock.timers.tick(10000);
  assert.equal(reads, before);
  panel.destroy();
  assert.equal(subscribers.size, 0);
  assert.equal(callbacks.open, null);
  assert.equal(callbacks.visibilitychange, undefined);
});
