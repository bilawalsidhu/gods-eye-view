import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import * as Cesium from 'cesium';
import '../testSupport/stubMgrs.mjs';
import { installVueDom } from '../testSupport/vueDom.mjs';
import { MAXIMUM_ZOOM_DISTANCE_M } from '../globe/cesium/zoomOutGuard.js';

const { createApplicationControls } = await import('./controls.js');

// controls.js and the shell import browser-only UI modules, so these read the
// source: the scene engine is threaded to the shell, which hands it (not the
// viewer) to the world overlay. The overlay itself is tested on the fake
// engine without a viewer (src/overlays/worldOverlay.test.mjs).
const read = (relative) =>
  readFileSync(new URL(relative, import.meta.url), 'utf8');

test('the controls pass the scene engine to the shell', () => {
  const controls = read('./controls.js');
  assert.match(
    controls,
    /const \{ viewer, engine, mapStackController, operations \} = scene;/,
  );
  assert.match(controls, /new Controls\(viewer, \{[\s\S]*?\n\s+engine,\n/);
  // A later globe reaches the shell with its own engine.
  assert.match(
    read('./shellPart.js'),
    /styleManager\.attachScene\(\s*\{\s+viewer: next\.viewer,\s+engine: next\.engine,/,
  );
});

test('the shell initializes the world overlay on its engine', () => {
  const shell = read('../ui/applicationShell.js') + read('../ui/shellScene.js');
  assert.match(shell, /\{\n\s+engine = null,\n\s+mapStackController = null,/);
  assert.match(shell, /worldOverlayFor\(engine\)\.init\(\);/);
  assert.doesNotMatch(shell, /worldOverlayFor\(viewer\)/);
});

let uninstallDom;
before(() => {
  uninstallDom = installVueDom();
});
after(() => uninstallDom());

test('application controls install the zoom-out guard and remove it on teardown', async () => {
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
    detachScene() {}
    subscribeCameraHandoff(listener) {
      handoffs.add(listener);
      return () => handoffs.delete(listener);
    }
  }
  const cleanups = [];
  await createApplicationControls({
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

  for (const cleanup of cleanups.reverse()) await cleanup();
  assert.equal(controller.maximumZoomDistance, Infinity);
  assert.equal(scene.preRender.numberOfListeners, 0);
  assert.equal(scene.postUpdate.numberOfListeners, 0);
  assert.equal(handoffs.size, 0);
});
