import test from 'node:test';
import assert from 'node:assert/strict';
import { createMilitaryFlightLayer } from './index.js';
import { createFlightState } from './state.js';
import { layerFeedState } from '../../data/feedState.js';

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

test('military layer sends the camera anchor with a 600 nm radius only in a regional view and reads DEGRADED from the proxy status', async () => {
  const queries = [];
  const supplied = services();
  supplied.groundFloor.warmGroundFloor = async () => {};
  supplied.meshFloor.sampleMeshFloorCells = () => {};
  supplied.militaryRegistry.registerMilitaryIcaos = () => {};
  const layer = createMilitaryFlightLayer({
    services: supplied,
    source: {
      label: 'adsb.lol',
      async getSnapshot(query) {
        queries.push(query);
        return {
          source: 'adsb.fi',
          coverage: '600nm around 30,-97',
          records: [],
          complete: true,
          observedAtMs: 123000,
          stale: false,
          freshness: 'current',
          providerStatus: 'degraded',
          providerError: 'adsb.lol HTTP 502 - adsb.fi feed',
        };
      },
    },
  });
  const viewer = (height) => ({
    camera: {
      positionCartographic: {
        latitude: (30 * Math.PI) / 180,
        longitude: (-97 * Math.PI) / 180,
        height,
      },
    },
  });
  await layer.update(viewer(500_000));
  assert.equal(queries[0].radiusNm, 600, 'regional view (below 2,000 km)');
  assert.ok(Math.abs(queries[0].latitude - 30) < 1e-9);
  assert.ok(Math.abs(queries[0].longitude + 97) < 1e-9);
  await layer.update(viewer(2_000_000));
  assert.equal(
    queries[1].radiusNm,
    undefined,
    'globe view keeps the worldwide list',
  );
  assert.ok(Math.abs(queries[1].latitude - 30) < 1e-9);
  await layer.update({});
  assert.deepEqual(queries[2], {}, 'no camera → no anchor');
  const stats = layer.getStats();
  assert.equal(stats.providerStatus, 'degraded');
  assert.equal(stats.providerError, 'adsb.lol HTTP 502 - adsb.fi feed');
  assert.equal(stats.source, 'adsb.fi');
  assert.equal(stats.coverage, '600nm around 30,-97');
  assert.equal(
    stats.error,
    null,
    'current data never trips the LOAD FAILED chip',
  );
  assert.equal(stats.fallback, true);
  assert.equal(stats.stale, false);
  assert.equal(layerFeedState(stats), 'degraded');
  assert.equal(layer.source, 'adsb.fi');
});
