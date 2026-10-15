import test from 'node:test';
import assert from 'node:assert/strict';
import { assertGlobeEngine } from '../contract.js';
import {
  _resetRenderGovernorForTest,
  getRenderGovernorDiagnostics,
  installRenderGovernor,
} from '../../renderGovernor.js';
import { createCesiumEngine } from './createCesiumEngine.js';
import {
  createFakeEventHandlers,
  createFakeViewer,
} from './testing/fakeViewer.mjs';

test.afterEach(() => _resetRenderGovernorForTest());

function snapshot(viewer) {
  const { scene } = viewer;
  return {
    requestRenderMode: scene.requestRenderMode,
    maximumRenderTimeChange: scene.maximumRenderTimeChange,
    globeShow: scene.globe.show,
    enableInputs: scene.screenSpaceCameraController.enableInputs,
    percentageChanged: scene.camera.percentageChanged,
    listeners: [
      scene.camera.changed,
      scene.camera.moveStart,
      scene.camera.moveEnd,
      scene.preUpdate,
      scene.preRender,
      scene.postRender,
    ].map((event) => event.numberOfListeners),
  };
}

test('the engine satisfies the contract shape and changes nothing at creation', () => {
  const viewer = createFakeViewer({ width: 800, height: 600 });
  const handlers = createFakeEventHandlers();
  const before = snapshot(viewer);
  const engine = createCesiumEngine(viewer, {
    createEventHandler: handlers.create,
  });
  assertGlobeEngine(engine);
  assert.equal(engine.kind, 'cesium');
  assert.deepEqual(viewer.calls, []);
  assert.deepEqual(snapshot(viewer), before);
  assert.equal(handlers.handlers.length, 0);
  assert.equal(engine.host.container, viewer.container);
  assert.equal(engine.host.canvas, viewer.scene.canvas);
  assert.deepEqual(engine.host.size(), { width: 800, height: 600 });
  viewer.scene.canvas.clientWidth = 640;
  assert.deepEqual(engine.host.size(), { width: 640, height: 600 });
});

test('the render option reaches render.request', () => {
  const viewer = createFakeViewer();
  const reasons = [];
  const engine = createCesiumEngine(viewer, {
    requestRender: (reason) => reasons.push(reason),
  });
  engine.render.request();
  assert.equal(reasons.length, 1);
});

test('destroy releases holds, listeners, handlers and engine-owned map state', async () => {
  const viewer = createFakeViewer();
  installRenderGovernor(viewer);
  const handlers = createFakeEventHandlers();
  const engine = createCesiumEngine(viewer, {
    createEventHandler: handlers.create,
    createImageryLayer: (provider) => ({ provider }),
  });
  engine.camera.changed.addEventListener(() => {});
  engine.frames.postRender.addEventListener(() => {});
  engine.input.on('click', () => {});
  engine.render.setContinuous(true);
  engine.credits.addStatic('credit');
  await engine.maps.setBaseImagery({ kind: 'osm' });
  engine.destroy();
  engine.destroy();
  assert.equal(viewer.scene.camera.changed.numberOfListeners, 0);
  assert.equal(viewer.scene.postRender.numberOfListeners, 0);
  assert.equal(handlers.handlers[0].destroyed, true);
  assert.deepEqual(getRenderGovernorDiagnostics().holds, []);
  assert.deepEqual(viewer.staticCredits, []);
  assert.deepEqual(viewer.imageryList, []);
});
