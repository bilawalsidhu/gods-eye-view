import test from 'node:test';
import assert from 'node:assert/strict';
import {
  approxDistanceKm,
  GROUND_FLOOR_CLAMP_RADIUS_KM,
} from './recordPolicy.js';

test('approximate distance takes the short way across the antimeridian', () => {
  // 0.2° of longitude at Taveuni, Fiji (16.8° S) is about 21 km.
  for (const [lon1, lon2] of [
    [179.9, -179.9],
    [-179.9, 179.9],
  ]) {
    const km = approxDistanceKm(-16.8, lon1, -16.8, lon2);
    assert.ok(Math.abs(km - 21.31) < 0.01, `${lon1} → ${lon2}: ${km} km`);
    assert.ok(km <= GROUND_FLOOR_CLAMP_RADIUS_KM);
  }
});
