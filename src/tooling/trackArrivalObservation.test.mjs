import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import * as arrivalModule from './trackArrivalObservation.mjs';
import {
  ARRIVAL_REVEAL_MAX_FRAMES,
  ARRIVAL_STALL_MS,
  arrivalAngleViolated,
  arrivalRotationPassed,
  observeArrivalRotation,
  observeArrivalRotationWithRetry,
} from './trackArrivalObservation.mjs';

function fixture(start = observeArrivalRotation) {
  let time = 0;
  let state = { shown: true, rotationError: 0 };
  const listeners = new Set();
  const timers = new Map();
  let renders = 0;
  let moveEnds = 0;
  const observation = start({
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

// A settle frame, one frame that draws the contact hidden, then
// ARRIVAL_REVEAL_MAX_FRAMES more hidden frames: the reveal never comes.
function missReveal(f, settleError = 0) {
  f.frame(8, { shown: true, rotationError: settleError });
  f.frame(16, { shown: false, revealStartsNow: true });
  for (let i = 1; i <= ARRIVAL_REVEAL_MAX_FRAMES; i++)
    f.frame(16 + 8 * i, { shown: false, revealStartsNow: false });
}

test('slow frames pass: the settle frame and the next frame are measured, however long they take', async () => {
  // Headless SwiftShader on a busy machine: 650–750 ms between frames.
  const f = fixture();
  f.frame(700, { shown: true, rotationError: 0 });
  f.frame(1400, { shown: true, rotationError: 0 });
  const result = await f.observation;
  assert.equal(result.error, undefined);
  assert.equal(result.moveEndMs, 700);
  assert.equal(result.revealFrame, 1);
  assert.equal(result.revealMs, 700);
  assert.equal(result.elapsedMs, 1400);
  assert.equal(arrivalRotationPassed(result), true);
  assert.equal(f.resources.listeners, 0);
  assert.equal(f.resources.timers, 0);
  assert.equal(f.resources.moveEnds, 1);
});

test('a reveal is counted from the last frame that drew the contact hidden', async () => {
  const f = fixture();
  f.frame(8, { shown: true, rotationError: 0 });
  f.frame(700, { shown: false, revealStartsNow: true });
  f.frame(1400, { shown: false, revealStartsNow: true });
  f.frame(2100, { shown: true, rotationError: 0, revealStartsNow: false });
  const result = await f.observation;
  assert.equal(result.flipFrame, 3);
  assert.equal(result.revealFrame, 1);
  assert.equal(result.hiddenMs, 1392);
  assert.equal(result.revealMs, 700);
  assert.equal(arrivalRotationPassed(result), true);
});

test('a reveal one frame late, behind a frame already in flight, passes', async () => {
  const f = fixture();
  f.frame(8, { shown: true, rotationError: 0 });
  f.frame(16, { shown: false, revealStartsNow: true });
  f.frame(24, { shown: false, revealStartsNow: false });
  f.frame(32, { shown: true, rotationError: 0 });
  const result = await f.observation;
  assert.equal(result.revealFrame, ARRIVAL_REVEAL_MAX_FRAMES);
  assert.equal(arrivalRotationPassed(result), true);
});

test(`a reveal not drawn within ${ARRIVAL_REVEAL_MAX_FRAMES} frames fails`, async () => {
  const f = fixture();
  missReveal(f);
  const result = await f.observation;
  assert.match(
    result.error,
    new RegExp(`reveal not drawn within ${ARRIVAL_REVEAL_MAX_FRAMES} frames`),
  );
  assert.equal(result.dMoveEnd, 0);
  assert.equal(arrivalRotationPassed(result), false);
  assert.equal(f.resources.listeners, 0);
  assert.equal(f.resources.timers, 0);
});

test('a reveal without a hidden-frame mark is counted from the settle frame', async () => {
  const f = fixture();
  f.frame(8, { shown: true, rotationError: 0 });
  f.frame(16, { shown: false });
  f.frame(24, { shown: true, rotationError: 0 });
  const result = await f.observation;
  assert.equal(result.revealFrame, 2);
  assert.equal(result.revealMs, 16);
  assert.equal(result.hiddenMs, 0);
  assert.equal(arrivalRotationPassed(result), true);
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

test('a renderer that draws no settle frame ends the observation', async () => {
  const f = fixture();
  f.expire(ARRIVAL_STALL_MS);
  const result = await f.observation;
  assert.match(
    result.error,
    new RegExp(`moveEnd.*no frame for ${ARRIVAL_STALL_MS} ms`),
  );
  assert.equal(result.moveEndMs, null);
  assert.equal(arrivalRotationPassed(result), false);
  assert.equal(f.resources.listeners, 0);
  assert.equal(f.resources.timers, 0);
});

test('the stall clock restarts on every frame', async () => {
  const f = fixture();
  f.frame(8, { shown: true, rotationError: 0 });
  f.frame(9_000, { shown: false, revealStartsNow: true });
  f.expire(ARRIVAL_STALL_MS + 8);
  // An unmarked hidden frame restarts it too.
  f.frame(18_000, { shown: false, revealStartsNow: false });
  f.expire(ARRIVAL_STALL_MS + 9_000);
  f.frame(27_000, { shown: true, rotationError: 0 });
  const result = await f.observation;
  assert.equal(result.error, undefined);
  assert.equal(result.revealFrame, 2);
  assert.equal(arrivalRotationPassed(result), true);
});

test('a renderer that stops after the settle frame keeps the settle angle', async () => {
  const f = fixture();
  f.frame(8, { shown: true, rotationError: 0 });
  f.expire(ARRIVAL_STALL_MS + 8);
  const result = await f.observation;
  assert.match(result.error, /reveal.*no frame/);
  assert.equal(result.dMoveEnd, 0);
  assert.equal(arrivalRotationPassed(result), false);
});

// Let a retry's next attempt register its postRender listener.
const settle = () => new Promise((resolve) => setImmediate(resolve));

function retryFixture(extra = {}) {
  const counts = { prepares: 0 };
  const f = fixture((options) =>
    observeArrivalRotationWithRetry({
      ...options,
      ...extra,
      async prepare() {
        counts.prepares++;
      },
    }),
  );
  f.counts = counts;
  return f;
}

test('a wrong settle angle followed by a stall is final, not retried into a pass', async () => {
  const f = retryFixture();
  await settle();
  // 0.5 rad ≈ 29°: a real threshold violation on the settle frame.
  f.frame(8, { shown: true, rotationError: 0.5 });
  f.expire(ARRIVAL_STALL_MS + 8);
  await settle();
  // An otherwise clean second attempt, which must never be started.
  f.frame(ARRIVAL_STALL_MS + 16, { shown: true, rotationError: 0 });
  f.frame(ARRIVAL_STALL_MS + 24, { shown: true, rotationError: 0 });
  const result = await f.observation;
  assert.match(result.error, /reveal.*no frame/);
  assert.equal(result.dMoveEnd, 0.5, 'the measured settle angle is kept');
  assert.equal(arrivalAngleViolated(result), true);
  assert.equal(result.attempts, 1);
  assert.equal(f.counts.prepares, 1);
  assert.equal(f.resources.moveEnds, 1);
  assert.equal(arrivalRotationPassed(result), false);
  assert.equal(f.resources.listeners, 0);
  assert.equal(f.resources.timers, 0);
});

test('a missed reveal after a correct settle earns one more attempt', async () => {
  const f = retryFixture();
  await settle();
  missReveal(f);
  await settle();
  f.frame(100, { shown: true, rotationError: 0 });
  f.frame(108, { shown: true, rotationError: 0 });
  const result = await f.observation;
  assert.equal(result.attempts, 2);
  assert.equal(f.counts.prepares, 2);
  assert.equal(f.resources.moveEnds, 2);
  assert.equal(arrivalRotationPassed(result), true);
});

test('a wrong settle angle followed by a missed reveal is final, not retried into a pass', async () => {
  const f = retryFixture();
  await settle();
  missReveal(f, 0.5);
  await settle();
  // An otherwise clean second attempt, which must never be started.
  f.frame(100, { shown: true, rotationError: 0 });
  f.frame(108, { shown: true, rotationError: 0 });
  const result = await f.observation;
  assert.match(result.error, /reveal not drawn/);
  assert.equal(result.dMoveEnd, 0.5, 'the measured settle angle is kept');
  assert.equal(result.attempts, 1);
  assert.equal(f.counts.prepares, 1);
  assert.equal(f.resources.moveEnds, 1);
  assert.equal(arrivalRotationPassed(result), false);
});

test('stalls stop after the attempt limit and still fail', async () => {
  const f = retryFixture();
  await settle();
  f.expire(ARRIVAL_STALL_MS);
  await settle();
  f.expire(2 * ARRIVAL_STALL_MS);
  const result = await f.observation;
  assert.match(result.error, /moveEnd.*no frame/);
  assert.equal(result.attempts, 2);
  assert.equal(arrivalRotationPassed(result), false);
  assert.equal(f.resources.listeners, 0);
  assert.equal(f.resources.timers, 0);
});

test('a wrong first reveal is final: no retry', async () => {
  const f = retryFixture();
  await settle();
  f.frame(8, { shown: true, rotationError: 0 });
  f.frame(88, { shown: true, rotationError: 1.5 });
  const result = await f.observation;
  assert.equal(result.error, undefined);
  assert.equal(result.attempts, 1);
  assert.equal(f.resources.moveEnds, 1);
  assert.equal(arrivalRotationPassed(result), false);
});

test('maxAttempts bounds inconclusive retries', async () => {
  const f = retryFixture({ maxAttempts: 3 });
  for (let attempt = 1; attempt <= 3; attempt++) {
    await settle();
    f.expire(attempt * ARRIVAL_STALL_MS);
  }
  const result = await f.observation;
  assert.equal(result.attempts, 3);
  assert.equal(f.counts.prepares, 3);
  assert.equal(arrivalRotationPassed(result), false);
});

test('a missing angle or reveal frame count never passes', () => {
  const clean = {
    shown: true,
    revealFrame: 1,
    dMoveEnd: 0,
    dReveal: 0,
  };
  assert.equal(arrivalRotationPassed(clean), true);
  for (const field of ['dMoveEnd', 'dReveal', 'revealFrame']) {
    assert.equal(arrivalRotationPassed({ ...clean, [field]: NaN }), false);
    assert.equal(
      arrivalRotationPassed({ ...clean, [field]: undefined }),
      false,
    );
  }
  assert.equal(
    arrivalRotationPassed({
      ...clean,
      revealFrame: ARRIVAL_REVEAL_MAX_FRAMES + 1,
    }),
    false,
  );
});

test('the 10° limit is inclusive', () => {
  const limit = Math.PI / 18;
  assert.equal(arrivalAngleViolated({ dMoveEnd: limit }), true);
  assert.equal(arrivalAngleViolated({ dReveal: limit * 0.999 }), false);
});

test('every name the track harness imports from this module is exported', () => {
  const harness = readFileSync(
    new URL('../../scripts/track-regression.mjs', import.meta.url),
    'utf8',
  );
  const names = [
    ...harness.matchAll(
      /(?:import|const)\s*\{([^}]+)\}\s*(?:from\s*|=\s*await import\()[^;]*trackArrivalObservation\.mjs/g,
    ),
  ].flatMap((match) => match[1].split(',').map((name) => name.trim()));
  assert.ok(names.includes('arrivalRotationPassed'));
  assert.ok(names.includes('observeArrivalRotationWithRetry'));
  for (const name of names)
    assert.equal(typeof arrivalModule[name], 'function', name);
});
