import test from 'node:test';
import assert from 'node:assert/strict';
import { EARTH_RADIUS_KM, greatCircleKm, greatCircleMeters } from './geoDistance.js';

test('great-circle distance uses latitude then longitude everywhere', () => {
  const austinToHouston = greatCircleKm(30.2672, -97.7431, 29.7604, -95.3698);
  const ordered = greatCircleKm(10, 80, 20, 70);
  const swapped = greatCircleKm(80, 10, 70, 20);
  assert.ok(austinToHouston > 230 && austinToHouston < 240);
  assert.ok(Math.abs(swapped - ordered) > 300);
});

test('great-circle distance handles identity, antipodes, and metre conversion', () => {
  assert.equal(greatCircleKm(12, 34, 12, 34), 0);
  assert.ok(Math.abs(greatCircleKm(0, 0, 0, 180) - Math.PI * EARTH_RADIUS_KM) < 1e-9);
  assert.equal(greatCircleMeters(0, 0, 1, 0), greatCircleKm(0, 0, 1, 0) * 1000);
});
