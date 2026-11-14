import assert from 'node:assert/strict';
import test from 'node:test';
import { keepPanelRendering } from './panelRendering.js';

const windowWith = () => {
  const handles = { tick: null, frame: null };
  handles.windowRef = {
    requestAnimationFrame: (fn) => ((handles.frame = fn), 1),
    cancelAnimationFrame: () => (handles.frame = null),
    setInterval: (fn) => ((handles.tick = fn), 1),
    clearInterval: () => (handles.tick = null),
  };
  return handles;
};

test('a panel keeps drawing from a timer while animation frames stop', () => {
  let clock = 0;
  const handles = windowWith();
  const drawn = [];
  const renderer = {
    resize: () => drawn.push('resize'),
    frame: {
      renderNow: (options) =>
        drawn.push(options?.ifDue ? 'loop frame' : 'forced frame'),
    },
  };
  const stop = keepPanelRendering(renderer, {
    windowRef: handles.windowRef,
    now: () => clock,
  });
  // Frames arrive: the render loop draws, so the timer does nothing.
  clock = 100;
  handles.frame();
  handles.tick();
  assert.deepEqual(drawn, []);
  // Frames stop, as in a panel its host reports hidden: the timer draws.
  clock = 400;
  handles.tick();
  // A frame of the loop, as the loop's own: the camera moves, input and
  // the clock run, and it draws when due.
  assert.deepEqual(drawn, ['resize', 'loop frame']);
  stop();
  assert.equal(handles.tick, null);
  assert.equal(handles.frame, null);
});

test('a panel reports a failed frame in full and stops drawing', () => {
  const handles = windowWith();
  let renders = 0;
  const renderer = {
    resize() {},
    frame: {
      renderNow() {
        renders += 1;
        // Workers report plain objects.
        throw { name: 'RuntimeError', message: 'worker failed' };
      },
    },
  };
  const logged = [];
  const original = console.error;
  console.error = (...args) => logged.push(args.join(' '));
  try {
    let clock = 0;
    const stop = keepPanelRendering(renderer, {
      windowRef: handles.windowRef,
      now: () => clock,
    });
    clock = 1000;
    handles.tick();
    assert.match(logged[0], /render error: .*"message":"worker failed"/);
    handles.tick();
    assert.equal(renders, 1, 'no frame after the one that failed');
    stop();
  } finally {
    console.error = original;
  }
});
