import test from 'node:test';
import assert from 'node:assert/strict';
import {
  DOUBLE_TAP_WINDOW_MS,
  doubleTapVerdict,
  doubleTapWithRetry,
} from './qaDoubleTap.js';

// Review R2: the Sky QA harness may retry a scripted double tap
// only when two pointerups were seen more than 350 ms apart. Missing or extra
// events and in-window non-toggles are real failures and are never retried.

test('qa double tap: the window is the app double-tap window (350 ms)', () => {
  assert.equal(DOUBLE_TAP_WINDOW_MS, 350);
});

test('qa double tap: 0, 1 or 3 pointerups fail at once, toggled or not', () => {
  for (const ups of [[], [100], [100, 160, 220], undefined, null])
    for (const toggled of [false, true]) {
      const v = doubleTapVerdict({ ups, toggled });
      assert.equal(v.verdict, 'fail', JSON.stringify({ ups, toggled }));
      assert.equal(v.gap, null);
      assert.match(v.reason, /expected 2 pointerups, saw \d/);
    }
});

test('qa double tap: invalid timestamp pairs fail', () => {
  for (const ups of [
    [200, 100],
    [NaN, 100],
    [100, Infinity],
    ['100', 160],
  ])
    assert.equal(doubleTapVerdict({ ups, toggled: false }).verdict, 'fail');
});

test('qa double tap: a pair inside the window (<= 350 ms) that does not toggle fails; one that toggles passes', () => {
  for (const gap of [0, 60, 349, 350]) {
    const v = doubleTapVerdict({ ups: [1000, 1000 + gap], toggled: false });
    assert.equal(v.verdict, 'fail', `gap ${gap}`);
    assert.equal(v.gap, gap);
    assert.equal(
      doubleTapVerdict({ ups: [1000, 1000 + gap], toggled: true }).verdict,
      'toggled',
    );
  }
});

test('qa double tap: a pair over the window (> 350 ms) that does not toggle is a retry', () => {
  for (const gap of [351, 739, 5000]) {
    const v = doubleTapVerdict({ ups: [1000, 1000 + gap], toggled: false });
    assert.equal(v.verdict, 'retry', `gap ${gap}`);
    assert.equal(v.gap, gap);
  }
});

const script = (results) => {
  const calls = [];
  const attempt = async (i) => {
    calls.push(i);
    return results[i];
  };
  return { attempt, calls };
};

test('qa double tap retry: missing/extra events stop at the first attempt (no retry)', async () => {
  for (const ups of [[], [10], [10, 70, 130]]) {
    const { attempt, calls } = script([
      { ups, toggled: false },
      { ups: [0, 60], toggled: true },
    ]);
    const r = await doubleTapWithRetry(attempt);
    assert.deepEqual(calls, [0], JSON.stringify(ups));
    assert.equal(r.ok, false);
    assert.equal(r.outcome, 'fail');
    assert.equal(r.tries.length, 1);
  }
});

test('qa double tap retry: an in-window non-toggle stops at once (no retry)', async () => {
  const { attempt, calls } = script([
    { ups: [0, 200], toggled: false },
    { ups: [0, 60], toggled: true },
  ]);
  const r = await doubleTapWithRetry(attempt);
  assert.deepEqual(calls, [0]);
  assert.equal(r.outcome, 'fail');
});

test('qa double tap retry: a slow pair (> 350 ms) is retried and a later toggle passes', async () => {
  const pauses = [];
  const { attempt, calls } = script([
    { ups: [0, 739], toggled: false },
    { ups: [0, 80], toggled: true },
  ]);
  const r = await doubleTapWithRetry(attempt, {
    pause: async (i) => pauses.push(i),
  });
  assert.deepEqual(calls, [0, 1]);
  assert.deepEqual(pauses, [0]);
  assert.equal(r.ok, true);
  assert.equal(r.outcome, 'toggled');
  assert.deepEqual(
    r.tries.map((t) => t.verdict),
    ['retry', 'toggled'],
  );
});

test('qa double tap retry: a slow pair then a missing event fails without further retries', async () => {
  const { attempt, calls } = script([
    { ups: [0, 739], toggled: false },
    { ups: [0], toggled: false },
    { ups: [0, 60], toggled: true },
  ]);
  const r = await doubleTapWithRetry(attempt);
  assert.deepEqual(calls, [0, 1]);
  assert.equal(r.outcome, 'fail');
});

test('qa double tap retry: retries are bounded; only slow pairs exhaust them', async () => {
  const slow = { ups: [0, 800], toggled: false };
  const pauses = [];
  const { attempt, calls } = script([slow, slow, slow, slow, slow]);
  const r = await doubleTapWithRetry(attempt, {
    maxTries: 3,
    pause: async (i) => pauses.push(i),
  });
  assert.deepEqual(calls, [0, 1, 2]);
  assert.deepEqual(pauses, [0, 1], 'no pause after the last attempt');
  assert.equal(r.ok, false);
  assert.equal(r.outcome, 'exhausted');
  assert.equal(r.tries.length, 3);
});
