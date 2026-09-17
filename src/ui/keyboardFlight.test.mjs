import assert from 'node:assert/strict';
import test from 'node:test';
import { bindKeyboardFlight } from './keyboardFlight.js';
import { getRenderGovernorDiagnostics } from '../renderGovernor.js';

function fakeDocument() {
  const listeners = new Map();
  const view = { blur: [] };
  return {
    view,
    defaultView: {
      addEventListener: (type, handler) => view[type]?.push(handler),
      removeEventListener: (type, handler) => {
        view[type] = view[type].filter((h) => h !== handler);
      },
    },
    addEventListener(type, handler, capture) {
      listeners.set(type, { handler, capture });
    },
    removeEventListener(type) {
      listeners.delete(type);
    },
    press(code, extra = {}) {
      const event = {
        code,
        preventDefault() {
          this.prevented = true;
        },
        ...extra,
      };
      listeners.get('keydown')?.handler(event);
      return event;
    },
    release(code) {
      listeners.get('keyup')?.handler({ code });
    },
    listeners,
  };
}

function fakeViewer(height = 1000) {
  const calls = [];
  return {
    calls,
    camera: {
      positionCartographic: { height },
      moveForward: (d) => calls.push(['forward', d]),
      moveBackward: (d) => calls.push(['backward', d]),
      moveLeft: (d) => calls.push(['left', d]),
      moveRight: (d) => calls.push(['right', d]),
      lookLeft: (r) => calls.push(['lookLeft', r]),
      lookRight: (r) => calls.push(['lookRight', r]),
      cancelFlight: () => calls.push(['cancelFlight']),
    },
  };
}

function frames() {
  const queue = [];
  return {
    request: (cb) => (queue.push(cb), queue.length),
    cancel: () => {},
    tick(timestamp) {
      const cb = queue.shift();
      cb?.(timestamp);
    },
    get pending() {
      return queue.length;
    },
  };
}

test('held keys move the camera per frame at a height-scaled rate and hold the render governor', () => {
  const doc = fakeDocument();
  const viewer = fakeViewer(1000);
  const raf = frames();
  const moveStarts = [];
  const flight = bindKeyboardFlight({
    viewer,
    documentRef: doc,
    requestFrame: raf.request,
    cancelFrame: raf.cancel,
    onMoveStart: () => moveStarts.push(1),
  });
  assert.equal(doc.listeners.get('keydown').capture, true, 'capture phase');
  const event = doc.press('KeyW');
  assert.equal(event.prevented, true);
  assert.deepEqual(flight.active(), ['forward']);
  assert.equal(moveStarts.length, 1);
  assert.ok(
    getRenderGovernorDiagnostics().holds?.includes?.('keyboard-flight') ?? true,
  );
  raf.tick(1000);
  raf.tick(1100); // 100 ms at 1000 m -> 0.6 * 1000 * 0.1 = 60 m
  const forward = viewer.calls.filter(([name]) => name === 'forward');
  assert.equal(forward.length, 1);
  assert.ok(Math.abs(forward[0][1] - 60) < 1e-6);
  doc.press('KeyE');
  raf.tick(1200);
  assert.ok(viewer.calls.some(([name]) => name === 'lookRight'));
  doc.release('KeyW');
  doc.release('KeyE');
  assert.deepEqual(flight.active(), []);
  raf.tick(1300);
  assert.equal(raf.pending, 0, 'loop stops when no key is held');
  flight.destroy();
});

test('typing targets, modifiers, a disabled gate and blur all leave the camera alone', () => {
  const doc = fakeDocument();
  const viewer = fakeViewer();
  const raf = frames();
  let enabled = true;
  const search = { id: 'search' };
  const flight = bindKeyboardFlight({
    viewer,
    documentRef: doc,
    searchInput: search,
    isEnabled: () => enabled,
    requestFrame: raf.request,
    cancelFrame: raf.cancel,
  });
  assert.equal(doc.press('KeyW', { target: search }).prevented, undefined);
  assert.equal(
    doc.press('KeyW', { target: { matches: () => true } }).prevented,
    undefined,
  );
  assert.equal(doc.press('KeyW', { ctrlKey: true }).prevented, undefined);
  enabled = false;
  assert.equal(doc.press('KeyW').prevented, undefined);
  assert.equal(
    doc.press('KeyD').prevented,
    undefined,
    'd reaches the detection shortcut',
  );
  enabled = true;
  doc.press('KeyA');
  assert.deepEqual(flight.active(), ['left']);
  for (const handler of doc.view.blur) handler();
  assert.deepEqual(flight.active(), [], 'blur releases stuck keys');
  flight.destroy();
  assert.equal(doc.listeners.size, 0);
  assert.equal(doc.view.blur.length, 0);
});

test('a huge frame gap is clamped so the camera never teleports', () => {
  const doc = fakeDocument();
  const viewer = fakeViewer(1000);
  const raf = frames();
  const flight = bindKeyboardFlight({
    viewer,
    documentRef: doc,
    requestFrame: raf.request,
    cancelFrame: raf.cancel,
  });
  doc.press('KeyS');
  raf.tick(0);
  raf.tick(60_000);
  const [, distance] = viewer.calls.find(([name]) => name === 'backward');
  assert.ok(Math.abs(distance - 60) < 1e-6, 'capped at 0.1 s worth of motion');
  flight.destroy();
});
