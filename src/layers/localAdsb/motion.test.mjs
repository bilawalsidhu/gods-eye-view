import assert from 'node:assert/strict';
import test from 'node:test';

import {
  LOCAL_ADSB_HISTORY_MS,
  LOCAL_ADSB_HISTORY_POINTS,
  LocalAdsbMotion,
} from './motion.js';

function fix(at, lat, overrides = {}) {
  return {
    icao: 'abc123',
    lat,
    lon: 0,
    altitudeFt: 5_000,
    groundSpeedKt: 120,
    trackDeg: 0,
    verticalRateFpm: 0,
    lastPositionAt: at,
    lastMessageAt: at,
    ...overrides,
  };
}

// 120 kt north: degrees of latitude per second.
const STEP = (120 * 1852) / 3600 / 111_195;

test('the heard history is bounded to 600 fixes and 10 minutes', () => {
  const motion = new LocalAdsbMotion();
  for (let second = 0; second < 700; second += 1)
    motion.observe(fix(second * 1_000, second * STEP), second * 1_000);
  assert.equal(motion.fixes.length, LOCAL_ADSB_HISTORY_POINTS);
  assert.equal(motion.fixes[0].at, 100_000);

  const sparse = new LocalAdsbMotion();
  for (let minute = 0; minute < 15; minute += 1) {
    const at = minute * 60_000;
    sparse.observe(fix(at, minute * 60 * STEP), at);
  }
  assert.ok(
    sparse.fixes.at(-1).at - sparse.fixes[0].at <= LOCAL_ADSB_HISTORY_MS,
  );
  assert.equal(sparse.fixes.length, 11);
});

test('repeated and out-of-order fixes do not move the anchor', () => {
  const motion = new LocalAdsbMotion();
  assert.equal(motion.observe(fix(10_000, 0), 10_000), true);
  assert.equal(motion.observe(fix(10_000, 0), 10_500), false);
  assert.equal(motion.observe(fix(9_000, 0), 10_500), false);
  // A feed re-reading the same fix with a jittered, later time.
  assert.equal(motion.observe(fix(10_080, 0), 11_000), false);
  assert.equal(motion.fixes.length, 1);
});

test('coasting stops 10 s after the last message', () => {
  const motion = new LocalAdsbMotion();
  motion.observe(fix(0, 0), 0);
  const coasted = motion.displayAt(30_000).lat;
  assert.ok(Math.abs(coasted - 10 * STEP) < 1e-5, `${coasted}`);
});

test('three refused fixes in a row restart the track from the new stream', () => {
  const motion = new LocalAdsbMotion();
  motion.observe(fix(0, 0), 0);
  for (let index = 1; index <= 2; index += 1)
    assert.equal(motion.observe(fix(index * 1_000, 1 + index * STEP), index * 1_000), false);
  assert.equal(motion.rejectedFixes, 2);
  assert.equal(motion.observe(fix(3_000, 1 + 3 * STEP), 3_000), true);
  assert.equal(motion.rejectedFixes, 3);
  assert.equal(motion.fixes.length, 1, 'the history restarts at the new stream');
  assert.ok(Math.abs(motion.displayAt(3_000).lat - (1 + 3 * STEP)) < 1e-9);
});

test('the last known speed bounds a fix whose record carries none', () => {
  const motion = new LocalAdsbMotion();
  motion.observe(fix(0, 0), 0);
  // 1.2 nm in 10 s (432 kt): under the 1,000 kt unknown-speed cap but far
  // beyond the 120 kt the aircraft last reported.
  assert.equal(
    motion.observe(fix(10_000, 1.2 / 60, { groundSpeedKt: null }), 10_000),
    false,
  );
  assert.equal(motion.rejectedFixes, 1);
});
