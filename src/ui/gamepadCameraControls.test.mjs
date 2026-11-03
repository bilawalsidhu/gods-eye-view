import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  applyGamepadDeadzone,
  installGamepadCameraControls,
  readGamepadCameraInput,
} from './gamepadCameraControls.js';

function fakeTarget() {
  const listeners = new Map();
  return {
    tabIndex: -1,
    addEventListener(type, listener) {
      if (!listeners.has(type)) listeners.set(type, new Set());
      listeners.get(type).add(listener);
    },
    removeEventListener(type, listener) {
      listeners.get(type)?.delete(listener);
    },
    dispatch(type, event = {}) {
      for (const listener of listeners.get(type) || []) listener(event);
    },
    listenerCount() {
      return [...listeners.values()].reduce(
        (count, entries) => count + entries.size,
        0,
      );
    },
  };
}

function gamepadFixture() {
  const canvas = fakeTarget();
  const windowRef = fakeTarget();
  const documentRef = fakeTarget();
  const intervals = new Map();
  let nextInterval = 1;
  windowRef.setInterval = (callback) => {
    const id = nextInterval++;
    intervals.set(id, callback);
    return id;
  };
  windowRef.clearInterval = (id) => intervals.delete(id);
  const cameraCalls = [];
  const camera = {
    pitch: -0.5,
    positionCartographic: { height: 10_000 },
    cancelFlight() {
      cameraCalls.push(['cancelFlight']);
    },
    moveRight(distance) {
      cameraCalls.push(['moveRight', distance]);
    },
    moveDown(distance) {
      cameraCalls.push(['moveDown', distance]);
    },
    rotateLeft(angle) {
      cameraCalls.push(['rotateLeft', angle]);
    },
    rotateUp(angle) {
      cameraCalls.push(['rotateUp', angle]);
    },
    moveForward(distance) {
      cameraCalls.push(['moveForward', distance]);
    },
    moveBackward(distance) {
      cameraCalls.push(['moveBackward', distance]);
    },
  };
  const viewer = {
    camera,
    scene: {
      canvas,
      requestRender() {
        cameraCalls.push(['requestRender']);
      },
    },
  };
  let time = 1000;
  const gamepads = [];
  const dispose = installGamepadCameraControls(viewer, {
    windowRef,
    documentRef,
    navigatorRef: { getGamepads: () => gamepads },
    now: () => time,
    interrupt: (reason) => cameraCalls.push(['interrupt', reason]),
  });
  return {
    cameraCalls,
    canvas,
    dispose,
    documentRef,
    gamepads,
    intervals,
    setTime(value) {
      time = value;
    },
    viewer,
    windowRef,
  };
}

test('Xbox stick axes use a remapped deadzone and standard trigger indices', () => {
  assert.equal(applyGamepadDeadzone(0.1), 0);
  assert.equal(applyGamepadDeadzone(-1), -1);
  const input = readGamepadCameraInput({
    axes: [0.5, -0.5, -0.25, 0.25],
    buttons: [...Array(6).fill({ value: 0 }), { value: 0.2 }, { value: 0.8 }],
  });
  assert.ok(Math.abs(input.panX - (0.5 - 0.18) / 0.82) < 1e-12);
  assert.ok(Math.abs(input.panY + (0.5 - 0.18) / 0.82) < 1e-12);
  assert.ok(Math.abs(input.orbitX + (0.25 - 0.18) / 0.82) < 1e-12);
  assert.ok(Math.abs(input.orbitY - (0.25 - 0.18) / 0.82) < 1e-12);
  assert.ok(Math.abs(input.zoom - 0.6) < 1e-12);
});

test('a connected Xbox controller pans, orbits, and zooms the camera', () => {
  const f = gamepadFixture();
  f.gamepads.push({
    connected: true,
    axes: [1, 0, -1, 0],
    buttons: [...Array(6).fill({ value: 0 }), { value: 0 }, { value: 1 }],
  });
  f.windowRef.dispatch('gamepadconnected');
  const tick = [...f.intervals.values()][0];
  assert.equal(typeof tick, 'function');
  tick();
  assert.deepEqual(
    f.cameraCalls.filter(([name]) => name !== 'requestRender'),
    [
      ['interrupt', 'manual-input'],
      ['cancelFlight'],
      ['moveRight', 100],
      ['rotateLeft', 1 / 60],
      ['moveForward', 133.33333333333334],
    ],
  );
  assert.ok(f.cameraCalls.some(([name]) => name === 'requestRender'));
  f.dispose();
});

test('keyboard input is enabled only on the focused globe and cleans up', () => {
  const f = gamepadFixture();
  f.canvas.focus = () => {
    f.documentRef.activeElement = f.canvas;
  };
  f.canvas.dispatch('pointerdown');
  assert.equal(f.documentRef.activeElement, f.canvas);
  assert.equal(f.canvas.tabIndex, 0);
  f.canvas.dispatch('keydown', {
    key: 'w',
    target: f.canvas,
    preventDefault() {},
  });
  const tick = [...f.intervals.values()][0];
  tick();
  assert.ok(
    f.cameraCalls.some(
      ([name, distance]) => name === 'moveDown' && distance < 0,
    ),
  );
  f.dispose();
  assert.equal(f.canvas.tabIndex, -1);
  assert.equal(f.canvas.listenerCount(), 0);
  assert.equal(f.windowRef.listenerCount(), 0);
  assert.equal(f.documentRef.listenerCount(), 0);
  assert.equal(f.intervals.size, 0);
});
