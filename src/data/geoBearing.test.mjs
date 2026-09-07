import assert from 'node:assert/strict';
import test from 'node:test';
import { bearingBetweenCoordinates } from './geoBearing.js';

test('great-circle bearing handles cardinal and degenerate points', () => {
  assert.ok(Math.abs(bearingBetweenCoordinates(0, 0, 1, 0)) < 0.001);
  assert.ok(Math.abs(bearingBetweenCoordinates(0, 0, 0, 1) - 90) < 0.001);
  assert.equal(bearingBetweenCoordinates(0, 0, 0, 0), null);
});
