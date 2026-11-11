import test from 'node:test';
import assert from 'node:assert/strict';
import { navaraFollowGestures } from './followGestures.js';

const event = (type, fields = {}) =>
  Object.assign(new Event(type, { cancelable: true }), fields);

test('a two-finger pinch while following zooms and does not jerk the heading', () => {
  const canvas = new EventTarget();
  canvas.clientWidth = 400;
  canvas.clientHeight = 800;
  const win = new EventTarget();
  const gestures = navaraFollowGestures(canvas, () => () => {}, win);
  const calls = [];
  const release = gestures({
    orbit: (h, p) => calls.push(['orbit', h, p]),
    zoom: (f) => calls.push(['zoom', f]),
    dolly: (r) => calls.push(['dolly', r]),
  });
  const touch = (type, pointerId, x, y, target = win) =>
    target.dispatchEvent(
      event(type, {
        pointerId,
        pointerType: 'touch',
        isPrimary: pointerId === 1,
        button: type === 'pointermove' ? -1 : 0,
        clientX: x,
        clientY: y,
      }),
    );
  // Two fingers 200 px apart spread out symmetrically (a pinch-out).
  touch('pointerdown', 1, 100, 400, canvas);
  touch('pointerdown', 2, 300, 400, canvas);
  for (let i = 1; i <= 4; i++) {
    touch('pointermove', 1, 100 - 5 * i, 400);
    touch('pointermove', 2, 300 + 5 * i, 400);
  }
  const turn = calls
    .filter(([kind]) => kind === 'orbit')
    .reduce((most, [, h]) => Math.max(most, Math.abs(h)), 0);
  assert.ok(
    turn < 0.2,
    `a pinch turned the heading by up to ${turn.toFixed(2)} rad in one move`,
  );
  assert.ok(
    calls.some(([kind]) => kind === 'zoom' || kind === 'dolly'),
    'a pinch changes the range',
  );
  touch('pointercancel', 2, 320, 400);
  const count = calls.length;
  touch('pointermove', 2, 350, 400);
  assert.equal(
    calls.length,
    count,
    'a cancelled finger no longer moves the camera',
  );
  touch('pointermove', 1, 75, 400);
  assert.equal(
    calls.at(-1)[0],
    'orbit',
    'the remaining finger resumes dragging',
  );
  touch('pointerup', 1, 75, 400);
  const ended = calls.length;
  touch('pointermove', 1, 90, 400);
  assert.equal(calls.length, ended);
  release();
});
