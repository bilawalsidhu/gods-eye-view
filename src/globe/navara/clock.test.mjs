import test from 'node:test';
import assert from 'node:assert/strict';
import { isEngineEvent } from '../contract.js';
import { createAppClock } from '../../time/clock.js';
import { createNavaraClock } from './clock.js';

test('beginFrame latches the app clock and raises ticked with the frame time', () => {
  let wall = 10_000;
  const appClock = createAppClock({ now: () => wall });
  const { clock, beginFrame } = createNavaraClock({ appClock });
  assert.ok(isEngineEvent(clock.ticked));
  const seen = [];
  clock.ticked.addEventListener((time) => seen.push(time));
  assert.equal(clock.frameTime(), 10_000);
  wall = 10_016;
  beginFrame();
  wall = 10_020;
  assert.deepEqual(seen, [10_016]);
  assert.equal(clock.frameTime(), 10_016);
  assert.equal(clock.now(), 10_020);
});
