import test from 'node:test';
import assert from 'node:assert/strict';
import { MapStackController } from '../mapStackController.js';
import {
  installRenderGovernor,
  uninstallRenderGovernor,
  holdContinuousRender,
  governorRequestRender,
  getRenderGovernorDiagnostics,
} from '../renderGovernor.js';

test('destroy invalidates a pending imagery provider before it can touch the viewer', async () => {
  let resolveProvider;
  let removed = 0;
  const changes = [];
  const controller = new MapStackController(
    {},
    { onChange: (state) => changes.push(state.status) },
  );
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

test('uninstall only releases the current viewer and makes later render requests inactive', () => {
  let renders = 0;
  const viewer = {
    scene: {
      requestRender: () => {
        renders++;
      },
    },
  };
  installRenderGovernor(viewer);
  holdContinuousRender('fixture');
  uninstallRenderGovernor({});
  assert.equal(getRenderGovernorDiagnostics().installed, true);
  uninstallRenderGovernor(viewer);
  const before = renders;
  governorRequestRender('late');
  assert.equal(renders, before);
  assert.equal(getRenderGovernorDiagnostics().installed, false);
  assert.deepEqual(getRenderGovernorDiagnostics().holds, []);
});
