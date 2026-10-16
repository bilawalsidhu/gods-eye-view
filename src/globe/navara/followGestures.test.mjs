import test from 'node:test';
import assert from 'node:assert/strict';
import { navaraFollowGestures } from './followGestures.js';

const event = (type, fields = {}) =>
  Object.assign(new Event(type, { cancelable: true }), fields);

test('drag turns, wheel scales, and Navara inputs are off until release', () => {
  const canvas = new EventTarget();
  canvas.clientWidth = 1000;
  canvas.clientHeight = 500;
  const win = new EventTarget();
  let suspended = 0;
  const gestures = navaraFollowGestures(
    canvas,
    () => {
      suspended++;
      return () => suspended--;
    },
    win,
  );
  const calls = [];
  const release = gestures({
    orbit: (h, p) => calls.push(['orbit', h, p]),
    zoom: (f) => calls.push(['zoom', f]),
  });
  assert.equal(suspended, 1);
  canvas.dispatchEvent(
    event('pointerdown', { button: 0, clientX: 100, clientY: 100 }),
  );
  win.dispatchEvent(event('pointermove', { clientX: 350, clientY: 225 }));
  win.dispatchEvent(event('pointerup'));
  win.dispatchEvent(event('pointermove', { clientX: 0, clientY: 0 }));
  const wheel = event('wheel', { deltaY: 100 });
  canvas.dispatchEvent(wheel);
  assert.equal(calls.length, 2);
  assert.ok(Math.abs(calls[0][1] + Math.PI / 2) < 1e-12, 'quarter turn');
  assert.ok(Math.abs(calls[0][2] - Math.PI / 4) < 1e-12);
  assert.deepEqual(calls[1], ['zoom', 1.2]);
  assert.equal(wheel.defaultPrevented, true);
  release();
  assert.equal(suspended, 0);
  canvas.dispatchEvent(event('wheel', { deltaY: 100 }));
  assert.equal(calls.length, 2, 'no handling after release');
});
