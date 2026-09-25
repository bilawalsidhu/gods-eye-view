import test from 'node:test';
import assert from 'node:assert/strict';
import { makeUnitLimiter } from '../../server/providers/xweather/limit.js';

test('a key may spend up to its budget per window, then nothing until units age out', () => {
  let clock = 0;
  const charge = makeUnitLimiter({
    windowMs: 60_000,
    max: 600,
    globalMax: 3000,
    now: () => clock,
  });
  assert.equal(charge('a', 192), true);
  assert.equal(charge('a', 192), true);
  assert.equal(charge('a', 192), true);
  assert.equal(charge('a', 192), false);
  // A refusal charges nothing: what is left still fits.
  assert.equal(charge('a', 24), true);
  assert.equal(charge('a', 1), false);
  assert.equal(charge('a', 0), true);
  clock += 60_000;
  assert.equal(charge('a', 600), true);
});

test('the global budget caps all keys together', () => {
  const charge = makeUnitLimiter({
    windowMs: 60_000,
    max: 600,
    globalMax: 3000,
    now: () => 0,
  });
  for (let key = 0; key < 5; key++) assert.equal(charge(`k${key}`, 600), true);
  assert.equal(charge('k5', 1), false);
  assert.equal(charge('k0', 0), true);
});
