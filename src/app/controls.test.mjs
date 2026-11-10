import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import '../testSupport/stubMgrs.mjs';
import { installVueDom } from '../testSupport/vueDom.mjs';

const { createApplicationControls } = await import('./controls.js');

let uninstallDom;
before(() => {
  uninstallDom = installVueDom();
});
after(() => uninstallDom());

test("application controls install the scene's zoom-out guard and remove it on teardown", () => {
  const handoffs = new Set();
  class Controls {
    hasShareState = true;
    orbitController = { stop() {} };
    hud = { destroy() {} };
    dispose() {}
    subscribeCameraHandoff(listener) {
      handoffs.add(listener);
      return () => handoffs.delete(listener);
    }
  }
  const cleanups = [];
  // The guard the scene's renderer gives: installed once, with the controls'
  // camera handoff, and disposed with the application.
  const guard = { installs: 0, disposals: 0 };
  createApplicationControls({
    scene: {
      viewer: {},
      mapStackController: {},
      operations: {
        surface: { controlServices: {} },
        searchAndFlyTo() {},
        requests: { regional: {}, weather: {} },
      },
      installZoomOutGuard({ subscribeCameraHandoff }) {
        guard.installs += 1;
        const unsubscribe = subscribeCameraHandoff(() => {});
        return () => {
          guard.disposals += 1;
          unsubscribe();
        };
      },
    },
    loaderStatus: {},
    Controls,
    catalog: { get: (id) => ({ id }) },
    defer: (cleanup) => cleanups.push(cleanup),
  });

  assert.equal(guard.installs, 1);
  assert.equal(handoffs.size, 1);

  for (const cleanup of cleanups.reverse()) cleanup();
  assert.equal(guard.disposals, 1);
  assert.equal(handoffs.size, 0);
});

test('a scene without a zoom-out guard starts its controls without one', () => {
  class Controls {
    hasShareState = true;
    orbitController = { stop() {} };
    hud = { destroy() {} };
    dispose() {}
  }
  const cleanups = [];
  createApplicationControls({
    scene: {
      viewer: {},
      mapStackController: {},
      operations: {
        surface: { controlServices: {} },
        searchAndFlyTo() {},
        requests: { regional: {}, weather: {} },
      },
    },
    loaderStatus: {},
    Controls,
    catalog: { get: (id) => ({ id }) },
    defer: (cleanup) => cleanups.push(cleanup),
  });
  for (const cleanup of cleanups.reverse()) cleanup();
});
