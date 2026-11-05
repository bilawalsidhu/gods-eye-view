import test from 'node:test';
import assert from 'node:assert/strict';
import {
  _resetRenderGovernorForTest,
  getRenderGovernorDiagnostics,
  holdContinuousRender,
  installRenderGovernor,
} from '../../renderGovernor.js';
import { createCesiumRender, RENDER_OWNER } from './render.js';
import { createFakeViewer } from './testing/fakeViewer.mjs';

test.beforeEach(() => _resetRenderGovernorForTest());
test.after(() => _resetRenderGovernorForTest());

test('request goes through the injected requestRender with a reason', () => {
  const viewer = createFakeViewer();
  const reasons = [];
  const { render } = createCesiumRender(viewer, {
    requestRender: (reason) => reasons.push(reason),
  });
  render.request();
  assert.deepEqual(reasons, [RENDER_OWNER]);
  assert.equal(viewer.callsOf('scene.requestRender').length, 0);
});

test('request defaults to the render governor', () => {
  const viewer = createFakeViewer();
  installRenderGovernor(viewer);
  const { render } = createCesiumRender(viewer);
  render.request();
  assert.equal(viewer.callsOf('scene.requestRender').length, 1);
  assert.deepEqual(
    getRenderGovernorDiagnostics().recentRequests.map(({ reason }) => reason),
    [RENDER_OWNER],
  );
});

test('creation leaves the scene and the governor alone', () => {
  const viewer = createFakeViewer();
  viewer.scene.maximumRenderTimeChange = 0.5;
  createCesiumRender(viewer);
  assert.equal(viewer.scene.requestRenderMode, true);
  assert.equal(viewer.scene.maximumRenderTimeChange, 0.5);
  assert.equal(getRenderGovernorDiagnostics().installed, false);
  assert.deepEqual(getRenderGovernorDiagnostics().holds, []);
});

test('setContinuous holds and releases the governor under its own owner', () => {
  const viewer = createFakeViewer();
  installRenderGovernor(viewer);
  const { render } = createCesiumRender(viewer);
  assert.equal(render.isContinuous(), false);
  render.setContinuous(true);
  assert.deepEqual(getRenderGovernorDiagnostics().holds, [RENDER_OWNER]);
  assert.equal(viewer.scene.requestRenderMode, false);
  assert.equal(render.isContinuous(), true);
  render.setContinuous(false);
  assert.deepEqual(getRenderGovernorDiagnostics().holds, []);
  assert.equal(render.isContinuous(), false);
});

test("isContinuous reports the scene's mode, including other owners' holds", () => {
  const viewer = createFakeViewer();
  installRenderGovernor(viewer);
  const { render } = createCesiumRender(viewer);
  holdContinuousRender('flights');
  render.setContinuous(false);
  assert.equal(render.isContinuous(), true);
});

test('destroy releases the engine hold', () => {
  const viewer = createFakeViewer();
  installRenderGovernor(viewer);
  const { render, destroy } = createCesiumRender(viewer);
  render.setContinuous(true);
  destroy();
  assert.deepEqual(getRenderGovernorDiagnostics().holds, []);
});

test('request passes a caller reason through to the governor', () => {
  const viewer = createFakeViewer();
  installRenderGovernor(viewer);
  const { render } = createCesiumRender(viewer);
  render.request('world-overlay');
  assert.deepEqual(
    getRenderGovernorDiagnostics().recentRequests.map(({ reason }) => reason),
    ['world-overlay'],
  );
});

test('without a governor on its viewer, request renders the scene directly', () => {
  const viewer = createFakeViewer();
  const { render } = createCesiumRender(viewer);
  render.request();
  assert.equal(viewer.callsOf('scene.requestRender').length, 1);
  const governed = createFakeViewer();
  installRenderGovernor(governed);
  render.request();
  assert.equal(viewer.callsOf('scene.requestRender').length, 2);
  assert.equal(governed.callsOf('scene.requestRender').length, 0);
  assert.deepEqual(getRenderGovernorDiagnostics().recentRequests, []);
});
