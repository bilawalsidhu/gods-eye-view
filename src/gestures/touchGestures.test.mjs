import test from 'node:test';
import assert from 'node:assert/strict';
import { TouchGestureController } from './touchGestures.js';

test('TouchGestureController initializes with safe defaults and attaches listeners', () => {
  const events = [];
  const fakeEl = {
    addEventListener(name, handler) {
      events.push({ action: 'add', name, handler });
    },
    removeEventListener(name, handler) {
      events.push({ action: 'remove', name, handler });
    },
  };

  const controller = new TouchGestureController({ targetEl: fakeEl });
  assert.equal(events.filter((e) => e.action === 'add').length, 4);

  controller.detach();
  assert.equal(events.filter((e) => e.action === 'remove').length, 4);
});

test('TouchGestureController detects 3-finger swipe right', () => {
  let recognized = null;
  const controller = new TouchGestureController({
    targetEl: null,
    onGesture: (g) => {
      recognized = g;
    },
  });

  // Start with 3 touches
  controller._handleTouchStart({
    changedTouches: [
      { identifier: 1, clientX: 100, clientY: 200 },
      { identifier: 2, clientX: 150, clientY: 200 },
      { identifier: 3, clientX: 200, clientY: 200 },
    ],
  });

  assert.equal(controller.startFingerCount, 3);

  // Move 3 touches 100px to the right
  controller._handleTouchMove({
    changedTouches: [
      { identifier: 1, clientX: 200, clientY: 200 },
      { identifier: 2, clientX: 250, clientY: 200 },
      { identifier: 3, clientX: 300, clientY: 200 },
    ],
  });

  assert.ok(recognized);
  assert.equal(recognized.type, 'swipe');
  assert.equal(recognized.direction, 'right');
  assert.equal(recognized.fingers, 3);
});

test('TouchGestureController detects 4-finger pinch in', () => {
  let recognized = null;
  const controller = new TouchGestureController({
    targetEl: null,
    onGesture: (g) => {
      recognized = g;
    },
  });

  // Start with 4 touches spread out from (200, 200)
  controller._handleTouchStart({
    changedTouches: [
      { identifier: 1, clientX: 100, clientY: 200 },
      { identifier: 2, clientX: 300, clientY: 200 },
      { identifier: 3, clientX: 200, clientY: 100 },
      { identifier: 4, clientX: 200, clientY: 300 },
    ],
  });

  assert.equal(controller.startFingerCount, 4);

  // Move 4 touches closer to the center
  controller._handleTouchMove({
    changedTouches: [
      { identifier: 1, clientX: 160, clientY: 200 },
      { identifier: 2, clientX: 240, clientY: 200 },
      { identifier: 3, clientX: 200, clientY: 160 },
      { identifier: 4, clientX: 200, clientY: 240 },
    ],
  });

  assert.ok(recognized);
  assert.equal(recognized.type, 'pinch');
  assert.equal(recognized.direction, 'in');
  assert.equal(recognized.fingers, 4);
});
