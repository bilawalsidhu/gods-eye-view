import test from 'node:test';
import assert from 'node:assert/strict';
import {
  formatCockpitDistance,
  formatCockpitWindDirection,
  tleAgeParts,
} from './cockpitPresentation.js';

test('wind just west of north reads 0°, not 360°', () => {
  assert.equal(formatCockpitWindDirection(90), 'E · 90°');
  assert.equal(formatCockpitWindDirection(0), 'N · 0°');
  assert.equal(formatCockpitWindDirection(359.4), 'N · 359°');
  assert.equal(formatCockpitWindDirection(359.6), 'N · 0°');
});

test('a cockpit distance that rounds to 10.0 km drops the decimal', () => {
  assert.match(formatCockpitDistance(9949), /^9\.9\s?KM$/);
  assert.match(formatCockpitDistance(9960), /^10\s?KM$/);
});

test('a TLE age reads under an hour, then whole hours, then whole days', () => {
  const HOUR = 3_600_000;
  assert.deepEqual(tleAgeParts(0), { unit: 'under-hour' });
  assert.deepEqual(tleAgeParts(59 * 60_000), { unit: 'under-hour' });
  assert.deepEqual(tleAgeParts(HOUR), { unit: 'hours', value: 1 });
  assert.deepEqual(tleAgeParts(13.9 * HOUR), { unit: 'hours', value: 13 });
  assert.deepEqual(tleAgeParts(24 * HOUR - 1), { unit: 'hours', value: 23 });
  assert.deepEqual(tleAgeParts(24 * HOUR), { unit: 'days', value: 1 });
  assert.deepEqual(tleAgeParts(50 * HOUR), { unit: 'days', value: 2 });
  // A clock a little behind the epoch is still fresh, not negative.
  assert.deepEqual(tleAgeParts(-5 * 60_000), { unit: 'under-hour' });
  assert.equal(tleAgeParts(null), null);
  assert.equal(tleAgeParts(Number.NaN), null);
});
