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
  FOLLOW_FRAME_RATE,
} from './renderGovernor.js';
import { framePortFor } from './testSupport/fakeFramePort.mjs';

function makeViewer() {
  const calls = { requestRender: 0 };
  const scene = {
    requestRenderMode: false,
    maximumRenderTimeChange: 0,
    requestRender() {
      calls.requestRender += 1;
    },
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
  assert.equal(
    scene.requestRenderMode,
    true,
    'single release clears an idempotent double-hold',
  );
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
  assert.equal(
    getRenderGovernorDiagnostics().recentRequests.at(-1).reason,
    'layer-tick:earthquakes',
  );
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
  assert.equal(
    scene.requestRenderMode,
    false,
    'pre-install hold keeps continuous mode',
  );
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

test('idle, the loop ticks at the idle rate; held, at the display rate', () => {
  const { viewer, scene } = makeViewer();
  installRenderGovernor(framePortFor(viewer.scene));
  assert.equal(scene.targetFps, IDLE_FRAME_RATE, 'idle at install');
  holdContinuousRender('flights');
  assert.equal(scene.targetFps, 0, 'held: the display rate');
  releaseContinuousRender('flights');
  assert.equal(scene.targetFps, IDLE_FRAME_RATE);
});

test('a hold already out at install draws at the display rate', () => {
  holdContinuousRender('boot');
  const { viewer, scene } = makeViewer();
  installRenderGovernor(framePortFor(viewer.scene));
  assert.equal(scene.targetFps, 0);
  releaseContinuousRender('boot');
  assert.equal(scene.targetFps, IDLE_FRAME_RATE);
});

test('the renderer holding the loop itself (animated visual styles) also draws at the display rate', () => {
  const { viewer, scene } = makeViewer();
  const frame = framePortFor(viewer.scene);
  installRenderGovernor(frame);
  const release = frame.holdContinuous('effects:animated');
  assert.equal(scene.targetFps, 0, 'held by the renderer');
  holdContinuousRender('flights');
  release();
  assert.equal(scene.targetFps, 0, 'still held by flights');
  releaseContinuousRender('flights');
  assert.equal(scene.targetFps, IDLE_FRAME_RATE);
  // Uninstalled, the governor no longer sets the rate.
  uninstallRenderGovernor(frame);
  frame.holdContinuous('effects:animated');
  assert.equal(scene.targetFps, IDLE_FRAME_RATE);
});

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

test('a hold may cap the rate: the highest asked wins, an uncapped hold is the display rate', () => {
  const { viewer, scene } = makeViewer();
  const frame = framePortFor(viewer.scene);
  installRenderGovernor(frame);
  holdContinuousRender('satellites', { maxFps: 15 });
  assert.equal(scene.targetFps, 15);
  holdContinuousRender('flights', { maxFps: 30 });
  assert.equal(scene.targetFps, 30, 'the highest asked');
  holdContinuousRender('flights', { maxFps: 20 });
  assert.equal(scene.targetFps, 20, 'a holder lowering its rate');
  holdContinuousRender('traffic');
  assert.equal(scene.targetFps, 0, 'a hold without a rate: the display rate');
  releaseContinuousRender('traffic');
  assert.equal(scene.targetFps, 20);
  releaseContinuousRender('flights');
  assert.equal(scene.targetFps, 15);
  releaseContinuousRender('satellites');
  assert.equal(scene.targetFps, IDLE_FRAME_RATE);
});

test('the renderer holding the loop itself asks for no rate: the display rate', () => {
  const { viewer, scene } = makeViewer();
  const frame = framePortFor(viewer.scene);
  installRenderGovernor(frame);
  const release = frame.holdContinuous('effects:animated');
  holdContinuousRender('satellites', { maxFps: 15 });
  assert.equal(scene.targetFps, 0);
  release();
  assert.equal(scene.targetFps, 15, 'heard as soon as the renderer lets go');
  const again = frame.holdContinuous('effects:animated');
  assert.equal(scene.targetFps, 0, 'and as soon as it holds again');
  again();
  releaseContinuousRender('satellites');
  assert.equal(scene.targetFps, IDLE_FRAME_RATE);
});

test('a camera carried by a followed target draws at the follow rate unless a pointer steers it', () => {
  const previousWindow = globalThis.window;
  const page = new EventTarget();
  globalThis.window = page;
  try {
    const { viewer, scene } = makeViewer();
    const camera = makeCamera();
    installRenderGovernor(framePortFor(viewer.scene), { camera });
    camera.raise('moveStart');
    assert.equal(scene.targetFps, 0, 'a camera move: the display rate');
    holdContinuousRender('tracked-entity', { maxFps: FOLLOW_FRAME_RATE });
    assert.equal(scene.targetFps, FOLLOW_FRAME_RATE, 'following');
    assert.equal(FOLLOW_FRAME_RATE, 30);
    page.dispatchEvent(new Event('pointerdown'));
    assert.equal(scene.targetFps, 0, 'steering: the display rate');
    page.dispatchEvent(new Event('pointerup'));
    assert.equal(scene.targetFps, FOLLOW_FRAME_RATE);
    releaseContinuousRender('tracked-entity');
    assert.equal(scene.targetFps, 0, 'the camera moving on its own');
    camera.raise('moveEnd');
    assert.equal(scene.targetFps, IDLE_FRAME_RATE);
  } finally {
    _resetRenderGovernorForTest();
    if (previousWindow === undefined) delete globalThis.window;
    else globalThis.window = previousWindow;
  }
});

test('steering ends when the page loses focus, and a wheel moment ending never ends a drag', () => {
  const previousWindow = globalThis.window;
  const page = new EventTarget();
  globalThis.window = page;
  try {
    const timers = fakeTimers();
    const { viewer, scene } = makeViewer();
    installRenderGovernor(framePortFor(viewer.scene), timers);
    holdContinuousRender('tracked-entity', { maxFps: FOLLOW_FRAME_RATE });
    holdContinuousRender('camera');
    page.dispatchEvent(new Event('pointerdown'));
    assert.equal(scene.targetFps, 0, 'dragging: the display rate');
    // Let go over another window: the page never hears the release.
    page.dispatchEvent(new Event('blur'));
    assert.equal(
      scene.targetFps,
      FOLLOW_FRAME_RATE,
      'focus lost: steering ends',
    );
    // A wheel turn, then a drag begun before its moment ends.
    page.dispatchEvent(new Event('wheel'));
    page.dispatchEvent(new Event('pointerdown'));
    timers.run();
    assert.equal(scene.targetFps, 0, 'the drag goes on at the display rate');
    page.dispatchEvent(new Event('pointerup'));
    assert.equal(scene.targetFps, FOLLOW_FRAME_RATE);
  } finally {
    _resetRenderGovernorForTest();
    if (previousWindow === undefined) delete globalThis.window;
    else globalThis.window = previousWindow;
  }
});

test('a pinch steers until its last finger lifts; an element losing focus is not the page losing it', () => {
  const previousWindow = globalThis.window;
  const page = new EventTarget();
  globalThis.window = page;
  try {
    const { viewer, scene } = makeViewer();
    installRenderGovernor(framePortFor(viewer.scene), fakeTimers());
    holdContinuousRender('tracked-entity', { maxFps: FOLLOW_FRAME_RATE });
    holdContinuousRender('camera');
    const pointer = (type, pointerId) =>
      Object.assign(new Event(type), { pointerId });
    page.dispatchEvent(pointer('pointerdown', 1));
    page.dispatchEvent(pointer('pointerdown', 2));
    page.dispatchEvent(pointer('pointerup', 1));
    assert.equal(scene.targetFps, 0, 'one finger still down');
    // The search box's blur reaches the window's capturing listener.
    const field = new EventTarget();
    field.addEventListener('blur', () => {});
    const blur = new Event('blur');
    Object.defineProperty(blur, 'target', { value: field });
    page.dispatchEvent(blur);
    assert.equal(scene.targetFps, 0, 'still steering');
    page.dispatchEvent(pointer('pointerup', 2));
    assert.equal(scene.targetFps, FOLLOW_FRAME_RATE);
  } finally {
    _resetRenderGovernorForTest();
    if (previousWindow === undefined) delete globalThis.window;
    else globalThis.window = previousWindow;
  }
});
