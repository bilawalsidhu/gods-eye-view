import test from 'node:test';
import assert from 'node:assert/strict';
import { approxDistanceKm, approxDistanceM } from './approxDistance.js';
import { GROUND_FLOOR_CLAMP_RADIUS_KM } from '../layers/flights/recordPolicy.js';

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

test('approxDistanceM measures the short way round the date line', () => {
  const east = { lon: 179.9999, lat: 0 };
  const west = { lon: -179.9999, lat: 0 };
  // 0.0002° of longitude at the equator, not 40,000 km round the other way.
  assert.ok(Math.abs(approxDistanceM(east, west) - 22.264) < 1e-6);
  assert.ok(Math.abs(approxDistanceM(west, east) - 22.264) < 1e-6);
  assert.ok(
    Math.abs(
      approxDistanceM({ lon: 180, lat: 0 }, { lon: -180, lat: 0.0001 }) -
        11.132,
    ) < 1e-6,
    'the two names of the same meridian',
  );
  // Away from the date line nothing changes.
  assert.ok(
    Math.abs(
      approxDistanceM({ lon: 10, lat: 0 }, { lon: 10.001, lat: 0 }) - 111.32,
    ) < 1e-9,
  );
});
