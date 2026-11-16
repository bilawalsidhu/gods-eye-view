import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  installRenderGovernor,
  holdContinuousRender,
  releaseContinuousRender,
  governorRequestRender,
  getRenderGovernorDiagnostics,
  _resetRenderGovernorForTest,
  uninstallRenderGovernor,
  IDLE_FRAME_RATE,
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

function makeEvent() {
  const listeners = new Set();
  return {
    addEventListener(fn) {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
    raise() {
      for (const fn of [...listeners]) fn();
    },
    get size() {
      return listeners.size;
    },
  };
}

test('idle caps the frame rate; anything moving draws at the display rate', () => {
  const { viewer } = makeViewer();
  installRenderGovernor(viewer);
  assert.equal(viewer.targetFrameRate, IDLE_FRAME_RATE);
  holdContinuousRender('flights');
  assert.equal(viewer.targetFrameRate, undefined);
  releaseContinuousRender('flights');
  assert.equal(viewer.targetFrameRate, IDLE_FRAME_RATE);
});

test('a camera move holds continuous render from moveStart to moveEnd', () => {
  const { viewer, scene } = makeViewer();
  viewer.camera = { moveStart: makeEvent(), moveEnd: makeEvent() };
  installRenderGovernor(viewer);
  viewer.camera.moveStart.raise();
  assert.equal(scene.requestRenderMode, false);
  assert.equal(viewer.targetFrameRate, undefined);
  assert.deepEqual(getRenderGovernorDiagnostics().holds, ['camera']);
  viewer.camera.moveEnd.raise();
  assert.equal(scene.requestRenderMode, true);
  assert.equal(viewer.targetFrameRate, IDLE_FRAME_RATE);
  // Installing again does not double the listeners; uninstall removes them.
  installRenderGovernor(viewer);
  assert.equal(viewer.camera.moveStart.size, 1);
  uninstallRenderGovernor(viewer);
  assert.equal(viewer.camera.moveStart.size, 0);
  assert.equal(viewer.camera.moveEnd.size, 0);
});

function fakeTimers() {
  const queue = new Map();
  let next = 1;
  return {
    setTimeout: (fn) => {
      queue.set(next, fn);
      return next++;
    },
    clearTimeout: (id) => queue.delete(id),
    run() {
      const due = [...queue.entries()];
      queue.clear();
      for (const [, fn] of due) fn();
    },
    get pending() {
      return queue.size;
    },
  };
}

test('a camera that drifts by rounding errors and never raises moveEnd still releases its hold', () => {
  const { viewer, scene } = makeViewer();
  const timers = fakeTimers();
  viewer.camera = {
    moveStart: makeEvent(),
    moveEnd: makeEvent(),
    positionWC: { x: 6_400_000, y: 0, z: 0 },
    directionWC: { x: -1, y: 0, z: 0 },
  };
  installRenderGovernor(viewer, timers);
  viewer.camera.moveStart.raise();
  assert.equal(scene.requestRenderMode, false);
  // Still moving: the hold stays.
  viewer.camera.positionWC = { x: 6_399_000, y: 0, z: 0 };
  timers.run();
  assert.equal(scene.requestRenderMode, false);
  // Drifting by far less than a millimetre: half a second of this is at rest.
  viewer.camera.positionWC = { x: 6_399_000 + 1e-7, y: 0, z: 0 };
  timers.run();
  timers.run();
  assert.equal(scene.requestRenderMode, true);
  assert.equal(viewer.targetFrameRate, IDLE_FRAME_RATE);
  // A later move with no new moveStart takes the hold again.
  viewer.camera.positionWC = { x: 6_000_000, y: 0, z: 0 };
  timers.run();
  assert.equal(scene.requestRenderMode, false);
  // moveEnd stops the sampling and releases.
  viewer.camera.moveEnd.raise();
  assert.equal(scene.requestRenderMode, true);
  assert.equal(timers.pending, 0);
});

test('sampling keeps running until moveEnd, so a move after a long drift still takes the hold', () => {
  const { viewer, scene } = makeViewer();
  const timers = fakeTimers();
  viewer.camera = {
    moveStart: makeEvent(),
    moveEnd: makeEvent(),
    positionWC: { x: 1, y: 0, z: 0 },
    directionWC: { x: -1, y: 0, z: 0 },
  };
  installRenderGovernor(viewer, timers);
  viewer.camera.moveStart.raise();
  // Ten minutes at rest (2,400 samples): released, still sampling.
  for (let i = 0; i < 2_400; i++) timers.run();
  assert.equal(scene.requestRenderMode, true);
  assert.equal(timers.pending, 1);
  viewer.camera.positionWC = { x: 1_000, y: 0, z: 0 };
  timers.run();
  assert.equal(scene.requestRenderMode, false);
});

test('installing again drops a camera hold the old listeners can no longer release', () => {
  const { viewer, scene } = makeViewer();
  const timers = fakeTimers();
  viewer.camera = { moveStart: makeEvent(), moveEnd: makeEvent() };
  installRenderGovernor(viewer, timers);
  viewer.camera.moveStart.raise();
  assert.equal(scene.requestRenderMode, false);
  installRenderGovernor(viewer, timers);
  assert.equal(scene.requestRenderMode, true);
  assert.equal(timers.pending, 0);
});
