import assert from 'node:assert/strict';
import test from 'node:test';
import {
  projectNearbyPlaces,
  projectTextSearchPlaces,
} from '../data/placeProviderPayloads.js';

// Independent spherical oracle: its trigonometric periodicity handles the seam
// without reproducing the implementation's longitude wrapping arithmetic.
function sphericalDistanceM(lat1, lon1, lat2, lon2) {
  const radians = (value) => (value * Math.PI) / 180;
  const a =
    Math.sin(radians(lat2 - lat1) / 2) ** 2 +
    Math.cos(radians(lat1)) *
      Math.cos(radians(lat2)) *
      Math.sin(radians(lon2 - lon1) / 2) ** 2;
  return 6378137 * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

function place(id, latitude, longitude) {
  return {
    id,
    displayName: { text: id },
    types: ['point_of_interest'],
    location: { latitude, longitude },
  };
}

for (const [name, project] of [
  ['nearby', projectNearbyPlaces],
  ['text search', projectTextSearchPlaces],
]) {
  for (const [label, lat, originLon, targetLon] of [
    ['east across Fiji', -16.9, 179.99, -179.99],
    ['west across Fiji', -16.9, -179.99, 179.99],
    ['equivalent seam endpoints', 0, 180, -180],
    ['ordinary Greenwich crossing', -16.9, -0.01, 0.01],
    ['high latitude seam', 89, 179.99, -179.99],
  ]) {
    test(`${name} gives local distance ${label}`, () => {
      const data = { places: [place('landmark', lat, targetLon)] };
      const [result] = project(data, lat, originLon);
      const expected = sphericalDistanceM(lat, originLon, lat, targetLon);
      assert.ok(
        Math.abs(result.distanceM - expected) < 1,
        `${result.distanceM} m differs from spherical ${expected} m`,
      );
    });
  }
}

test('nearby places rank the nearer dateline neighbor first within the same category', () => {
  const data = {
    places: [place('farther', -16.9, 179.95), place('nearer', -16.9, -179.99)],
  };
  const result = projectNearbyPlaces(data, -16.9, 179.99);
  assert.deepEqual(
    result.map((row) => row.id),
    ['nearer', 'farther'],
  );
  assert.ok(result.every((row) => row.distanceM < 5000));
});

test('nearby context priority still takes precedence over local distance', () => {
  const farther = place('landmark', -16.9, 179.95);
  farther.types = ['historical_landmark'];
  const nearer = place('ordinary', -16.9, -179.99);
  assert.deepEqual(
    projectNearbyPlaces({ places: [nearer, farther] }, -16.9, 179.99).map(
      (row) => row.id,
    ),
    ['landmark', 'ordinary'],
  );
});

test('missing coordinates retain the existing unknown-distance sentinel', () => {
  const missing = { id: 'unknown', displayName: { text: 'unknown' } };
  for (const project of [projectNearbyPlaces, projectTextSearchPlaces]) {
    assert.equal(
      project({ places: [missing] }, 0, 0)[0].distanceM,
      Number.MAX_SAFE_INTEGER,
    );
  }
});
