import test from 'node:test';
import assert from 'node:assert/strict';
import { MapStackController } from '../mapStackController.js';
import { createFakeEngine } from '../globe/testing/fakeEngine.js';
import { createSceneServices } from '../data/sceneServices.js';

test('destroy invalidates a pending imagery provider before it can touch the viewer', async () => {
  let resolveProvider;
  let removed = 0;
  const changes = [];
  const controller = new MapStackController({
    engine: createFakeEngine({ kind: 'cesium' }),
    onChange: (state) => changes.push(state.status),
  });
  controller._getImageryProvider = () =>
    new Promise((resolve) => {
      resolveProvider = resolve;
    });
  controller._removeImageryErrorListener = () => {
    removed++;
  };
  const switching = controller.setStack('osm');
  controller.destroy();
  resolveProvider({ provider: {} });
  await switching;
  assert.equal(removed, 1);
  assert.deepEqual(changes, ['switching']);
  await controller.setStack('osm');
  controller.destroy();
  assert.equal(removed, 1);
});

test('scene teardown makes its later render requests inactive', () => {
  const engine = createFakeEngine();
  const services = createSceneServices(engine);
  const governor = services.render;
  governor.install();
  governor.holdContinuousRender('fixture');
  assert.equal(governor.getRenderGovernorDiagnostics().installed, true);
  services.destroy();
  engine.fake.resetCalls();
  governor.governorRequestRender('late');
  assert.equal(engine.fake.callsOf('render.request').length, 0);
  assert.equal(governor.getRenderGovernorDiagnostics().installed, false);
  assert.deepEqual(governor.getRenderGovernorDiagnostics().holds, []);
  engine.destroy();
});
