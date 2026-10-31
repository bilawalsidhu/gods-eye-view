import assert from 'node:assert/strict';
import test from 'node:test';
import {
  DEFAULT_PLAY_RATE,
  SKY_RATES,
  SKY_TIME_MAX_MS,
  SKY_TIME_MIN_MS,
  clampSkyTime,
  createSkyClock,
  createSkyTimeSource,
  normalizeRate,
} from './skyClock.js';

const T0 = Date.parse('2026-10-12T03:30:00Z');

function wall(start = T0) {
  let t = start;
  return {
    now: () => t,
    advance: (ms) => {
      t += ms;
    },
  };
}

test('rates: +/-1, 10, 60, 600, 3600 only; 0 and others rejected', () => {
  assert.deepEqual(SKY_RATES, [1, 10, 60, 600, 3600]);
  for (const r of SKY_RATES) {
    assert.equal(normalizeRate(r), r);
    assert.equal(normalizeRate(-r), -r);
  }
  for (const bad of [0, 2, -5, 7200, NaN, 'x', null])
    assert.equal(normalizeRate(bad), null);
});

test('live reads the wall clock on every call (no drift); fixed holds; play = anchor + wall x rate', () => {
  const w = wall();
  const clock = createSkyClock({ now: w.now });
  assert.equal(clock.mode, 'live');
  assert.equal(clock.getTime(), T0);
  w.advance(1234);
  assert.equal(clock.getTime(), T0 + 1234);
  clock.setFixed(T0);
  w.advance(5000);
  assert.equal(clock.getTime(), T0);
  assert.equal(clock.play({ rate: 3600 }), true);
  assert.equal(clock.mode, 'play');
  assert.equal(clock.playing, true);
  w.advance(1000);
  assert.equal(clock.getTime(), T0 + 3600_000);
  w.advance(23_000);
  assert.equal(clock.getTime(), T0 + 24 * 3600_000, 'x3600: 24 s wall = 1 day');
});

test('negative rate plays backwards; setRate keeps the current time continuous', () => {
  const w = wall();
  const clock = createSkyClock({ now: w.now });
  clock.play({ rate: 60, fromMs: T0 });
  w.advance(10_000);
  assert.equal(clock.getTime(), T0 + 600_000);
  assert.equal(clock.setRate(-600), true);
  assert.equal(clock.getTime(), T0 + 600_000, 'no jump on a speed change');
  w.advance(1000);
  assert.equal(clock.getTime(), T0);
  assert.equal(clock.setRate(5), false, 'invalid speed refused');
  assert.equal(clock.rate, -600);
});

test('pause freezes at the current play time; step moves fixed or playing time; live becomes fixed', () => {
  const w = wall();
  const clock = createSkyClock({ now: w.now });
  assert.equal(clock.step(60_000), true);
  assert.equal(clock.mode, 'fixed');
  assert.equal(clock.getTime(), T0 + 60_000);
  clock.play({ rate: 10 });
  w.advance(6000);
  assert.equal(clock.pause(), true);
  assert.equal(clock.mode, 'fixed');
  assert.equal(clock.getTime(), T0 + 60_000 + 60_000);
  assert.equal(clock.pause(), false, 'pause only acts while playing');
  clock.play();
  assert.equal(clock.rate, 10, 'play keeps the chosen speed');
  clock.step(-3600_000);
  assert.equal(clock.mode, 'play');
  assert.equal(clock.getTime(), T0 + 120_000 - 3600_000);
  clock.setLive();
  assert.equal(clock.getTime(), w.now());
});

test('default play speed is x60', () => {
  const clock = createSkyClock({ now: () => T0 });
  assert.equal(DEFAULT_PLAY_RATE, 60);
  assert.equal(clock.rate, 60);
});

test('subscribe: every mode, speed and step change is announced once; unsubscribe works', () => {
  const w = wall();
  const clock = createSkyClock({ now: w.now });
  const seen = [];
  const off = clock.subscribe((c) => seen.push(`${c.mode}:${c.rate}`));
  clock.setFixed(T0);
  clock.setFixed(T0); // same instant: no event
  clock.play();
  clock.setRate(600);
  clock.step(1000);
  clock.pause();
  clock.setLive();
  clock.setLive(); // already live: no event
  assert.deepEqual(seen, [
    'fixed:60',
    'play:60',
    'play:600',
    'play:600',
    'fixed:600',
    'live:600',
  ]);
  off();
  clock.setFixed(T0 + 1);
  assert.equal(seen.length, 6);
});

test('time range: setFixed/step clamp to 1700..2300; play stops (fixed) at the end and announces it', async () => {
  const w = wall();
  const clock = createSkyClock({ now: w.now });
  clock.setFixed(Date.UTC(1500, 0, 1));
  assert.equal(clock.getTime(), SKY_TIME_MIN_MS);
  clock.setFixed(SKY_TIME_MAX_MS - 1000);
  const seen = [];
  clock.subscribe((c) => seen.push(c.mode));
  clock.play({ rate: 3600 });
  w.advance(10_000);
  assert.equal(clock.getTime(), SKY_TIME_MAX_MS);
  assert.equal(clock.mode, 'fixed');
  await Promise.resolve();
  assert.deepEqual(seen, ['play', 'fixed']);
  assert.equal(clampSkyTime(0), Math.max(0, SKY_TIME_MIN_MS));
});

test('time source: read-only view of the clock; changes are announced', () => {
  const w = wall();
  const clock = createSkyClock({ now: w.now });
  const source = createSkyTimeSource({ clock });
  const seen = [];
  source.subscribe((s) => seen.push(s.mode));
  assert.equal(source.mode, 'live');
  assert.equal(source.moving, true);
  assert.equal(source.rate, 1);
  assert.equal(source.getTime(), T0);
  clock.setFixed(T0 - 1);
  assert.equal(source.mode, 'fixed');
  assert.equal(source.moving, false);
  assert.equal(source.rate, 0);
  assert.equal(source.getTime(), T0 - 1);
  clock.play({ rate: 60 });
  assert.equal(source.rate, 60);
  assert.deepEqual(seen, ['fixed', 'play']);
  source.destroy();
  clock.setLive();
  assert.equal(seen.length, 2, 'destroy unsubscribes');
});

test('time source follows a reverse-playing clock', () => {
  const clock = createSkyClock({ now: () => T0 });
  const source = createSkyTimeSource({ clock });
  clock.play({ rate: -3600 });
  assert.equal(source.mode, 'play');
  assert.equal(source.rate, -3600);
  assert.equal(source.moving, true);
});
