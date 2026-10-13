import test from 'node:test';
import assert from 'node:assert/strict';
import { LayerLifecycle } from './lifecycle.js';

test('hidden automatic polls stop; explicit refresh and one catch-up on return remain available', async (t) => {
  t.mock.timers.enable({ apis: ['setInterval'] });
  const manager = new LayerLifecycle({});
  let updates = 0;
  manager.register({
    id: 'power-fixture',
    name: 'Fixture',
    updateInterval: 1000,
    init() {},
    enable() {},
    disable() {},
    async update() {
      updates++;
    },
    getStats: () => ({ count: 0 }),
  });
  await manager.setEnabled('power-fixture', true);
  const initial = updates;
  manager.setPollingSuspended(true);
  t.mock.timers.tick(5000);
  assert.equal(updates, initial);
  await manager.refreshLayer('power-fixture');
  assert.equal(updates, initial + 1);
  manager.setPollingSuspended(false);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(updates, initial + 2);
  manager.setPollingSuspended(false);
  assert.equal(
    updates,
    initial + 2,
    'unchanged visibility does not acquire again',
  );
  manager.setPollingSuspended(true);
  await manager.setEnabled('power-fixture', false);
  manager.setPollingSuspended(false);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(updates, initial + 2, 'disabled layers stay disabled on return');
  await manager.destroyAll();
});
