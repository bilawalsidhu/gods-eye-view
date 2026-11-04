import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import * as Cesium from 'cesium';
import '../testSupport/stubMgrs.mjs';
import { installVueDom } from '../testSupport/vueDom.mjs';
import { MAXIMUM_ZOOM_DISTANCE_M } from './zoomOutGuard.js';

const { createApplicationControls } = await import('./controls.js');

let uninstallDom;
before(() => {
  uninstallDom = installVueDom();
});
after(() => uninstallDom());

test('application controls install the zoom-out guard and remove it on teardown', () => {
  const canvas = document.createElement('canvas');
  const controller = { maximumZoomDistance: Infinity };
  const scene = {
    mode: Cesium.SceneMode.SCENE3D,
    screenSpaceCameraController: controller,
    preRender: new Cesium.Event(),
    postUpdate: new Cesium.Event(),
  };
  const camera = {
    position: Cesium.Cartesian3.fromDegrees(0, 0, 1_000_000),
    positionCartographic: { height: 1_000_000 },
  };
  const viewer = { scene, camera, canvas };
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
  createApplicationControls({
    scene: {
      viewer,
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

  assert.equal(controller.maximumZoomDistance, MAXIMUM_ZOOM_DISTANCE_M);
  assert.equal(scene.preRender.numberOfListeners, 1);
  assert.equal(scene.postUpdate.numberOfListeners, 1);
  assert.equal(handoffs.size, 1);

  for (const cleanup of cleanups.reverse()) cleanup();
  assert.equal(controller.maximumZoomDistance, Infinity);
  assert.equal(scene.preRender.numberOfListeners, 0);
  assert.equal(scene.postUpdate.numberOfListeners, 0);
  assert.equal(handoffs.size, 0);
});
