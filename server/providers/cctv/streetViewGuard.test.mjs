import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createStreetViewBudget,
  registeredStreetViewLocation,
} from './streetViewGuard.js';

test('registered cameras require valid geographic coordinates', () => {
  for (const invalid of [
    null,
    { id: 'x', lat: null, lon: 0 },
    { id: 'x', lat: '', lon: 0 },
    { id: 'x', lat: '  ', lon: 0 },
    { id: 'x', lat: 0, lon: '' },
    { id: 'x', lat: 91, lon: 0 },
    { id: 'x', lat: 0, lon: 181 },
    { id: 'x', lat: 'bad', lon: 0 },
    { id: 'x', lat: Infinity, lon: 0 },
    { lat: 10, lon: 20 },
  ]) {
    assert.equal(registeredStreetViewLocation(invalid), null);
  }
  assert.deepEqual(
    registeredStreetViewLocation({
      id: 'registered',
      lat: 10,
      lon: -20,
      headingDeg: -10,
      fovDeg: 900,
      pitchDeg: -900,
    }),
    { lat: 10, lon: -20, heading: 350, fov: 120, pitch: -40 },
  );
  assert.deepEqual(
    registeredStreetViewLocation({ id: 'zero', lat: 0, lon: 0 }),
    { lat: 0, lon: 0, heading: 0, fov: 80, pitch: 0 },
  );
});

test('a shared budget counts attempts and resets at the window', () => {
  let now = 100;
  const budget = createStreetViewBudget({
    now: () => now,
    maxRequests: 2,
    windowMs: 1000,
  });
  assert.equal(budget.consume(), true);
  assert.equal(budget.consume(), true);
  assert.equal(budget.consume(), false);
  now = 1099;
  assert.equal(budget.consume(), false);
  now = 1100;
  assert.equal(budget.consume(), true);
  now = 0;
  assert.equal(budget.consume(), true);
});

test('invalid budget settings fail closed', () => {
  assert.throws(() => createStreetViewBudget({ maxRequests: 0 }), TypeError);
  assert.throws(() => createStreetViewBudget({ windowMs: 0 }), TypeError);
});
