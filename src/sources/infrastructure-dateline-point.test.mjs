import test from 'node:test';
import assert from 'node:assert/strict';
import { areaContains } from '../tools/area.js';
import { featurePoint } from './infrastructureData.js';
test('outline representative points stay at the antimeridian', () => {
  for (const coordinates of [
    [
      [179, 10],
      [-179, 12],
    ],
    [
      [-179, 10],
      [179, 12],
    ],
  ]) {
    const point = featurePoint({
      geometry: { type: 'LineString', coordinates },
    });
    assert.equal(Math.abs(point.lon), 180);
    assert.equal(point.lat, 11);
  }
  assert.deepEqual(
    featurePoint({
      geometry: {
        type: 'LineString',
        coordinates: [
          [10, 20],
          [20, 30],
        ],
      },
    }),
    { lon: 15, lat: 25 },
  );
  assert.deepEqual(
    featurePoint({ geometry: { type: 'Point', coordinates: [180, 0] } }),
    { lon: 180, lat: 0 },
  );
});

test('a Point at 180 preserves inclusion in an area ending at 180', () => {
  const point = featurePoint({
    geometry: { type: 'Point', coordinates: [180, 0] },
  });
  assert.equal(
    areaContains({ west: 170, east: 180, south: -1, north: 1 }, point),
    true,
  );
});
