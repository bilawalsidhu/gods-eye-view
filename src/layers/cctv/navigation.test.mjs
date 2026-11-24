import assert from 'node:assert/strict';
import test from 'node:test';

import { createNavigation } from './navigation.js';

function fixture() {
  const records = [
    { camera: { id: 'west', lat: 40, lon: -120 } },
    { camera: { id: 'east', lat: 40, lon: -100 } },
  ];
  const state = { _records: records };
  const parts = {
    model: {
      eyePose: () => ({ lat: 40, lon: -101 }),
      haversineKm(lat1, lon1, lat2, lon2) {
        return Math.hypot(lat1 - lat2, lon1 - lon2);
      },
    },
  };
  const navigation = createNavigation({
    state,
    services: {},
    parts,
    source: {},
  });
  return { navigation };
}

test('nearest camera can be resolved from an explicit WGS84 target', () => {
  const { navigation } = fixture();
  assert.equal(navigation.nearestCameraIdToPoint(40, -119), 'west');
  assert.equal(navigation.nearestCameraIdToPoint(40, -101), 'east');
});

test('viewer-nearest delegates to the same target-point owner', () => {
  const { navigation } = fixture();
  assert.equal(navigation.nearestCameraIdToViewer(), 'east');
});

test('invalid target coordinates fail closed', () => {
  const { navigation } = fixture();
  for (const [lat, lon] of [
    [NaN, 0],
    [null, 0],
    [0, Infinity],
    [90.00001, 0],
    [-90.00001, 0],
    [0, 180.00001],
    [0, -180.00001],
  ]) {
    assert.equal(navigation.nearestCameraIdToPoint(lat, lon), null);
  }
});
