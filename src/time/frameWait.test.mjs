import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createFrameWait, MAX_STEP_MS } from './frameWait.js';

function clock() {
  let at = 0;
  return { now: () => at, advance: (ms) => (at += ms) };
}

test('the wait lasts the same time at 60 and 240 frames a second', () => {
  for (const hz of [60, 240]) {
    const c = clock();
    const wait = createFrameWait(2_000, c.now);
    let frames = 0;
    while (!wait.tick()) {
      c.advance(1000 / hz);
      frames += 1;
    }
    assert.ok(Math.abs(c.now() - 2_000) <= 1000 / hz + 1e-6, `${hz} Hz ended at ${c.now()}`);
    assert.ok(frames > 0);
  }
});

test('a long gap between frames adds at most one step', () => {
  const c = clock();
  const wait = createFrameWait(2_000, c.now);
  wait.tick();
  c.advance(60_000);
  assert.equal(wait.tick(), false, 'a background tab does not use the wait up');
  let drawnMs = MAX_STEP_MS;
  while (!wait.tick()) {
    c.advance(16);
    drawnMs += 16;
  }
  assert.ok(drawnMs >= 2_000 && drawnMs < 2_000 + 16 + MAX_STEP_MS);
});

test('after pause the next tick adds nothing', () => {
  const c = clock();
  const wait = createFrameWait(150, c.now);
  wait.tick();
  c.advance(90);
  wait.tick();
  wait.pause();
  c.advance(90);
  assert.equal(wait.tick(), false);
  c.advance(60);
  assert.equal(wait.tick(), true);
});
