import test from 'node:test';
import assert from 'node:assert/strict';
import { createGamepadNavigation } from './gamepadNavigation.js';

function createMockViewer() {
  const cameraCalls = [];
  return {
    camera: {
      positionCartographic: { height: 1000 },
      moveForward: (d) =>
        cameraCalls.push({ action: 'moveForward', distance: d }),
      moveBackward: (d) =>
        cameraCalls.push({ action: 'moveBackward', distance: d }),
      moveLeft: (d) => cameraCalls.push({ action: 'moveLeft', distance: d }),
      moveRight: (d) => cameraCalls.push({ action: 'moveRight', distance: d }),
      lookLeft: (a) => cameraCalls.push({ action: 'lookLeft', angle: a }),
      lookRight: (a) => cameraCalls.push({ action: 'lookRight', angle: a }),
      lookUp: (a) => cameraCalls.push({ action: 'lookUp', angle: a }),
      lookDown: (a) => cameraCalls.push({ action: 'lookDown', angle: a }),
      zoomIn: (d) => cameraCalls.push({ action: 'zoomIn', distance: d }),
      zoomOut: (d) => cameraCalls.push({ action: 'zoomOut', distance: d }),
      cancelFlight: () => cameraCalls.push({ action: 'cancelFlight' }),
    },
    scene: {
      preRender: {
        addEventListener: () => () => {},
      },
    },
    cameraCalls,
  };
}

test('sticks within deadzone cause no camera movement and no render holds', () => {
  const viewer = createMockViewer();
  const holds = [];
  const releases = [];
  const mockGamepad = {
    index: 0,
    axes: [0.05, -0.08, 0.1, -0.05],
    buttons: [],
  };

  const nav = createGamepadNavigation({
    viewer,
    deadzone: 0.15,
    navigatorRef: { getGamepads: () => [mockGamepad] },
    holdRender: (id) => holds.push(id),
    releaseRender: (id) => releases.push(id),
  });

  nav.poll(0.016);
  assert.equal(viewer.cameraCalls.length, 0);
  assert.equal(holds.length, 0);
  nav.destroy();
});

test('left stick translates camera forward, backward, left and right', () => {
  const viewer = createMockViewer();
  const holds = [];
  const releases = [];
  let mockGamepad = {
    index: 0,
    axes: [0.8, -0.8, 0, 0], // Move right and forward
    buttons: [],
  };

  const nav = createGamepadNavigation({
    viewer,
    deadzone: 0.15,
    navigatorRef: { getGamepads: () => [mockGamepad] },
    holdRender: (id) => holds.push(id),
    releaseRender: (id) => releases.push(id),
  });

  nav.poll(0.1);
  assert.ok(viewer.cameraCalls.some((c) => c.action === 'moveRight'));
  assert.ok(viewer.cameraCalls.some((c) => c.action === 'moveForward'));
  assert.ok(holds.includes('gamepad-navigation'));

  // Now return sticks to center
  mockGamepad = { index: 0, axes: [0, 0, 0, 0], buttons: [] };
  nav.poll(0.1);
  assert.ok(releases.includes('gamepad-navigation'));
  nav.destroy();
});

test('right stick rotates and tilts camera', () => {
  const viewer = createMockViewer();
  const mockGamepad = {
    index: 0,
    axes: [0, 0, 0.9, -0.9], // Look right and look up
    buttons: [],
  };

  const nav = createGamepadNavigation({
    viewer,
    deadzone: 0.15,
    navigatorRef: { getGamepads: () => [mockGamepad] },
    holdRender: () => {},
    releaseRender: () => {},
  });

  nav.poll(0.1);
  assert.ok(viewer.cameraCalls.some((c) => c.action === 'lookRight'));
  assert.ok(viewer.cameraCalls.some((c) => c.action === 'lookUp'));
  nav.destroy();
});

test('triggers zoom in and zoom out', () => {
  const viewer = createMockViewer();
  const mockGamepad = {
    index: 0,
    axes: [0, 0, 0, 0],
    buttons: [
      null,
      null,
      null,
      null,
      null,
      null,
      { value: 0.8, pressed: true }, // LT: zoom out
      { value: 0.0, pressed: false }, // RT
    ],
  };

  const nav = createGamepadNavigation({
    viewer,
    deadzone: 0.15,
    navigatorRef: { getGamepads: () => [mockGamepad] },
    holdRender: () => {},
    releaseRender: () => {},
  });

  nav.poll(0.1);
  assert.ok(viewer.cameraCalls.some((c) => c.action === 'zoomOut'));
  nav.destroy();
});

test('face buttons dispatch edge-triggered actions once per press', () => {
  const viewer = createMockViewer();
  const actionsCalls = [];
  const actions = {
    toggleHud: () => actionsCalls.push('toggleHud'),
    toggleOrbit: () => actionsCalls.push('toggleOrbit'),
    toggleCleanView: () => actionsCalls.push('toggleCleanView'),
    cycleDetection: () => actionsCalls.push('cycleDetection'),
    toggleCctv: () => actionsCalls.push('toggleCctv'),
    toggleLayers: () => actionsCalls.push('toggleLayers'),
    dismissSearch: () => actionsCalls.push('dismissSearch'),
  };

  const mockGamepad = {
    index: 0,
    axes: [0, 0, 0, 0],
    buttons: [
      { pressed: true, value: 1 }, // Button 0: toggleHud
      { pressed: false, value: 0 },
      { pressed: true, value: 1 }, // Button 2: toggleOrbit
    ],
  };

  const nav = createGamepadNavigation({
    viewer,
    actions,
    navigatorRef: { getGamepads: () => [mockGamepad] },
    holdRender: () => {},
    releaseRender: () => {},
  });

  // First poll: both buttons pressed
  nav.poll(0.016);
  assert.deepEqual(actionsCalls, ['toggleHud', 'toggleOrbit']);

  // Second poll with buttons STILL held: should not re-trigger!
  nav.poll(0.016);
  assert.deepEqual(actionsCalls, ['toggleHud', 'toggleOrbit']);

  // Release button 0
  mockGamepad.buttons[0] = { pressed: false, value: 0 };
  nav.poll(0.016);
  assert.deepEqual(actionsCalls, ['toggleHud', 'toggleOrbit']);

  // Press button 0 again: triggers second time!
  mockGamepad.buttons[0] = { pressed: true, value: 1 };
  nav.poll(0.016);
  assert.deepEqual(actionsCalls, ['toggleHud', 'toggleOrbit', 'toggleHud']);

  nav.destroy();
});

test('connect and disconnect events update controller state and release holds', () => {
  const viewer = createMockViewer();
  const releases = [];
  const listeners = {};
  const mockWindow = {
    addEventListener: (type, fn) => {
      listeners[type] = fn;
    },
    removeEventListener: (type, fn) => {
      delete listeners[type];
    },
  };

  const nav = createGamepadNavigation({
    viewer,
    windowRef: mockWindow,
    navigatorRef: {
      getGamepads: () => [{ index: 2, id: 'Wireless Controller' }],
    },
    releaseRender: (id) => releases.push(id),
  });

  assert.equal(nav.getState().connected, true);
  assert.equal(nav.getState().id, 'Wireless Controller');

  listeners.gamepaddisconnected?.({ gamepad: { index: 2 } });
  nav.destroy();
  assert.equal(Object.keys(listeners).length, 0);
});
