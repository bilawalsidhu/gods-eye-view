import test from 'node:test';
import assert from 'node:assert/strict';
import { createAppClock } from '../../time/clock.js';
import { createNavaraClock } from './clock.js';

test('beginFrame latches the app clock', () => {
  let wall = 10_000;
  const appClock = createAppClock({ now: () => wall });
  const { clock, beginFrame } = createNavaraClock({ appClock });
  assert.equal(clock.frameTime(), 10_000);
  wall = 10_016;
  beginFrame();
  wall = 10_020;
  assert.equal(clock.frameTime(), 10_016);
  assert.equal(clock.now(), 10_020);
});
