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

test('timed hops stay quiet while manual steps retain their selection intent with Auto-hop on', () => {
  const records = [
    { camera: { id: 'west', lat: 40, lon: -120 } },
    { camera: { id: 'east', lat: 40, lon: -100 } },
  ];
  const state = {
    _enabled: true,
    _autoHop: true,
    _autoHopSec: 10,
    _lastHopAt: 0,
    _activeCameraId: 'west',
    _records: records,
    _recordById: new Map(records.map((record) => [record.camera.id, record])),
    _quietActivation: false,
  };
  const selections = [];
  const parts = {
    model: {
      currentViewContext: () => 'east-region',
      eyePose: () => ({ lat: 40, lon: -101 }),
      haversineKm: (lat1, lon1, lat2, lon2) =>
        Math.hypot(lat1 - lat2, lon1 - lon2),
    },
    selection: {
      setActiveCamera(id) {
        state._activeCameraId = id;
        selections.push({ id, quiet: state._quietActivation });
      },
    },
  };
  const navigation = createNavigation({ state, parts });
  navigation.maybeAutoHop(10_000);
  assert.deepEqual(
    selections.at(-1),
    { id: 'east', quiet: true },
    'timer follows a changed view quietly',
  );
  navigation.maybeAutoHop(20_000);
  assert.deepEqual(
    selections.at(-1),
    { id: 'west', quiet: true },
    'timer cycles quietly',
  );
  // The hop let go of its quiet flag: the manual step after it is not quiet.
  navigation.stepNearbyCamera(-1, { focus: false });
  assert.deepEqual(
    selections.at(-1),
    { id: 'east', quiet: false },
    'manual Previous publishes selection',
  );
  navigation.stepNearbyCamera(1, { focus: false });
  assert.deepEqual(
    selections.at(-1),
    { id: 'west', quiet: false },
    'manual Next publishes selection',
  );
  // The preference stays on: the timer hops again after the manual steps.
  navigation.maybeAutoHop(30_000);
  assert.deepEqual(
    selections.at(-1),
    { id: 'east', quiet: true },
    'the timer keeps hopping',
  );
});
