import assert from 'node:assert/strict';
import test from 'node:test';
import { normalizeHeading, roundHeadingDegrees } from './headingDegrees.js';

test('normalizeHeading wraps into [0, 360) and reads a non-finite value as 0', () => {
  assert.equal(normalizeHeading(370), 10);
  assert.equal(normalizeHeading(-10), 350);
  assert.equal(normalizeHeading(720), 0);
  assert.equal(normalizeHeading(Number.NaN), 0);
  assert.equal(normalizeHeading(Infinity), 0);
});

test('roundHeadingDegrees reads 359.5° and above as north, never 360', () => {
  assert.equal(roundHeadingDegrees(359.4), 359);
  assert.equal(roundHeadingDegrees(359.5), 0);
  assert.equal(roundHeadingDegrees(359.6), 0);
  assert.equal(roundHeadingDegrees(360), 0);
  assert.equal(roundHeadingDegrees(0), 0);
  assert.equal(roundHeadingDegrees(194.2), 194);
});

test('roundHeadingDegrees wraps negative and multi-turn bearings', () => {
  assert.equal(Object.is(roundHeadingDegrees(-0.4), 0), true);
  assert.equal(roundHeadingDegrees(-0.6), 359);
  assert.equal(roundHeadingDegrees(-1), 359);
  assert.equal(roundHeadingDegrees(719.6), 0);
  assert.equal(roundHeadingDegrees(-360.6), 359);
});

test('roundHeadingDegrees returns null for a value that is not finite', () => {
  for (const value of [
    Number.NaN,
    Infinity,
    -Infinity,
    null,
    undefined,
    '12',
  ]) {
    assert.equal(roundHeadingDegrees(value), null);
  }
});

test('normalizeHeading keeps a positive bearing just under a half degree', () => {
  assert.equal(roundHeadingDegrees(0.49999999999999), 0);
  assert.equal(roundHeadingDegrees(359.49999999999994), 359);
  assert.equal(normalizeHeading(-1e-15) < 360, true);
});
