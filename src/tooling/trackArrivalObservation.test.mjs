import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import * as arrivalModule from './trackArrivalObservation.mjs';
import {
  ARRIVAL_OBSERVATION_MS,
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
  // The reveal budget is measured from the 8 ms settle frame.
  f.expire(508);
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
  f.frame(509, { shown: true, rotationError: 0 });
  const result = await f.observation;
  assert.match(result.error, /reveal.*500 ms/);
  assert.equal(result.elapsedMs, 509);
  assert.equal(arrivalRotationPassed(result), false);
});

test('a slow software renderer passes when each frame stays inside its own budget', async () => {
  // Headless SwiftShader frames run ~300 ms: settle lands at 300 ms and the
  // reveal at 600 ms from moveEnd. Both stay inside the 1 s idle refresh.
  const f = fixture();
  f.frame(300, { shown: true, rotationError: 0 });
  f.expire(500); // the settle frame re-armed the deadline to 800 ms
  f.frame(600, { shown: true, rotationError: 0 });
  const result = await f.observation;
  assert.equal(result.moveEndMs, 300);
  assert.equal(result.revealMs, 300);
  assert.equal(result.elapsedMs, 600);
  assert.equal(result.flipFrame, 1);
  assert.equal(arrivalRotationPassed(result), true);
  assert.equal(f.resources.timers, 0);
});

test('a settle frame later than its budget fails as a moveEnd timeout', async () => {
  const f = fixture();
  f.frame(500, { shown: true, rotationError: 0 });
  const result = await f.observation;
  assert.match(result.error, /moveEnd.*500 ms/);
  assert.equal(result.moveEndMs, null);
  assert.equal(arrivalRotationPassed(result), false);
});

test('a reveal later than its own budget fails even after a fast settle frame', async () => {
  const f = fixture();
  f.frame(400, { shown: true, rotationError: 0 });
  f.frame(901, { shown: true, rotationError: 0 });
  const result = await f.observation;
  assert.match(result.error, /reveal.*500 ms/);
  assert.equal(result.moveEndMs, 400);
  assert.equal(result.elapsedMs, 901);
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

test('a wrong settle angle followed by a reveal timeout is final, not retried into a pass', async () => {
  const f = retryFixture();
  await settle();
  // 0.5 rad ≈ 29°: a real threshold violation on the settle frame.
  f.frame(8, { shown: true, rotationError: 0.5 });
  f.expire(508); // the reveal never comes inside its budget
  await settle();
  // An otherwise clean second attempt, which must never be started.
  f.frame(516, { shown: true, rotationError: 0 });
  f.frame(524, { shown: true, rotationError: 0 });
  const result = await f.observation;
  assert.match(result.error, /reveal.*500 ms/);
  assert.equal(result.dMoveEnd, 0.5, 'the measured settle angle is kept');
  assert.equal(arrivalAngleViolated(result), true);
  assert.equal(result.attempts, 1);
  assert.equal(f.counts.prepares, 1);
  assert.equal(f.resources.moveEnds, 1);
  assert.equal(arrivalRotationPassed(result), false);
  assert.equal(f.resources.listeners, 0);
  assert.equal(f.resources.timers, 0);
});

test('an inconclusive reveal timeout after a correct settle earns one more attempt', async () => {
  const f = retryFixture();
  await settle();
  f.frame(8, { shown: true, rotationError: 0 });
  f.expire(508);
  await settle();
  f.frame(516, { shown: true, rotationError: 0 });
  f.frame(596, { shown: true, rotationError: 0 });
  const result = await f.observation;
  assert.equal(result.attempts, 2);
  assert.equal(f.counts.prepares, 2);
  assert.equal(f.resources.moveEnds, 2);
  assert.equal(arrivalRotationPassed(result), true);
});

test('timeouts stop after the attempt limit and still fail', async () => {
  const f = retryFixture();
  await settle();
  f.expire(500);
  await settle();
  f.expire(1000);
  const result = await f.observation;
  assert.match(result.error, /moveEnd.*500 ms/);
  assert.equal(result.attempts, 2);
  assert.equal(arrivalRotationPassed(result), false);
  assert.equal(f.resources.listeners, 0);
  assert.equal(f.resources.timers, 0);
});

test('a missing or non-finite angle never passes', () => {
  const clean = {
    shown: true,
    moveEndMs: 8,
    revealMs: 80,
    dMoveEnd: 0,
    dReveal: 0,
  };
  assert.equal(arrivalRotationPassed(clean), true);
  for (const field of ['dMoveEnd', 'dReveal']) {
    assert.equal(arrivalRotationPassed({ ...clean, [field]: NaN }), false);
    assert.equal(
      arrivalRotationPassed({ ...clean, [field]: undefined }),
      false,
    );
  }
});

test('a wrong angle on a late reveal frame is final, not retried into a pass', async () => {
  const f = retryFixture();
  await settle();
  f.frame(100, { shown: true, rotationError: 0 });
  // Shown at 600 ms (500 ms after settle) still wearing the tampered nose.
  f.frame(600, { shown: true, rotationError: 1.5 });
  await settle();
  f.frame(608, { shown: true, rotationError: 0 });
  f.frame(688, { shown: true, rotationError: 0 });
  const result = await f.observation;
  assert.match(result.error, /reveal.*500 ms/);
  assert.equal(result.dReveal, 1.5);
  assert.equal(result.attempts, 1);
  assert.equal(f.resources.moveEnds, 1);
  assert.equal(arrivalRotationPassed(result), false);
});

test('a wrong angle on a late settle frame is final, not retried into a pass', async () => {
  const f = retryFixture();
  await settle();
  f.frame(926, { shown: true, rotationError: 1.5 });
  await settle();
  f.frame(934, { shown: true, rotationError: 0 });
  f.frame(1014, { shown: true, rotationError: 0 });
  const result = await f.observation;
  assert.match(result.error, /moveEnd.*500 ms/);
  assert.equal(result.dMoveEnd, 1.5);
  assert.equal(result.attempts, 1);
  assert.equal(arrivalRotationPassed(result), false);
});

test('a late hidden reveal frame records no angle and stays retryable', async () => {
  const f = retryFixture();
  await settle();
  f.frame(8, { shown: true, rotationError: 0 });
  // Still hidden, still tampered: not a measured reveal angle.
  f.frame(600, { shown: false });
  const first = f.observation;
  await settle();
  f.frame(608, { shown: true, rotationError: 0 });
  f.frame(688, { shown: true, rotationError: 0 });
  const result = await first;
  assert.equal(result.attempts, 2);
  assert.equal(result.dReveal, 0);
  assert.equal(arrivalRotationPassed(result), true);
});

test('a late frame with correct angles stays an inconclusive, retryable timeout', async () => {
  const f = retryFixture();
  await settle();
  f.frame(926, { shown: true, rotationError: 0 });
  await settle();
  f.frame(934, { shown: true, rotationError: 0 });
  f.frame(1014, { shown: true, rotationError: 0 });
  const result = await f.observation;
  assert.equal(result.attempts, 2);
  assert.equal(arrivalRotationPassed(result), true);
});

test('a wrong first reveal on time is final: no retry', async () => {
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
    f.expire(attempt * 500);
  }
  const result = await f.observation;
  assert.equal(result.attempts, 3);
  assert.equal(f.counts.prepares, 3);
  assert.equal(arrivalRotationPassed(result), false);
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
