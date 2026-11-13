import test from 'node:test';
import assert from 'node:assert/strict';
import { LayerLifecycle } from './lifecycle.js';

const layer = (id) => ({
  id,
  name: id,
  icon: '',
  source: 'test',
  async init() {},
  async enable() {},
  async update() {},
  async disable() {},
  async destroy() {},
  getStats: () => ({ count: 0, lastUpdate: null }),
});

test('library layers register only after sealing and only in the lib- namespace', async () => {
  const manager = new LayerLifecycle({});
  const activity = [];
  manager.subscribeActivity((change) => activity.push(change.type));
  manager.register(layer('earthquakes'));
  assert.throws(
    () => manager.registerLibraryLayer(layer('lib-night-lights')),
    /after the catalog is sealed/,
  );
  manager.finalizeRegistrations([
    { id: 'earthquakes', disposition: 'enabled-only' },
  ]);
  assert.throws(
    () => manager.registerLibraryLayer(layer('radio')),
    /lib- namespace/,
  );
  assert.throws(() => manager.register(layer('lib-x-y-z')), /finalized/);
  manager.registerLibraryLayer(layer('lib-night-lights'));
  assert.equal(manager.isLibraryLayer('lib-night-lights'), true);
  assert.equal(manager.isLibraryLayer('earthquakes'), false);
  const rows = manager.getAll();
  assert.equal(
    rows.find(({ id }) => id === 'earthquakes').libraryEntryId,
    null,
  );
  assert.equal(
    rows.find(({ id }) => id === 'lib-night-lights').libraryEntryId,
    'night-lights',
  );
  assert.equal(await manager.unregisterLibraryLayer('earthquakes'), false);
  assert.equal(manager.layers.has('earthquakes'), true);
  await manager.setEnabled('lib-night-lights', true, { origin: 'user' });
  assert.equal(await manager.unregisterLibraryLayer('lib-night-lights'), true);
  assert.equal(manager.layers.has('lib-night-lights'), false);
  assert.equal(manager.isLibraryLayer('lib-night-lights'), false);
  assert.equal(activity.filter((type) => type === 'registrations').length, 2);
});
