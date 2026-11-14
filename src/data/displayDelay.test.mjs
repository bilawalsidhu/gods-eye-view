import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createDisplayDelay,
  DISPLAY_DELAY_CAP_MS,
  DISPLAY_DELAY_DEADBAND_MS,
  DISPLAY_DELAY_FALL,
  DISPLAY_DELAY_LAGS,
  DISPLAY_DELAY_MARGIN_MS,
  DISPLAY_DELAY_MIN_LAGS,
  DISPLAY_DELAY_RISE,
} from './displayDelay.js';

// A live feed is drawn far enough behind real time that every contact has a
// report on both sides of the time drawn.

const SEC = 1000;
const FLOOR = 30 * SEC;
const POLL = 30 * SEC;

/**
 * A feed polled every 30 s whose reports arrive `ageMs` old, one new report
 * per contact per poll: each lag is the age plus the poll interval.
 */
function feed(delay, { contacts = 20, polls = 4, ageMs, startMs = 0 }) {
  let now = startMs;
  for (let p = 0; p < polls; p++) {
    now += POLL;
    for (let c = 0; c < contacts; c++) {
      const reportMs = now - ageMs - c * 10;
      delay.noteReport(now, reportMs, reportMs - POLL);
    }
  }
  return now;
}

test('the aim is the 90th percentile of recent lags plus the margin', () => {
  const delay = createDisplayDelay({ floorMs: FLOOR, pollMs: POLL });
  const now = feed(delay, { ageMs: 90 * SEC });
  assert.ok(delay.lagCount >= DISPLAY_DELAY_MIN_LAGS);
  delay.settle(now, { jump: true });
  // Lags 120 s (plus the spread of 0–190 ms): 125 s and a little.
  assert.ok(
    Math.abs(delay.currentMs - (120 * SEC + DISPLAY_DELAY_MARGIN_MS)) < 300,
    `${delay.currentMs}`,
  );
});

test('a fresh feed stays at the floor', () => {
  // Polled every 10 s, reports 2 s old: lags of 12 s, aim 17 s, under the floor.
  const delay = createDisplayDelay({ floorMs: FLOOR, pollMs: 10 * SEC });
  for (let i = 1; i <= 40; i++)
    delay.noteReport(
      i * 10 * SEC,
      i * 10 * SEC - 2 * SEC,
      (i - 1) * 10 * SEC - 2 * SEC,
    );
  assert.equal(delay.settle(400 * SEC, { jump: true }), FLOOR);
});

test('the delay never passes the cap', () => {
  const delay = createDisplayDelay({ floorMs: FLOOR, pollMs: POLL });
  const now = feed(delay, { ageMs: 20 * 60 * SEC });
  assert.equal(delay.settle(now, { jump: true }), DISPLAY_DELAY_CAP_MS);
});

test('before enough lags, first reports stand in: their age plus a poll', () => {
  const delay = createDisplayDelay({ floorMs: FLOOR, pollMs: POLL });
  for (let c = 0; c < 10; c++)
    delay.noteReport(1_000 * SEC, 1_000 * SEC - 90 * SEC);
  assert.equal(delay.lagCount, 0);
  assert.equal(
    delay.settle(1_000 * SEC, { jump: true }),
    90 * SEC + POLL + DISPLAY_DELAY_MARGIN_MS,
  );
});

test('a report that did not move on gives no lag', () => {
  const delay = createDisplayDelay({ floorMs: FLOOR, pollMs: POLL });
  delay.noteReport(100 * SEC, 50 * SEC, 50 * SEC);
  delay.noteReport(100 * SEC, 40 * SEC, 50 * SEC);
  assert.equal(delay.lagCount, 0);
});

test('only the newest lags count', () => {
  const delay = createDisplayDelay({ floorMs: FLOOR, pollMs: POLL });
  let now = feed(delay, {
    ageMs: 200 * SEC,
    contacts: DISPLAY_DELAY_LAGS,
    polls: 1,
  });
  now = feed(delay, {
    ageMs: 10 * SEC,
    contacts: DISPLAY_DELAY_LAGS,
    polls: 1,
    startMs: now,
  });
  assert.ok(delay.settle(now, { jump: true }) < 50 * SEC);
});

test('the delay rises toward its aim at most 0.2 s per second, then holds there', () => {
  const delay = createDisplayDelay({ floorMs: FLOOR, pollMs: POLL });
  const now = feed(delay, { ageMs: 90 * SEC });
  assert.equal(delay.settle(now), FLOOR, 'not jumped once drawing');
  const aim = delay.aimMs;
  let prev = delay.currentMs;
  for (let s = 1; s <= 600; s++) {
    const d = delay.step(now + s * SEC);
    assert.ok(d - prev <= DISPLAY_DELAY_RISE * SEC + 1, `rose ${d - prev} ms`);
    assert.ok(d >= prev);
    prev = d;
  }
  assert.equal(prev, aim);
  // Rising by 0.2 s a second, the time drawn still moves forward at 0.8×.
  assert.ok(DISPLAY_DELAY_RISE < 1);
});

test('the delay falls at most 0.05 s per second', () => {
  const delay = createDisplayDelay({ floorMs: FLOOR, pollMs: POLL });
  let now = feed(delay, { ageMs: 90 * SEC });
  delay.settle(now, { jump: true });
  const high = delay.currentMs;
  now = feed(delay, {
    ageMs: 0,
    polls: 13,
    startMs: now,
  });
  delay.settle(now);
  assert.ok(Math.abs(delay.aimMs - 35 * SEC) < 300, `${delay.aimMs}`);
  const later = delay.step(now + 100 * SEC);
  assert.equal(high - later, DISPLAY_DELAY_FALL * 100 * SEC);
});

test('an aim within the deadband leaves the delay where it is', () => {
  const delay = createDisplayDelay({ floorMs: FLOOR, pollMs: POLL });
  let now = feed(delay, { ageMs: 90 * SEC });
  delay.settle(now, { jump: true });
  const was = delay.currentMs;
  now = feed(delay, {
    ageMs: 90 * SEC + DISPLAY_DELAY_DEADBAND_MS / 2,
    polls: 13,
    startMs: now,
  });
  delay.settle(now);
  assert.equal(delay.aimMs, was);
  assert.equal(delay.step(now + 60 * SEC), was);
});

test('a delivery mid-slew carries on from where the delay is', () => {
  const delay = createDisplayDelay({ floorMs: FLOOR, pollMs: POLL });
  let now = feed(delay, { ageMs: 90 * SEC });
  delay.settle(now);
  const mid = delay.step(now + 100 * SEC);
  now = feed(delay, {
    ageMs: 90 * SEC,
    polls: 1,
    startMs: now + 100 * SEC - POLL,
  });
  assert.equal(delay.settle(now), mid);
});

test('reset forgets the feed', () => {
  const delay = createDisplayDelay({ floorMs: FLOOR, pollMs: POLL });
  const now = feed(delay, { ageMs: 90 * SEC });
  delay.settle(now, { jump: true });
  delay.reset();
  assert.equal(delay.currentMs, FLOOR);
  assert.equal(delay.lagCount, 0);
  assert.equal(delay.settle(now, { jump: true }), FLOOR);
});

test('a delivery after a pause in polling gives no lags, and the next one does', () => {
  const delay = createDisplayDelay({ floorMs: FLOOR, pollMs: POLL });
  let now = feed(delay, { ageMs: 10 * SEC, contacts: 20, polls: 2 });
  const learned = delay.lagCount;
  // A hidden tab: ten minutes with no polls, then a delivery whose reports
  // moved on from ones ten minutes old.
  now += 10 * 60 * SEC;
  for (let c = 0; c < 20; c++)
    delay.noteReport(now, now - 10 * SEC, now - 10 * 60 * SEC);
  assert.equal(delay.lagCount, learned, 'the pause is not the feed’s lateness');
  assert.ok(delay.settle(now, { jump: true }) < 60 * SEC);
  feed(delay, { ageMs: 10 * SEC, contacts: 20, polls: 1, startMs: now });
  assert.equal(delay.lagCount, learned + 20, 'polling again, lags count again');
});
