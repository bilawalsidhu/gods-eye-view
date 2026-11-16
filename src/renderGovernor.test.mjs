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
} from './renderGovernor.js';
import { framePortFor } from './testSupport/fakeFramePort.mjs';

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

test('install with zero holds leaves the loop on demand', () => {
  const { viewer, scene } = makeViewer();
  installRenderGovernor(framePortFor(viewer.scene));
  assert.equal(scene.requestRenderMode, true);
  assert.equal(getRenderGovernorDiagnostics().mode, 'idle');
});

test('holds taken before install apply at install', () => {
  holdContinuousRender('boot');
  const { viewer, scene } = makeViewer();
  installRenderGovernor(framePortFor(viewer.scene));
  assert.equal(scene.requestRenderMode, false);
  releaseContinuousRender('boot');
  assert.equal(scene.requestRenderMode, true);
});

test('uninstall gives back what the governor holds on the port', () => {
  const { viewer, scene } = makeViewer();
  const frame = framePortFor(viewer.scene);
  installRenderGovernor(frame);
  holdContinuousRender('flights');
  assert.equal(scene.requestRenderMode, false);
  uninstallRenderGovernor(frame);
  assert.equal(scene.requestRenderMode, true);
  assert.deepEqual(getRenderGovernorDiagnostics().holds, []);
});

test('install needs a frame port', () => {
  assert.throws(() => installRenderGovernor({ scene: {} }), TypeError);
});

test('a hold flips to continuous; releasing the last hold returns to idle with a settling frame', () => {
  const { viewer, scene, calls } = makeViewer();
  installRenderGovernor(framePortFor(viewer.scene));
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
  installRenderGovernor(framePortFor(viewer.scene));
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
  installRenderGovernor(framePortFor(viewer.scene));
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
  installRenderGovernor(framePortFor(viewer.scene));
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
  installRenderGovernor(framePortFor(viewer.scene));
  assert.equal(scene.requestRenderMode, false, 'pre-install hold keeps continuous mode');
  releaseContinuousRender('flights');
  assert.equal(scene.requestRenderMode, true);
});

/** A camera port double: `moveStart`/`moveEnd` listeners and a pose. */
function makeCamera({ position = null, direction = null } = {}) {
  const listeners = { moveStart: new Set(), moveEnd: new Set() };
  const camera = {
    position,
    direction,
    on(event, cb) {
      listeners[event]?.add(cb);
      return () => listeners[event]?.delete(cb);
    },
    pose: () =>
      camera.position
        ? { position: camera.position, direction: camera.direction }
        : null,
    raise(event) {
      for (const cb of [...listeners[event]]) cb();
    },
    size: (event) => listeners[event].size,
  };
  return camera;
}

// The frame rate each mode draws at is the frame port's (ports.test.mjs:
// 'with an idle rate, …'); the governor only holds and releases.

test('a camera move holds continuous render from moveStart to moveEnd', () => {
  const { viewer, scene } = makeViewer();
  const frame = framePortFor(viewer.scene);
  const camera = makeCamera();
  installRenderGovernor(frame, { camera });
  camera.raise('moveStart');
  assert.equal(scene.requestRenderMode, false);
  assert.deepEqual(getRenderGovernorDiagnostics().holds, ['camera']);
  camera.raise('moveEnd');
  assert.equal(scene.requestRenderMode, true);
  // Installing again does not double the listeners; uninstall removes them.
  installRenderGovernor(frame, { camera });
  assert.equal(camera.size('moveStart'), 1);
  uninstallRenderGovernor(frame);
  assert.equal(camera.size('moveStart'), 0);
  assert.equal(camera.size('moveEnd'), 0);
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
  const camera = makeCamera({
    position: { x: 6_400_000, y: 0, z: 0 },
    direction: { x: -1, y: 0, z: 0 },
  });
  installRenderGovernor(framePortFor(viewer.scene), { camera, ...timers });
  camera.raise('moveStart');
  assert.equal(scene.requestRenderMode, false);
  // Still moving: the hold stays.
  camera.position = { x: 6_399_000, y: 0, z: 0 };
  timers.run();
  assert.equal(scene.requestRenderMode, false);
  // Drifting by far less than a millimetre: half a second of this is at rest.
  camera.position = { x: 6_399_000 + 1e-7, y: 0, z: 0 };
  timers.run();
  timers.run();
  assert.equal(scene.requestRenderMode, true);
  // A later move with no new moveStart takes the hold again.
  camera.position = { x: 6_000_000, y: 0, z: 0 };
  timers.run();
  assert.equal(scene.requestRenderMode, false);
  // moveEnd stops the sampling and releases.
  camera.raise('moveEnd');
  assert.equal(scene.requestRenderMode, true);
  assert.equal(timers.pending, 0);
});

test('sampling keeps running until moveEnd, so a move after a long drift still takes the hold', () => {
  const { viewer, scene } = makeViewer();
  const timers = fakeTimers();
  const camera = makeCamera({
    position: { x: 1, y: 0, z: 0 },
    direction: { x: -1, y: 0, z: 0 },
  });
  installRenderGovernor(framePortFor(viewer.scene), { camera, ...timers });
  camera.raise('moveStart');
  // Ten minutes at rest (2,400 samples): released, still sampling.
  for (let i = 0; i < 2_400; i++) timers.run();
  assert.equal(scene.requestRenderMode, true);
  assert.equal(timers.pending, 1);
  camera.position = { x: 1_000, y: 0, z: 0 };
  timers.run();
  assert.equal(scene.requestRenderMode, false);
});

test('installing again drops a camera hold the old listeners can no longer release', () => {
  const { viewer, scene } = makeViewer();
  const timers = fakeTimers();
  const frame = framePortFor(viewer.scene);
  const camera = makeCamera();
  installRenderGovernor(frame, { camera, ...timers });
  camera.raise('moveStart');
  assert.equal(scene.requestRenderMode, false);
  installRenderGovernor(frame, { camera, ...timers });
  assert.equal(scene.requestRenderMode, true);
  assert.equal(timers.pending, 0);
});
