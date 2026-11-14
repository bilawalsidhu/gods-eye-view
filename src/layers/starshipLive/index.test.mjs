import assert from 'node:assert/strict';
import test from 'node:test';
import { createStarshipLiveLayer } from './index.js';

const snapshot = {
  schemaVersion: 1,
  source: 'SpaceX',
  fetchedAt: 1,
  active: true,
  vehicles: [
    {
      id: 'ship42',
      name: 'Starship Flight 15',
      lat: 25.9968,
      lon: -97.158,
      alt: 95,
      speed: 0,
      heading: 90,
      positionAt: 1,
    },
  ],
  status: { connected: true, t0: 1, serverTime: 1 },
};

function fakeViewer() {
  return {
    dataSources: { add() {}, remove() {} },
    scene: { requestRender() {} },
    trackedEntity: null,
  };
}

test('Starship Live renders a vehicle and exposes row controls', async () => {
  const source = { getSnapshot: async () => snapshot };
  const layer = createStarshipLiveLayer({ source });
  const viewer = fakeViewer();
  layer.init(viewer);
  layer.enable();
  assert.equal(await layer.update(viewer), true);
  const stats = layer.getStats();
  assert.equal(stats.count, 1);
  assert.equal(stats.empty, false);
  const controls = layer.getRowControls();
  assert.equal(controls.list.items.length, 1);
  assert.equal(controls.list.items[0].active, true);
  assert.match(controls.summary.detail, /Starship Flight 15/);
  layer.disable();
  assert.equal(layer.getStats().count, 0);
  layer.destroy();
});

test('Starship Live exposes selected telemetry for object inspection', async () => {
  const source = { getSnapshot: async () => snapshot };
  const layer = createStarshipLiveLayer({ source });
  const viewer = fakeViewer();
  layer.init(viewer);
  layer.enable();
  await layer.update(viewer);
  const info = layer.getInspectionInfo();
  assert.equal(info.id, 'ship42');
  assert.equal(info.label, 'Starship Flight 15');
  assert.equal(info.altitude, 95);
  assert.equal(info.speed, 0);
  assert.equal(info.properties.vehicleId, 'ship42');
  layer.disable();
  layer.destroy();
});

test('Starship Live switches selection and clears tracking on disable', async () => {
  const source = { getSnapshot: async () => snapshot };
  const layer = createStarshipLiveLayer({ source });
  const viewer = fakeViewer();
  layer.init(viewer);
  layer.enable();
  await layer.update(viewer);
  assert.ok(viewer.trackedEntity);
  layer.setParams({ vehicleId: 'ship42' });
  layer.disable();
  assert.equal(viewer.trackedEntity, undefined);
  layer.destroy();
});
test('Starship Live retains the last valid speed when upstream reports zero', async () => {
  const first = {
    ...snapshot,
    vehicles: [{ ...snapshot.vehicles[0], positionAt: 1_000, speed: 100 }],
  };
  const second = {
    ...snapshot,
    vehicles: [
      {
        ...snapshot.vehicles[0],
        lat: 26.0,
        lon: -97.0,
        alt: 200,
        positionAt: 2_000,
        speed: 0,
      },
    ],
  };
  const source = { getSnapshot: async () => first };
  const layer = createStarshipLiveLayer({ source });
  const viewer = fakeViewer();
  layer.init(viewer);
  layer.enable();
  await layer.update(viewer);
  source.getSnapshot = async () => second;
  await layer.update(viewer);
  const info = layer.getInspectionInfo();
  assert.equal(info.properties.speedMps, 100);
  assert.equal(info.speed, 360);
  assert.equal(info.altitudeDisplay, '200 m');
  layer.disable();
  layer.destroy();
});

test('Starship Live does not steal tracking from another layer', async () => {
  const source = { getSnapshot: async () => snapshot };
  const layer = createStarshipLiveLayer({ source });
  const viewer = fakeViewer();
  layer.init(viewer);
  layer.enable();
  await layer.update(viewer);
  const foreign = { id: 'flights:abc' };
  viewer.trackedEntity = foreign;
  await layer.update(viewer);
  assert.equal(viewer.trackedEntity, foreign);
  layer.disable();
  layer.destroy();
});
