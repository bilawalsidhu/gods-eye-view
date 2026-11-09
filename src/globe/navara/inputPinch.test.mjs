import test from 'node:test';
import assert from 'node:assert/strict';
import { createNavaraInput } from './input.js';

function fakeCanvas() {
  const canvas = new EventTarget();
  canvas.getBoundingClientRect = () => ({ left: 100, top: 50 });
  canvas.listenerCount = 0;
  const add = canvas.addEventListener.bind(canvas);
  const remove = canvas.removeEventListener.bind(canvas);
  canvas.addEventListener = (...args) => {
    canvas.listenerCount++;
    add(...args);
  };
  canvas.removeEventListener = (...args) => {
    canvas.listenerCount--;
    remove(...args);
  };
  return canvas;
}

const pointer = (type, x, y, extra = {}) =>
  Object.assign(new Event(type), {
    clientX: x,
    clientY: y,
    button: 0,
    shiftKey: false,
    ctrlKey: false,
    altKey: false,
    ...extra,
  });

function setup() {
  const canvas = fakeCanvas();
  const cameraOptions = [];
  const view = {
    canvas,
    camera: {
      set options(value) {
        cameraOptions.push(value);
      },
    },
  };
  const { input, destroy } = createNavaraInput(view);
  return { canvas, input, destroy, cameraOptions };
}

test('a pinch whose still finger lifts first is not a click', async () => {
  const { canvas, input, destroy } = setup();
  let clicks = 0;
  input.on('click', () => clicks++);
  const touch = (type, id, x, y) =>
    pointer(type, x, y, {
      pointerId: id,
      pointerType: 'touch',
      isPrimary: id === 1,
    });
  canvas.dispatchEvent(touch('pointerdown', 1, 100, 300));
  canvas.dispatchEvent(touch('pointerdown', 2, 300, 300));
  // Only the first finger moves (a one-sided pinch).
  for (let i = 1; i <= 5; i++)
    canvas.dispatchEvent(touch('pointermove', 1, 100 - 20 * i, 300));
  canvas.dispatchEvent(touch('pointerup', 2, 300, 300));
  canvas.dispatchEvent(touch('pointerup', 1, 0, 300));
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(clicks, 0);
  canvas.dispatchEvent(touch('pointerdown', 1, 100, 300));
  canvas.dispatchEvent(touch('pointercancel', 1, 100, 300));
  canvas.dispatchEvent(touch('pointerup', 1, 100, 300));
  await Promise.resolve();
  assert.equal(clicks, 0, 'a cancelled pointer cannot click');
  canvas.dispatchEvent(touch('pointerdown', 1, 100, 300));
  canvas.dispatchEvent(touch('pointerup', 1, 100, 300));
  await Promise.resolve();
  assert.equal(clicks, 1, 'the next single tap still clicks');
  destroy();
});

test('a mouse released off the canvas does not hold back the next tap', async () => {
  const { canvas, input, destroy } = setup();
  let clicks = 0;
  input.on('click', () => clicks++);
  // The mouse goes down on the globe and up outside it.
  canvas.dispatchEvent(
    pointer('pointerdown', 100, 300, { pointerId: 1, isPrimary: true }),
  );
  canvas.dispatchEvent(
    pointer('pointerdown', 100, 300, {
      pointerId: 7,
      pointerType: 'touch',
      isPrimary: true,
    }),
  );
  canvas.dispatchEvent(
    pointer('pointerup', 100, 300, {
      pointerId: 7,
      pointerType: 'touch',
      isPrimary: true,
    }),
  );
  await Promise.resolve();
  assert.equal(clicks, 1);
  destroy();
});
