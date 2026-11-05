import test from 'node:test';
import assert from 'node:assert/strict';
import { navaraFollowGestures } from './followGestures.js';

const event = (type, fields = {}) =>
  Object.assign(new Event(type, { cancelable: true }), fields);

test('drag turns and right drag dollies as Cesium tracked camera; wheel scales; inputs off until release', () => {
  const canvas = new EventTarget();
  canvas.clientWidth = 1280;
  canvas.clientHeight = 800;
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
    dolly: (r) => calls.push(['dolly', r]),
  });
  assert.equal(suspended, 1);
  // A 240 px right drag in 12 moves: Cesium turns the heading by
  // 1.77 × 240 / 1280 × 2π = +119.5° (rotate3D at its maximum rate).
  canvas.dispatchEvent(
    event('pointerdown', { button: 0, clientX: 100, clientY: 100 }),
  );
  for (let i = 1; i <= 12; i++)
    win.dispatchEvent(
      event('pointermove', { clientX: 100 + 20 * i, clientY: 100 }),
    );
  win.dispatchEvent(event('pointerup', { button: 0 }));
  const heading = calls
    .filter(([kind]) => kind === 'orbit')
    .reduce((sum, [, h]) => sum + h, 0);
  assert.ok(
    Math.abs((heading * 180) / Math.PI - 119.475) < 0.1,
    `heading ${(heading * 180) / Math.PI}`,
  );
  // A drag down lowers the camera (Cesium rotateUp with a negative angle).
  calls.length = 0;
  canvas.dispatchEvent(
    event('pointerdown', { button: 0, clientX: 100, clientY: 100 }),
  );
  win.dispatchEvent(event('pointermove', { clientX: 100, clientY: 140 }));
  win.dispatchEvent(event('pointerup', { button: 0 }));
  assert.ok(calls[0][2] < 0, 'pitch down');
  assert.ok(Math.abs(calls[0][2] + (1.77 * 40 * Math.PI) / 800) < 1e-12);
  // Cesium rotate3D caps (startX - endX) / width, before the sign
  // reversal into heading. Large right and left drags are asymmetric.
  calls.length = 0;
  canvas.dispatchEvent(
    event('pointerdown', { button: 0, clientX: 0, clientY: 0 }),
  );
  win.dispatchEvent(event('pointermove', { clientX: 640, clientY: 0 }));
  win.dispatchEvent(event('pointerup', { button: 0 }));
  assert.ok(Math.abs(calls[0][1] - 1.77 * 0.5 * 2 * Math.PI) < 1e-12);
  calls.length = 0;
  canvas.dispatchEvent(
    event('pointerdown', { button: 0, clientX: 640, clientY: 0 }),
  );
  win.dispatchEvent(event('pointermove', { clientX: 0, clientY: 0 }));
  win.dispatchEvent(event('pointerup', { button: 0 }));
  assert.ok(Math.abs(calls[0][1] + 1.77 * 0.1 * 2 * Math.PI) < 1e-12);
  // A right drag down: a dolly by the window ratio (Cesium zoom3D).
  calls.length = 0;
  const context = event('contextmenu');
  canvas.dispatchEvent(context);
  assert.equal(
    context.defaultPrevented,
    true,
    'no context menu while following',
  );
  canvas.dispatchEvent(
    event('pointerdown', { button: 2, clientX: 100, clientY: 100 }),
  );
  win.dispatchEvent(event('pointermove', { clientX: 100, clientY: 140 }));
  win.dispatchEvent(event('pointerup', { button: 2 }));
  assert.deepEqual(calls, [['dolly', 40 / 800]]);
  // Moves without a press do nothing; the wheel scales.
  win.dispatchEvent(event('pointermove', { clientX: 0, clientY: 0 }));
  const wheel = event('wheel', { deltaY: 100 });
  canvas.dispatchEvent(wheel);
  assert.deepEqual(calls.at(-1), ['zoom', 1.2]);
  assert.equal(wheel.defaultPrevented, true);
  release();
  assert.equal(suspended, 0);
  const count = calls.length;
  canvas.dispatchEvent(event('wheel', { deltaY: 100 }));
  assert.equal(calls.length, count, 'no handling after release');
});
