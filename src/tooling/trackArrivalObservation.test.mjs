import test from 'node:test';
import assert from 'node:assert/strict';
import {
  ARRIVAL_OBSERVATION_MS,
  arrivalRotationPassed,
  observeArrivalRotation,
} from './trackArrivalObservation.mjs';

function fixture() {
  let time = 0;
  let state = { shown: true, rotationError: 0 };
  const listeners = new Set();
  const timers = new Map();
  let renders = 0;
  let moveEnds = 0;
  const observation = observeArrivalRotation({
    scene: {
      postRender: {
        addEventListener(listener) {
          listeners.add(listener);
          return () => listeners.delete(listener);
        },
      },
      requestRender() {
        renders++;
      },
    },
    startMoveEnd() {
      moveEnds++;
      state.rotationError = 1.5;
    },
    startReveal() {
      state = { shown: false, rotationError: 1.5 };
    },
    read: () => ({ ...state }),
    now: () => time,
    setTimer(callback, delay) {
      const handle = {};
      timers.set(handle, { callback, at: time + delay });
      return handle;
    },
    clearTimer(handle) {
      timers.delete(handle);
    },
  });
  return {
    observation,
    frame(at, nextState) {
      time = at;
      state = { ...state, ...nextState };
      for (const listener of [...listeners]) listener();
    },
    expire(at) {
      time = at;
      for (const timer of [...timers.values()])
        if (timer.at <= at) timer.callback();
    },
    get resources() {
      return {
        listeners: listeners.size,
        timers: timers.size,
        renders,
        moveEnds,
      };
    },
  };
}

test('80 ms fleet scheduling passes after more than four fast rendered frames', async () => {
  const f = fixture();
  f.frame(8, { shown: true, rotationError: 0 });
  // The forced fleet tick was at 8 ms. A 125 FPS renderer can complete nine
  // more frames before the next 80 ms fleet interval becomes eligible.
  for (let at = 16; at < 88; at += 8) f.frame(at);
  f.frame(88, { shown: true, rotationError: 0 });
  const result = await f.observation;
  assert.equal(result.flipFrame, 10);
  assert.equal(result.moveEndMs, 8);
  assert.equal(result.revealMs, 80);
  assert.equal(result.elapsedMs, 88);
  assert.equal(arrivalRotationPassed(result), true);
  assert.equal(f.resources.listeners, 0);
  assert.equal(f.resources.timers, 0);
  assert.equal(f.resources.moveEnds, 1);
});

test('a wrong first visible angle fails even if the next frame corrects it', async () => {
  const f = fixture();
  f.frame(8, { shown: true, rotationError: 0 });
  f.frame(88, { shown: true, rotationError: 1.5 });
  f.frame(96, { shown: true, rotationError: 0 });
  const result = await f.observation;
  assert.equal(result.dReveal, 1.5);
  assert.equal(result.flipFrame, 1);
  assert.equal(result.elapsedMs, 88);
  assert.equal(arrivalRotationPassed(result), false);
});

test('a wrong first moveEnd angle is retained rather than repaired by reveal', async () => {
  const f = fixture();
  f.frame(8, { shown: true, rotationError: 1.5 });
  f.frame(88, { shown: true, rotationError: 0 });
  const result = await f.observation;
  assert.equal(result.dMoveEnd, 1.5);
  assert.equal(arrivalRotationPassed(result), false);
});

test('no reveal fails at a deadline before the one-second idle catch-up', async () => {
  const f = fixture();
  assert.equal(ARRIVAL_OBSERVATION_MS, 500);
  f.frame(8, { shown: true, rotationError: 0 });
  f.frame(480);
  f.expire(500);
  const result = await f.observation;
  assert.match(result.error, /reveal.*500 ms/);
  assert.equal(arrivalRotationPassed(result), false);
  assert.equal(f.resources.listeners, 0);
  assert.equal(f.resources.timers, 0);
  f.frame(1000, { shown: true, rotationError: 0 });
  assert.equal(result.flipFrame, -1);
});

test('a late visible frame fails even if the timeout callback is delayed', async () => {
  const f = fixture();
  f.frame(8, { shown: true, rotationError: 0 });
  f.frame(501, { shown: true, rotationError: 0 });
  const result = await f.observation;
  assert.match(result.error, /reveal.*500 ms/);
  assert.equal(result.elapsedMs, 501);
  assert.equal(arrivalRotationPassed(result), false);
});

test('the deadline includes moveEnd setup rather than restarting when hidden', async () => {
  const f = fixture();
  f.frame(400, { shown: true, rotationError: 0 });
  f.frame(600, { shown: true, rotationError: 0 });
  const result = await f.observation;
  assert.equal(result.moveEndMs, 400);
  assert.equal(result.elapsedMs, 600);
  assert.equal(arrivalRotationPassed(result), false);
});

test('missing moveEnd frames fail without waiting for a render callback', async () => {
  const f = fixture();
  f.expire(500);
  const result = await f.observation;
  assert.match(result.error, /moveEnd.*500 ms/);
  assert.equal(arrivalRotationPassed(result), false);
  assert.equal(f.resources.listeners, 0);
  assert.equal(f.resources.timers, 0);
});
