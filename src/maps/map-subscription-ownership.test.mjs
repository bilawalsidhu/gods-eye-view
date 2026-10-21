import test from 'node:test';
import assert from 'node:assert/strict';
import { MapSourceController } from './controller.js';
function fixture() {
  return new MapSourceController(
    {
      scene: {
        globe: { show: true },
        requestRender() {},
        frameState: {
          creditDisplay: { addStaticCredit() {}, removeStaticCredit() {} },
        },
        primitives: { add() {}, remove() {} },
      },
      imageryLayers: { add() {}, remove() {} },
    },
    {
      registry: {
        defaultId: 'fixture',
        sources: [
          {
            descriptor: { id: 'fixture', label: 'Fixture', kind: 'imagery' },
            imagery: async () => ({}),
          },
        ],
      },
      createImageryLayer: (provider) => ({ provider }),
    },
  );
}
test('an unsubscribed owner is skipped in the same map settlement delivery', async () => {
  const controller = fixture();
  const calls = [];
  let detach;
  controller.subscribe(() => {
    calls.push('first');
    detach();
  });
  detach = controller.subscribe(() => calls.push('detached'));
  controller.subscribe(() => calls.push('last'));
  await controller.setStack('fixture');
  assert.deepEqual(calls, ['first', 'last']);
  controller.destroy();
});
test('destroying the controller during delivery stops remaining listeners', async () => {
  const controller = fixture();
  const calls = [];
  controller.subscribe(() => {
    calls.push('destroy');
    controller.destroy();
  });
  controller.subscribe(() => calls.push('detached'));
  await controller.setStack('fixture');
  assert.deepEqual(calls, ['destroy']);
});

test('a listener re-added after destroy during delivery is not called', async () => {
  const controller = fixture();
  const calls = [];
  const later = () => calls.push('later');
  controller.subscribe(() => {
    calls.push('destroy');
    controller.destroy();
    controller.subscribe(later);
  });
  controller.subscribe(later);
  await controller.setStack('fixture');
  assert.deepEqual(calls, ['destroy']);
});

test('delivery order: added during delivery waits, duplicates run once, re-added runs', async () => {
  const controller = fixture();
  const calls = [];
  const twice = () => calls.push('twice');
  const readded = () => calls.push('readded');
  let offReadded;
  controller.subscribe(() => {
    calls.push('first');
    controller.subscribe(() => calls.push('added-late'));
    offReadded();
    controller.subscribe(readded);
  });
  controller.subscribe(twice);
  controller.subscribe(twice);
  offReadded = controller.subscribe(readded);
  await controller.setStack('fixture');
  assert.deepEqual(calls, ['first', 'twice', 'readded']);
  controller.destroy();
});
