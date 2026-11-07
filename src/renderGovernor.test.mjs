import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  installRenderGovernor,
  installEngineRenderGovernor,
  holdContinuousRender,
  releaseContinuousRender,
  governorRequestRender,
  getRenderGovernorDiagnostics,
  _resetRenderGovernorForTest,
  isRenderGovernorInstalled,
  uninstallRenderGovernor,
} from './renderGovernor.js';

function makeViewer() {
  const calls = { requestRender: 0 };
  const scene = {
    requestRenderMode: false,
    maximumRenderTimeChange: 0,
    requestRender() { calls.requestRender += 1; },
  };
  return { viewer: { scene }, scene, calls };
}

beforeEach(() => _resetRenderGovernorForTest());

test('install with zero holds enters idle mode and pins maximumRenderTimeChange', () => {
  const { viewer, scene } = makeViewer();
  installRenderGovernor(viewer);
  assert.equal(scene.requestRenderMode, true);
  assert.equal(scene.maximumRenderTimeChange, Infinity);
  assert.equal(getRenderGovernorDiagnostics().mode, 'idle');
});

test('a hold flips to continuous; releasing the last hold returns to idle with a settling frame', () => {
  const { viewer, scene, calls } = makeViewer();
  installRenderGovernor(viewer);
  const settleBaseline = calls.requestRender;
  holdContinuousRender('flights');
  assert.equal(scene.requestRenderMode, false);
  assert.equal(getRenderGovernorDiagnostics().mode, 'continuous');
  releaseContinuousRender('flights');
  assert.equal(scene.requestRenderMode, true);
  // Entering idle renders one settling frame.
  assert.equal(calls.requestRender, settleBaseline + 1);
});

test('holds are identity-keyed: double-hold cannot leak, double-release cannot corrupt', () => {
  const { viewer, scene } = makeViewer();
  installRenderGovernor(viewer);
  holdContinuousRender('traffic');
  holdContinuousRender('traffic');
  releaseContinuousRender('traffic');
  assert.equal(scene.requestRenderMode, true, 'single release clears an idempotent double-hold');
  releaseContinuousRender('traffic');
  releaseContinuousRender('never-held');
  assert.equal(scene.requestRenderMode, true);
});

test('mode stays continuous until the LAST holder releases', () => {
  const { viewer, scene } = makeViewer();
  installRenderGovernor(viewer);
  holdContinuousRender('flights');
  holdContinuousRender('satellites');
  releaseContinuousRender('flights');
  assert.equal(scene.requestRenderMode, false);
  assert.deepEqual(getRenderGovernorDiagnostics().holds, ['satellites']);
  releaseContinuousRender('satellites');
  assert.equal(scene.requestRenderMode, true);
});

test('governorRequestRender forwards to the scene and records reasons only in idle mode', () => {
  const { viewer, calls } = makeViewer();
  installRenderGovernor(viewer);
  const baseline = calls.requestRender;
  governorRequestRender('layer-tick:earthquakes');
  assert.equal(calls.requestRender, baseline + 1);
  assert.equal(getRenderGovernorDiagnostics().recentRequests.at(-1).reason, 'layer-tick:earthquakes');
  holdContinuousRender('flights');
  const idleRequests = getRenderGovernorDiagnostics().recentRequests.length;
  governorRequestRender('slider');
  assert.equal(
    getRenderGovernorDiagnostics().recentRequests.length,
    idleRequests,
    'continuous-mode requests are not recorded as idle diagnostics',
  );
});

test('hold/release/request are safe no-ops before install (test environments without a viewer)', () => {
  holdContinuousRender('flights');
  releaseContinuousRender('flights');
  governorRequestRender('noop');
  assert.equal(getRenderGovernorDiagnostics().installed, false);
});

test('holds registered before install apply at install time', () => {
  holdContinuousRender('flights');
  const { viewer, scene } = makeViewer();
  installRenderGovernor(viewer);
  assert.equal(scene.requestRenderMode, false, 'pre-install hold keeps continuous mode');
  releaseContinuousRender('flights');
  assert.equal(scene.requestRenderMode, true);
});

test('isRenderGovernorInstalled names the one governed viewer', async () => {
  const { isRenderGovernorInstalled, uninstallRenderGovernor } = await import('./renderGovernor.js');
  const { viewer } = makeViewer();
  const other = makeViewer().viewer;
  assert.equal(isRenderGovernorInstalled(viewer), false);
  installRenderGovernor(viewer);
  assert.equal(isRenderGovernorInstalled(viewer), true);
  assert.equal(isRenderGovernorInstalled(other), false);
  uninstallRenderGovernor(viewer);
  assert.equal(isRenderGovernorInstalled(viewer), false);
});

test('on a non-Cesium globe engine the governor drives engine.render with owner-counted holds', async () => {
  const { createFakeEngine } = await import('./globe/testing/fakeEngine.js');
  _resetRenderGovernorForTest();
  const engine = createFakeEngine({ kind: 'navara' });
  holdContinuousRender('before-install');
  installEngineRenderGovernor(engine);
  assert.equal(engine.render.isContinuous(), true, 'a hold taken before install applies');
  releaseContinuousRender('before-install');
  assert.equal(engine.render.isContinuous(), false);
  holdContinuousRender('a');
  holdContinuousRender('b');
  assert.equal(engine.render.isContinuous(), true);
  releaseContinuousRender('a');
  assert.equal(engine.render.isContinuous(), true, 'b still holds');
  releaseContinuousRender('b');
  assert.equal(engine.render.isContinuous(), false);
  engine.fake.resetCalls();
  governorRequestRender('slider');
  assert.deepEqual(engine.fake.callsOf('render.request').map((c) => c.args), [['slider']]);
  assert.equal(isRenderGovernorInstalled(engine), true);
  uninstallRenderGovernor(engine);
  _resetRenderGovernorForTest();
});

test('releasing an absent Navara hold does not wake an already idle engine', async () => {
  const { createFakeEngine } = await import('./globe/testing/fakeEngine.js');
  _resetRenderGovernorForTest();
  const engine = createFakeEngine({ kind: 'navara' });
  installEngineRenderGovernor(engine);
  engine.fake.resetCalls();
  for (let i = 0; i < 22; i++) releaseContinuousRender('cctv-projection');
  assert.equal(engine.fake.callsOf('render.request').length, 0);
  holdContinuousRender('video');
  releaseContinuousRender('video');
  assert.equal(engine.fake.callsOf('render.request').length, 1);
  releaseContinuousRender('video');
  assert.equal(engine.fake.callsOf('render.request').length, 1);
  uninstallRenderGovernor(engine);
  _resetRenderGovernorForTest();
});
