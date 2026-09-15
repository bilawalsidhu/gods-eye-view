import test from 'node:test';
import assert from 'node:assert/strict';
import { createMilitaryFlightLayer } from './index.js';
import { createFlightState } from './state.js';

function services() {
  const names = [
    'picking',
    'sprites',
    'trails',
    'aircraftPresentation',
    'camera',
    'militaryRegistry',
    'labels',
    'groundFloor',
    'meshFloor',
    'geoid',
    'focus',
    'readout',
    'context',
    'render',
    'recession',
  ];
  return {
    ...Object.fromEntries(names.map((name) => [name, {}])),
    groundSnap: { createGroundSnap: () => ({ clear() {} }) },
  };
}

test('military layer instances isolate policy and restoration state without requesting a source', async () => {
  let requests = 0;
  const source = {
    label: 'Fixture aircraft',
    getSnapshot() {
      requests++;
    },
  };
  const first = createMilitaryFlightLayer({ source, services: services() });
  const second = createMilitaryFlightLayer({ source, services: services() });
  first.setParams({ models3dMode: 'all' });
  assert.equal(first.getParams().models3dMode, 'all');
  assert.equal(second.getParams().models3dMode, 'proximity');
  first.testing._setMilitaryTrackingRefreshOutcomeForTest({ ids: [] });
  assert.equal(
    (await first.resolveTrackingRestoreTarget('abc123')).status,
    'missing',
  );
  assert.equal(
    (await second.resolveTrackingRestoreTarget('abc123')).status,
    'source-unavailable',
  );
  assert.equal(requests, 0);
});

test('military source omission fails before viewer initialization', () => {
  const layer = createMilitaryFlightLayer({ services: services() });
  assert.throws(() => layer.init({}), /snapshot source/);
});

test('military state owns separate contact maps, motion scratch and ground sampling', () => {
  const first = createFlightState({ services: services() });
  const second = createFlightState({ services: services() });
  for (const key of [
    'records',
    'feed',
    '_billboards',
    '_positionHistory',
    '_groundSnap',
    '_scratchCarto',
    '_models',
    'lifetime',
  ]) {
    assert.notEqual(first[key], second[key], key);
  }
  assert.notEqual(first.records.data, second.records.data);
  assert.notEqual(first.records.missingPolls, second.records.missingPolls);
  assert.notEqual(first.records.geoidNCache, second.records.geoidNCache);
  assert.notEqual(
    first.feed._activeUpdateControllers,
    second.feed._activeUpdateControllers,
  );
});

test('a normalized source can retain its stale reason without changing standalone cache policy', async () => {
  let reason = 'Source is refreshing';
  const supplied = services();
  supplied.groundFloor.warmGroundFloor = async () => {};
  supplied.meshFloor.sampleMeshFloorCells = () => {};
  supplied.militaryRegistry.registerMilitaryIcaos = () => {};
  const layer = createMilitaryFlightLayer({
    services: supplied,
    source: {
      label: 'Fixture aircraft',
      async getSnapshot() {
        return {
          source: 'Fixture aircraft',
          records: [],
          complete: true,
          observedAtMs: 123000,
          stale: true,
          freshness: 'stale',
          reason,
        };
      },
    },
  });
  await layer.update({});
  assert.equal(layer.getStats().error, reason);
  assert.equal(layer.getStats().lastUpdate, 123000);
  assert.equal(layer.getStats().stale, true);
  reason = null;
  await layer.update({});
  assert.equal(layer.getStats().error, null);
  assert.equal(layer.getStats().stale, true);
});
