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

test('a newly seen military contact appears at its delayed position, not ahead of it', async () => {
  // The military fleet renders RENDER_DELAY_SEC behind real time, so a fresh
  // contact's first displayed position is its fix projected back to that
  // delayed time. Creating the billboard at the raw fix drew it ahead until
  // the next fleet tick jumped it back.
  const Cesium = await import('cesium');
  const { RENDER_DELAY_SEC } = await import('./policy.js');
  // The application's own scene services, as src/app/layers/militaryFlights.js
  // composes them; only the surface samplers and registry are stubbed.
  const supplied = {
    picking: await import('../../data/pickRegistry.js'),
    sprites: await import('../../data/spriteOrder.js'),
    trails: await import('../../data/trailRenderer.js'),
    aircraftPresentation: await import('../../data/tr3bRegistry.js'),
    camera: await import('../../data/trackedCamera.js'),
    labels: await import('../../data/detectionDraw.js'),
    geoid: await import('../../data/geoid.js'),
    focus: await import('../../data/focusDeemphasis.js'),
    readout: await import('../../data/trackedReadout.js'),
    context: await import('../../data/contextStore.js'),
    render: await import('../../renderGovernor.js'),
    recession: await import('../../data/aircraftRecession.js'),
    groundFloor: await import('../../data/groundFloor.js'),
    groundSnap: await import('../../data/groundSnap.js'),
    meshFloor: { sampleMeshFloorCells: () => {} },
    militaryRegistry: { registerMilitaryIcaos: () => {} },
  };
  const fixLon = -97.6;
  const fixLat = 30.3;
  const speedMps = 200;
  const fixAgeMs = 2_000;
  const nowMs = Date.now();
  const layer = createMilitaryFlightLayer({
    services: supplied,
    source: {
      label: 'Fixture aircraft',
      async getSnapshot() {
        return {
          source: 'Fixture aircraft',
          complete: true,
          observedAtMs: nowMs,
          records: [
            {
              id: 'ae0001',
              latitude: fixLat,
              longitude: fixLon,
              onGround: false,
              baroAltitudeM: 9_000,
              courseDeg: 90,
              speedMps,
              positionTimeMs: nowMs - fixAgeMs,
              contactTimeMs: nowMs - fixAgeMs,
            },
          ],
        };
      },
    },
  });
  const added = [];
  layer.testing._setTrackedMilitaryRefreshStateForTest({
    icao24: 'seed00',
    entity: null,
    meta: { rawLat: 0, rawLon: 0, onGround: false },
    billboard: {
      show: false,
      position: Cesium.Cartesian3.fromDegrees(0, 0, 0),
    },
    billboardCollection: {
      show: false,
      add(options) {
        const billboard = { ...options };
        added.push(billboard);
        return billboard;
      },
      remove() {},
    },
    viewer: { camera: { positionCartographic: null }, scene: {} },
    tracked: false,
  });
  await layer.update({ camera: { positionCartographic: null }, scene: {} });
  const billboard = added.find((entry) => entry.id === 'ae0001');
  assert.ok(billboard, 'the new contact gets a billboard');
  const shown = Cesium.Cartographic.fromCartesian(billboard.position);
  const behindM = Cesium.Cartesian3.distance(
    Cesium.Cartesian3.fromRadians(shown.longitude, shown.latitude, 0),
    Cesium.Cartesian3.fromDegrees(fixLon, fixLat, 0),
  );
  const expectedM = speedMps * (RENDER_DELAY_SEC - fixAgeMs / 1000);
  assert.ok(
    Cesium.Math.toDegrees(shown.longitude) < fixLon,
    'drawn behind the fix',
  );
  assert.ok(
    Math.abs(behindM - expectedM) < speedMps * 3,
    `expected about ${Math.round(expectedM)} m behind the fix, got ${Math.round(behindM)} m`,
  );
});
