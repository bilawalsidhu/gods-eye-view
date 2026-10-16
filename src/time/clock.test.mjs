import assert from 'node:assert/strict';
import test from 'node:test';
import { appClock, createAppClock } from './clock.js';

// A wall clock the test moves by hand.
function manualSource(start = Date.UTC(2026, 9, 16, 12)) {
  let value = start;
  return {
    now: () => value,
    advance(ms) {
      value += ms;
    },
  };
}

test('by default the app clock is the wall clock, exactly', () => {
  const wall = manualSource();
  const clock = createAppClock({ now: wall.now });
  assert.equal(clock.now(), wall.now());
  wall.advance(1234.5);
  assert.equal(clock.now(), wall.now());
});

test('the page clock reads Date.now', () => {
  const before = Date.now();
  const value = appClock.now();
  assert.ok(value >= before && value <= Date.now());
});

test('frameTime is the time latched by beginFrame, one value per frame', () => {
  const wall = manualSource();
  const clock = createAppClock({ now: wall.now });
  // Before the first frame it is the current time.
  assert.equal(clock.frameTime(), wall.now());
  const latched = clock.beginFrame();
  assert.equal(latched, wall.now());
  wall.advance(7);
  assert.equal(clock.frameTime(), latched);
  assert.equal(clock.now(), latched + 7);
  assert.equal(clock.beginFrame(), latched + 7);
  assert.equal(clock.frameTime(), latched + 7);
});

test('freeze holds the time, resume continues from it', () => {
  const wall = manualSource();
  const clock = createAppClock({ now: wall.now });
  const frozenAt = Date.UTC(2020, 0, 1);
  clock.freeze(frozenAt);
  wall.advance(5000);
  assert.equal(clock.now(), frozenAt);
  assert.equal(clock.beginFrame(), frozenAt);
  clock.resume();
  assert.equal(clock.now(), frozenAt);
  wall.advance(250);
  assert.equal(clock.now(), frozenAt + 250);
});

test('freeze without a time holds the current time', () => {
  const wall = manualSource();
  const clock = createAppClock({ now: wall.now });
  const at = wall.now();
  clock.freeze();
  wall.advance(100);
  assert.equal(clock.now(), at);
});

test('offset shifts the clock from the wall clock', () => {
  const wall = manualSource();
  const clock = createAppClock({ now: wall.now });
  clock.offset(-30_000);
  assert.equal(clock.now(), wall.now() - 30_000);
  wall.advance(10);
  assert.equal(clock.now(), wall.now() - 30_000);
  clock.offset(0);
  assert.equal(clock.now(), wall.now());
});

test('rate runs the clock faster or slower without a jump', () => {
  const wall = manualSource();
  const clock = createAppClock({ now: wall.now });
  const start = clock.now();
  clock.rate(4);
  assert.equal(clock.now(), start);
  wall.advance(1000);
  assert.equal(clock.now(), start + 4000);
  clock.rate(0);
  wall.advance(1000);
  assert.equal(clock.now(), start + 4000);
  clock.rate(1);
  wall.advance(500);
  assert.equal(clock.now(), start + 4500);
});

test('a rate set while frozen applies from resume', () => {
  const wall = manualSource();
  const clock = createAppClock({ now: wall.now });
  clock.freeze(1000);
  clock.rate(2);
  wall.advance(400);
  assert.equal(clock.now(), 1000);
  clock.resume();
  wall.advance(400);
  assert.equal(clock.now(), 1800);
});

test('reset returns to the wall clock and reports the state', () => {
  const wall = manualSource();
  const clock = createAppClock({ now: wall.now });
  assert.deepEqual(clock.state(), { frozen: false, offsetMs: 0, rate: 1 });
  clock.rate(3);
  clock.freeze();
  assert.equal(clock.state().frozen, true);
  assert.equal(clock.state().rate, 3);
  clock.reset();
  assert.deepEqual(clock.state(), { frozen: false, offsetMs: 0, rate: 1 });
  assert.equal(clock.now(), wall.now());
});

test('non-finite controls are refused', () => {
  const clock = createAppClock({ now: () => 0 });
  for (const call of [
    () => clock.freeze(Number.NaN),
    () => clock.offset(Number.POSITIVE_INFINITY),
    () => clock.rate('2'),
    () => clock.rate(-1),
  ])
    assert.throws(call, TypeError);
  assert.throws(() => createAppClock({ now: 5 }), TypeError);
});

test('offset ends a freeze and runs on from the wall clock plus the offset', () => {
  const wall = manualSource();
  const clock = createAppClock({ now: wall.now });
  clock.freeze(5);
  clock.offset(1000);
  assert.equal(clock.now(), wall.now() + 1000);
  wall.advance(20);
  assert.equal(clock.now(), wall.now() + 1000);
});

test('the default wall clock is read through Date.now at each call', (t) => {
  const clock = createAppClock();
  t.mock.method(Date, 'now', () => 1_800_000_000_000);
  assert.equal(clock.now(), 1_800_000_000_000);
});
