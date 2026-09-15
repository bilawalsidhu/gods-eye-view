import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  installRenderGovernor,
  holdContinuousRender,
  releaseContinuousRender,
  governorRequestRender,
  getRenderGovernorDiagnostics,
  resolveGovernorTargetFrameRate,
  BASE_TARGET_FRAME_RATE,
  STYLE_ANIM_LOW_DEMAND_FPS,
  STYLE_ANIM_OWNER_ID,
  _resetRenderGovernorForTest,
} from './renderGovernor.js';

/** Minimal Cesium-Event stub: records listeners, returns a remover. */
function makeEvent() {
  const listeners = [];
  return {
    listeners,
    addEventListener(fn) {
      listeners.push(fn);
      return () => {
        const i = listeners.indexOf(fn);
        if (i !== -1) listeners.splice(i, 1);
      };
    },
    fire() {
      for (const fn of [...listeners]) fn();
    },
  };
}

function makeViewer() {
  const calls = { requestRender: 0 };
  const moveStart = makeEvent();
  const moveEnd = makeEvent();
  const scene = {
    requestRenderMode: false,
    maximumRenderTimeChange: 0,
    requestRender() { calls.requestRender += 1; },
    camera: { moveStart, moveEnd },
  };
  return { viewer: { scene }, scene, calls, moveStart, moveEnd };
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
  releaseContinuousRender('flights', true);
  assert.equal(scene.requestRenderMode, true);
  // Entering idle renders one settling frame.
  assert.equal(calls.requestRender, settleBaseline + 1);
});

test('holds are identity-keyed: double-hold cannot leak, double-release cannot corrupt', () => {
  const { viewer, scene } = makeViewer();
  installRenderGovernor(viewer);
  holdContinuousRender('traffic');
  holdContinuousRender('traffic');
  releaseContinuousRender('traffic', true);
  assert.equal(scene.requestRenderMode, true, 'single release clears an idempotent double-hold');
  releaseContinuousRender('traffic', true);
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
  releaseContinuousRender('satellites', true);
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
  releaseContinuousRender('flights', true);
  assert.equal(scene.requestRenderMode, true);
});

test('low-demand policy: style-anim alone with a still camera runs the scene at 30 fps', () => {
  const { viewer } = makeViewer();
  installRenderGovernor(viewer);
  // Install starts conservatively camera-active (boot flight may be mid-air).
  assert.equal(viewer.targetFrameRate, BASE_TARGET_FRAME_RATE);
  viewer.scene.camera.moveEnd.fire();
  holdContinuousRender(STYLE_ANIM_OWNER_ID);
  assert.equal(viewer.targetFrameRate, STYLE_ANIM_LOW_DEMAND_FPS);
  assert.equal(getRenderGovernorDiagnostics().targetFrameRate, STYLE_ANIM_LOW_DEMAND_FPS);
  // Settling to idle restores the baseline.
  releaseContinuousRender(STYLE_ANIM_OWNER_ID, true);
  assert.equal(viewer.targetFrameRate, BASE_TARGET_FRAME_RATE);
});

test('any second hold — or camera motion — restores the baseline immediately', () => {
  const { viewer, moveStart, moveEnd } = makeViewer();
  installRenderGovernor(viewer);
  moveEnd.fire();
  holdContinuousRender(STYLE_ANIM_OWNER_ID);
  assert.equal(viewer.targetFrameRate, STYLE_ANIM_LOW_DEMAND_FPS);

  holdContinuousRender('flights');
  assert.equal(viewer.targetFrameRate, BASE_TARGET_FRAME_RATE, 'second holder → baseline');
  releaseContinuousRender('flights', true);
  assert.equal(viewer.targetFrameRate, STYLE_ANIM_LOW_DEMAND_FPS, 'back to low demand');

  moveStart.fire();
  assert.equal(viewer.targetFrameRate, BASE_TARGET_FRAME_RATE, 'camera motion → baseline');
  assert.equal(getRenderGovernorDiagnostics().cameraActive, true);
  moveEnd.fire();
  assert.equal(viewer.targetFrameRate, STYLE_ANIM_LOW_DEMAND_FPS, 'camera settled → low demand');
});

test('a viewer without camera events still gets mode + baseline-rate behavior', () => {
  const calls = { requestRender: 0 };
  const scene = {
    requestRenderMode: false,
    maximumRenderTimeChange: 0,
    requestRender() { calls.requestRender += 1; },
  };
  const viewer = { scene, targetFrameRate: BASE_TARGET_FRAME_RATE };
  installRenderGovernor(viewer);
  holdContinuousRender(STYLE_ANIM_OWNER_ID);
  // No camera events ever fire → the conservative camera-active default holds
  // and the rate stays at baseline; mode behavior is unaffected.
  assert.equal(viewer.targetFrameRate, BASE_TARGET_FRAME_RATE);
  assert.equal(scene.requestRenderMode, false);
  releaseContinuousRender(STYLE_ANIM_OWNER_ID, true);
  assert.equal(scene.requestRenderMode, true);
});

test('resolveGovernorTargetFrameRate is pure and pins the decision table', () => {
  const base = { baseFps: 60, lowDemandFps: 30 };
  assert.equal(resolveGovernorTargetFrameRate({ ...base, holds: [], cameraActive: false }), 60);
  assert.equal(resolveGovernorTargetFrameRate({ ...base, holds: ['style-anim'], cameraActive: false }), 30);
  assert.equal(resolveGovernorTargetFrameRate({ ...base, holds: ['style-anim'], cameraActive: true }), 60);
  assert.equal(resolveGovernorTargetFrameRate({ ...base, holds: ['style-anim', 'flights'], cameraActive: false }), 60);
  assert.equal(resolveGovernorTargetFrameRate({ ...base, holds: ['flights'], cameraActive: false }), 60);
  // Non-default rates flow through (keeps future cadence retunes one-line).
  assert.equal(resolveGovernorTargetFrameRate({ baseFps: 120, lowDemandFps: 45, holds: ['style-anim'], cameraActive: false }), 45);
});
