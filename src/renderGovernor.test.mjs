import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  installRenderGovernor,
  holdContinuousRender,
  releaseContinuousRender,
  governorRequestRender,
  getRenderGovernorDiagnostics,
  uninstallRenderGovernor,
  _resetRenderGovernorForTest,
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

// ---------------------------------------------------------------- ambient frame rate

/**
 * A viewer with a frame-rate setting, a camera pose and a postRender event the
 * test fires by hand (one call = one rendered frame at the given time).
 */
function makeMovingViewer({ targetFrameRate = 60 } = {}) {
  const listeners = new Set();
  const camera = { positionWC: { x: 1e6, y: 0, z: 0 }, directionWC: { x: -1, y: 0, z: 0 } };
  const scene = {
    requestRenderMode: false,
    maximumRenderTimeChange: 0,
    requestRender() {},
    postRender: {
      addEventListener(fn) {
        listeners.add(fn);
        return () => listeners.delete(fn);
      },
    },
  };
  const viewer = { scene, camera, targetFrameRate };
  return {
    viewer,
    camera,
    listeners,
    frame(at) {
      const realNow = performance.now;
      performance.now = () => at;
      try {
        for (const fn of [...listeners]) fn();
      } finally {
        performance.now = realNow;
      }
    },
  };
}

test('only slow live feeds holding, with a still camera: 30 frames a second', () => {
  const m = makeMovingViewer();
  installRenderGovernor(m.viewer);
  m.frame(0); // the first frame records the pose
  m.frame(1000);
  holdContinuousRender('flights');
  holdContinuousRender('wind');
  assert.equal(m.viewer.targetFrameRate, 30);
  // Any other owner (a camera verb, tracking, the cockpit…) restores the full rate.
  holdContinuousRender('camera-verb');
  assert.equal(m.viewer.targetFrameRate, 60);
  releaseContinuousRender('camera-verb');
  assert.equal(m.viewer.targetFrameRate, 30);
  // Idle (no holds) goes back to the full rate for camera-driven renders.
  releaseContinuousRender('flights');
  releaseContinuousRender('wind');
  assert.equal(m.viewer.targetFrameRate, 60);
});

test('camera motion restores the full rate until the camera has been still for half a second', () => {
  const m = makeMovingViewer();
  installRenderGovernor(m.viewer);
  m.frame(0);
  m.frame(1000);
  holdContinuousRender('traffic');
  assert.equal(m.viewer.targetFrameRate, 30);
  m.camera.positionWC = { x: 1e6 - 10, y: 0, z: 0 };
  m.frame(1100);
  assert.equal(m.viewer.targetFrameRate, 60);
  assert.equal(getRenderGovernorDiagnostics().cameraMoving, true);
  m.frame(1400); // still, but not long enough
  assert.equal(m.viewer.targetFrameRate, 60);
  m.frame(1700);
  assert.equal(m.viewer.targetFrameRate, 30);
  // A turn in place counts as motion too.
  m.camera.directionWC = { x: -0.999, y: 0.0447, z: 0 };
  m.frame(1800);
  assert.equal(m.viewer.targetFrameRate, 60);
});

test('a millimetre of camera drift is not motion', () => {
  const m = makeMovingViewer();
  installRenderGovernor(m.viewer);
  m.frame(0);
  m.frame(1000);
  holdContinuousRender('satellites');
  m.camera.positionWC = { x: 1e6 - 0.001, y: 0, z: 0 };
  m.frame(1100);
  assert.equal(m.viewer.targetFrameRate, 30);
});

test('the viewer’s own frame rate is the full rate, and uninstall gives it back', () => {
  const m = makeMovingViewer({ targetFrameRate: 45 });
  installRenderGovernor(m.viewer);
  m.frame(0);
  m.frame(1000);
  holdContinuousRender('ais-vessels');
  assert.equal(m.viewer.targetFrameRate, 30);
  holdContinuousRender('cockpit');
  assert.equal(m.viewer.targetFrameRate, 45);
  uninstallRenderGovernor(m.viewer);
  assert.equal(m.viewer.targetFrameRate, 45);
  assert.equal(m.listeners.size, 0, 'the motion listener is removed');
});
