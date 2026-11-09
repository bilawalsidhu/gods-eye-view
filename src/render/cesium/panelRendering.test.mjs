import assert from 'node:assert/strict';
import test from 'node:test';
import { keepPanelRendering } from './panelRendering.js';

test('a panel keeps drawing from a timer while animation frames stop', () => {
  let clock = 0;
  let tick = null;
  let frame = null;
  const windowRef = {
    requestAnimationFrame: (fn) => ((frame = fn), 1),
    cancelAnimationFrame: () => (frame = null),
    setInterval: (fn) => ((tick = fn), 1),
    clearInterval: () => (tick = null),
  };
  const drawn = [];
  const viewer = {
    resize: () => drawn.push('resize'),
    render: () => drawn.push('render'),
  };
  const stop = keepPanelRendering(viewer, { windowRef, now: () => clock });
  // Frames arrive: the render loop draws, so the timer does nothing.
  clock = 100;
  frame();
  tick();
  assert.deepEqual(drawn, []);
  // Frames stop, as in a panel its host reports hidden: the timer draws.
  clock = 400;
  tick();
  assert.deepEqual(drawn, ['resize', 'render']);
  stop();
  assert.equal(tick, null);
  assert.equal(frame, null);
});

test('a panel reports a render error in full and stops drawing', () => {
  let listener = null;
  let tick = null;
  const windowRef = {
    requestAnimationFrame: () => 1,
    cancelAnimationFrame() {},
    setInterval: (fn) => ((tick = fn), 1),
    clearInterval() {},
  };
  const drawn = [];
  const viewer = {
    resize() {},
    render: () => drawn.push('render'),
    scene: {
      renderError: {
        addEventListener: (fn) => ((listener = fn), () => (listener = null)),
      },
    },
  };
  const logged = [];
  const original = console.error;
  console.error = (...args) => logged.push(args.join(' '));
  try {
    let clock = 0;
    const stop = keepPanelRendering(viewer, { windowRef, now: () => clock });
    listener(viewer.scene, { name: 'RuntimeError', message: 'worker failed' });
    assert.match(logged[0], /render error: .*"message":"worker failed"/);
    clock = 1000;
    tick();
    assert.deepEqual(drawn, []);
    stop();
    assert.equal(listener, null);
  } finally {
    console.error = original;
  }
});
