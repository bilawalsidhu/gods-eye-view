import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createSimulationClock, MAX_RATE } from './clock.js';

function ticking() {
  let wall = 10_000;
  return {
    now: () => wall,
    advance(ms) {
      wall += ms;
    },
  };
}

test('a paused clock holds; play advances at the rate from wall time', () => {
  const wall = ticking();
  const clock = createSimulationClock({ now: wall.now, durationS: 100 });
  assert.equal(clock.timeS(), 0);
  wall.advance(5000);
  assert.equal(clock.timeS(), 0);
  clock.play();
  wall.advance(2000);
  assert.equal(clock.timeS(), 2);
  clock.setRate(4);
  wall.advance(1000);
  assert.equal(clock.timeS(), 6);
  clock.pause();
  wall.advance(60_000);
  assert.equal(clock.timeS(), 6);
  assert.deepEqual(clock.snapshot(), {
    timeS: 6,
    playing: false,
    rate: 4,
    durationS: 100,
    loop: true,
  });
});

test('seek repositions without changing play state; rate is bounded', () => {
  const wall = ticking();
  const clock = createSimulationClock({ now: wall.now, durationS: 100 });
  clock.play();
  clock.seek(50);
  wall.advance(1000);
  assert.equal(clock.timeS(), 51);
  clock.setRate(999);
  assert.equal(clock.rate, MAX_RATE);
  clock.setRate(Number.NaN);
  assert.equal(clock.rate, MAX_RATE);
  clock.seek(-10);
  assert.equal(clock.timeS(), 90, 'negative seeks wrap on a loop');
});

test('a loop wraps at the duration; a finite scenario stops at the end', () => {
  const wall = ticking();
  const loop = createSimulationClock({ now: wall.now, durationS: 10 });
  loop.play();
  wall.advance(25_000);
  assert.equal(loop.timeS(), 5);
  assert.equal(loop.ended(), false);
  const finite = createSimulationClock({
    now: wall.now,
    durationS: 10,
    loop: false,
  });
  finite.play();
  wall.advance(25_000);
  assert.equal(finite.timeS(), 10);
  assert.equal(finite.ended(), true);
});

test('setDuration keeps the current time inside the new bounds', () => {
  const wall = ticking();
  const clock = createSimulationClock({ now: wall.now, durationS: 100 });
  clock.seek(80);
  clock.setDuration(50, false);
  assert.equal(clock.timeS(), 50);
  assert.equal(clock.loop, false);
  clock.setDuration(0);
  clock.play();
  wall.advance(3000);
  assert.equal(clock.timeS(), 53, 'an unbounded clock keeps counting');
});
