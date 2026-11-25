import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import '../testSupport/stubMgrs.mjs';
import { installVueDom } from '../testSupport/vueDom.mjs';
import { bindFakeCesiumCamera } from '../testSupport/fakeCameraPort.mjs';

const { createApplicationControls } = await import('./controls.js');

let uninstallDom;
before(() => {
  uninstallDom = installVueDom();
});
after(() => uninstallDom());

test('the application controls start and stop with the host weather service', () => {
  let shellServices;
  const weather = {
    getConditions(lat, lon) {
      assert.equal(this, weather);
      return { lat, lon };
    },
  };
  class Controls {
    constructor(_viewer, { services }) {
      shellServices = services;
    }
    hasShareState = true;
    orbitController = { stop() {} };
    hud = { destroy() {} };
    dispose() {}
  }
  const cleanups = [];
  createApplicationControls({
    scene: {
      viewer: bindFakeCesiumCamera({
        isDestroyed: () => false,
        camera: { setView() {} },
      }),
      mapStackController: {},
      operations: {
        surface: { controlServices: {} },
        searchAndFlyTo() {},
        requests: { regional: {}, weather },
      },
    },
    loaderStatus: {},
    Controls,
    catalog: { get: (id) => ({ id }) },
    defer: (cleanup) => cleanups.push(cleanup),
  });
  for (const cleanup of cleanups.reverse()) cleanup();
  assert.deepEqual(shellServices.fetchSpotWeather(48.5, -123.1), {
    lat: 48.5,
    lon: -123.1,
  });
});
