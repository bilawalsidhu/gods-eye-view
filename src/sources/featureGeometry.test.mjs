import assert from 'node:assert/strict';
import test from 'node:test';
import {
  approximateDistanceM,
  nearestPointOnLines,
} from './featureGeometry.js';

test('approximate distance takes the short way round 180°', () => {
  // Lau Islands (-179.0) to Savusavu (179.33): about 178 km apart.
  const across = approximateDistanceM(-17.5, -179.0, -16.78, 179.33);
  assert.ok(across > 150_000 && across < 200_000, String(across));
  assert.equal(
    Math.round(approximateDistanceM(0, 179.9, 0, -179.9)),
    Math.round(approximateDistanceM(0, -0.1, 0, 0.1)),
  );
  // Away from 180° nothing changes.
  assert.equal(Math.round(approximateDistanceM(0, 0, 0, 1)), 111_320);
});

test('nearest point on a crossing stays near the antimeridian, including for a distant query', () => {
  const crossing = [
    [
      [179, 0],
      [-179, 0],
    ],
  ];
  const near = nearestPointOnLines(crossing, 1, -180);
  assert.equal(Math.abs(near.lon), 180);
  assert.equal(near.lat, 0);
  const far = nearestPointOnLines(crossing, 0, 0);
  assert.equal(Math.abs(far.lon), 179);
  assert.ok(far.distanceM > 19_000_000);
});
