import assert from 'node:assert/strict';
import test from 'node:test';

import { runCameraScript } from './cameraRunner.js';

/** A driver that only keeps the pointer events the runner sends. */
const pointerDriver = () => {
  const events = [];
  return {
    events,
    driver: {
      pointer: async (ev) => {
        events.push(ev);
      },
      frame: async () => {},
    },
  };
};

test('a move starts where the pointer last pressed or moved, not at a wheel or release', async () => {
  const { events, driver } = pointerDriver();
  await runCameraScript(driver, {
    name: 'origins',
    steps: [
      { input: 'down', x: 10, y: 10, button: 1 },
      { input: 'wheel', x: 20, y: 20, deltaY: -100 },
      { input: 'move', x: 30, y: 30 },
      { input: 'up', x: 40, y: 40 },
      { input: 'move', x: 50, y: 50 },
    ],
  });
  const [, wheel, held, up, free] = events;
  assert.deepEqual(wheel.wheel, { deltaY: -100, deltaMode: 0 });
  assert.deepEqual(held.position, { x: 10, y: 10 });
  assert.deepEqual(held.endPosition, { x: 30, y: 30 });
  assert.equal(held.button, 1, 'a move carries the held button');
  assert.equal(up.button, 0);
  assert.deepEqual(free.position, { x: 30, y: 30 });
  assert.equal(free.button, 0, 'nothing is held after the release');
});

test('a first move with no earlier pointer starts where it ends', async () => {
  const { events, driver } = pointerDriver();
  await runCameraScript(driver, {
    name: 'first',
    steps: [{ input: 'move', x: 5, y: 6 }],
  });
  assert.deepEqual(events[0].position, { x: 5, y: 6 });
  assert.deepEqual(events[0].endPosition, { x: 5, y: 6 });
});
