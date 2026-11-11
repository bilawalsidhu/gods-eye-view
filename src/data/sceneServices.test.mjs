import { createDroneAirspaceLayer } from '../layers/droneAirspace/index.js';
import { overlayHost } from '../app/layers/overlayHost.js';
import assert from 'node:assert/strict';
import test from 'node:test';
import { GROUND_HARNESSES } from '../testSupport/groundDisplayEngines.mjs';
import { createSceneServices, sceneServicesFor } from './sceneServices.js';
import { pickRegistryFor } from './pickRegistry.js';
import { selectionDispatcherFor } from './selectionDispatcher.js';
import { createAlprCamerasLayer } from '../layers/alpr/index.js';
import * as picking from './pickRegistry.js';

for (const makeHarness of GROUND_HARNESSES) {
  test(`${makeHarness.name}: an enabled ALPR layer transfers pick ownership on reattachment`, (t) => {
    const first = makeHarness();
    const second = makeHarness();
    const a = createSceneServices(first.engine);
    const b = createSceneServices(second.engine);
    const noop = () => {};
    const layer = createAlprCamerasLayer({
      source: { fetch: () => assert.fail('Reattachment must not fetch') },
      services: { picking, render: { governorRequestRender: noop } },
      rendererFactory({ state }) {
        state.recordById.set('camera', {});
        return {
          init: noop,
          setVisible: noop,
          renderRecords: noop,
          hideOnMapCredit: noop,
          clearSelection: noop,
          clearRendered: noop,
          destroy: noop,
        };
      },
    });
    t.after(() => {
      layer.destroy();
      a.destroy();
      b.destroy();
      first.destroy();
      second.destroy();
    });
    layer.init(null, { engine: first.engine });
    layer.enable();
    assert.equal(a.picking.findPickOwner('camera'), 'alpr-cameras');
    assert.equal(b.picking.findPickOwner('camera'), null);
    layer.detachRenderer();
    assert.equal(a.picking.findPickOwner('camera'), null);
    layer.attachRenderer({ engine: second.engine });
    assert.equal(b.picking.findPickOwner('camera'), 'alpr-cameras');
    layer.disable();
    assert.equal(b.picking.findPickOwner('camera'), null);
  });

  test(`${makeHarness.name}: simultaneous scenes isolate ownership and clicks`, (t) => {
    const first = makeHarness();
    const second = makeHarness();
    const scenes = [first, second].map(({ engine }) => ({
      engine,
      services: createSceneServices(engine, { keyTarget: new EventTarget() }),
    }));
    t.after(() => {
      for (const scene of scenes) scene.services.destroy();
      first.destroy();
      second.destroy();
    });
    const calls = [[], []];
    scenes.forEach(({ engine, services }, i) => {
      assert.equal(pickRegistryFor(engine), services.picking);
      assert.equal(selectionDispatcherFor(engine), services.selection);
      services.selection.register('flights', {
        owns: (id) => id === `flight-${i}`,
        onSelect: (id) => calls[i].push(id),
        onEmptyClick: () => calls[i].push('empty'),
      });
    });
    const [a, b] = scenes.map((scene) => scene.services);
    assert.equal(a.picking.findPickOwner('flight-0'), 'flights');
    assert.equal(b.picking.findPickOwner('flight-0'), null);
    a.picking.registerPickOwner('cctv', (id) => id === 'camera');
    assert.equal(a.picking.isOwnedByOtherLayer('flights', 'camera'), true);
    assert.equal(b.picking.isOwnedByOtherLayer('flights', 'camera'), false);
    first.click({ id: 'flight-0' });
    second.click({ id: 'flight-1' });
    first.click({ id: 'camera' });
    second.click({ id: 'camera' });
    assert.deepEqual(calls, [['flight-0'], ['flight-1', 'empty']]);
    a.picking.unregisterPickOwner('flights');
    assert.equal(b.picking.findPickOwner('flight-1'), 'flights');
  });

  test(`${makeHarness.name}: scene teardown and parked reattachment leave siblings live`, (t) => {
    const first = makeHarness();
    const second = makeHarness();
    const keys = [new EventTarget(), new EventTarget()];
    const a = createSceneServices(first.engine, { keyTarget: keys[0] });
    const b = createSceneServices(second.engine, { keyTarget: keys[1] });
    let next;
    t.after(() => {
      a.destroy();
      b.destroy();
      next?.destroy();
      first.destroy();
      second.destroy();
    });
    const calls = [];
    const owner = (name) => ({
      owns: (id) => id === 'shared-id',
      onSelect: () => calls.push(name),
      onEscape: () => calls.push(`${name}-escape`),
    });
    const lateRemove = a.selection.register('flights', owner('first'));
    b.selection.register('flights', owner('second'));
    assert.equal(first.listeners(), 4);
    assert.equal(second.listeners(), 4);
    a.destroy();
    a.destroy();
    assert.equal(first.listeners(), 0);
    assert.equal(second.listeners(), 4);
    assert.equal(sceneServicesFor(first.engine), a);
    a.picking.registerPickOwner('late', () => true);
    a.selection.register('late', owner('late'));
    assert.equal(a.picking.findPickOwner('shared-id'), null);
    first.click({ id: 'shared-id' });
    second.click({ id: 'shared-id' });
    for (const target of keys)
      target.dispatchEvent(
        Object.assign(new Event('keydown'), { key: 'Escape' }),
      );
    assert.deepEqual(calls, ['second', 'second-escape']);
    next = createSceneServices(first.engine, { keyTarget: keys[0] });
    next.selection.register('flights', owner('next'));
    lateRemove();
    a.destroy();
    assert.equal(next.picking.findPickOwner('shared-id'), 'flights');
    first.click({ id: 'shared-id' });
    assert.deepEqual(calls, ['second', 'second-escape', 'next']);
    assert.equal(b.picking.findPickOwner('shared-id'), 'flights');
  });
}

for (const makeHarness of GROUND_HARNESSES) {
  test(`${makeHarness.name}: a retained selected airspace card moves between overlay services`, async (t) => {
    const first = makeHarness();
    const second = makeHarness();
    const a = createSceneServices(first.engine);
    const b = createSceneServices(second.engine);
    let requests = 0;
    const ring = [
      [-77.04, 38.89],
      [-77.03, 38.89],
      [-77.03, 38.9],
      [-77.04, 38.89],
    ];
    const layer = createDroneAirspaceLayer({
      source: {
        async getSnapshot() {
          requests++;
          return [
            {
              stableId: '310',
              name: 'P-56',
              typeCode: 'P',
              type: 'Prohibited',
              polygons: [[ring]],
            },
          ];
        },
      },
      overlayHost,
      picking,
      pointer: { isPointerFree: () => true },
    });
    t.after(() => {
      layer.destroy();
      a.destroy();
      b.destroy();
      first.destroy();
      second.destroy();
    });
    layer.init(null, { engine: first.engine });
    layer.enable();
    await layer.update();
    first.click({ id: 'drone-airspace:310:0' });
    assert.equal(a.overlay.getDiagnostics().entryCount, 1);
    assert.equal(b.overlay.getDiagnostics().entryCount, 0);
    layer.detachRenderer();
    assert.equal(a.overlay.getDiagnostics().entryCount, 0);
    layer.attachRenderer({ engine: second.engine });
    assert.equal(requests, 1);
    assert.equal(b.overlay.getDiagnostics().entryCount, 1);
    a.destroy();
    assert.equal(b.overlay.getDiagnostics().entryCount, 1);
    layer.disable();
    assert.equal(b.overlay.getDiagnostics().entryCount, 0);
  });
}
