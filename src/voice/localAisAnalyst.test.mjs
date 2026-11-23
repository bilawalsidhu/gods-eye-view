// The hosted model sees an analyst record only through compactAnalystItem,
// which keeps the identity and manifest fields. `validated` and `approx` are
// not among them, so Local AIS withholds the position of a fix that is not
// validated or is approximate. This runs the real analyst_query path.
import assert from 'node:assert/strict';
import test from 'node:test';
import * as Cesium from 'cesium';
import { createGevActionRunner } from './gevActions.js';
import { createLocalAisLayer } from '../layers/localAis/index.js';
import { bindFakeDraw } from '../testSupport/fakeDrawPort.mjs';

const SERVER_NOW = 1_800_000_000_000;
const vessel = (n, extra = {}) => ({
  id: `local-ais:20000000${n}`,
  mmsi: `20000000${n}`,
  name: `TEST ${n}`,
  lat: 30.5,
  lon: -40.5,
  speed: 9.4,
  course: 77,
  validated: true,
  approx: false,
  lastSeenAt: SERVER_NOW - 5000,
  source: 'local-ais',
  ...extra,
});

async function ask(records) {
  globalThis.window = globalThis.window || {
    clearTimeout,
    setTimeout,
    requestIdleCallback: null,
  };
  const viewer = {
    scene: {
      canvas: { addEventListener() {}, removeEventListener() {} },
    },
    clock: { onTick: { addEventListener: () => () => {} } },
    camera: {
      moveEnd: { addEventListener() {} },
      positionWC: Cesium.Cartesian3.fromDegrees(-40.5, 30.5, 1000),
      positionCartographic: {
        height: 300_000,
        latitude: 0.5323,
        longitude: -0.7069,
      },
    },
  };
  bindFakeDraw(viewer);
  const layer = createLocalAisLayer({
    now: () => SERVER_NOW,
    fetchImpl: async () => ({
      ok: true,
      json: async () => ({
        configured: true,
        generatedAt: SERVER_NOW,
        feeds: [
          {
            label: 'AIS receiver 1',
            status: 'live',
            count: records.length,
            dropped: 0,
            rejected: 0,
            heardAt: SERVER_NOW - 5000,
          },
        ],
        records,
      }),
    }),
    overlayHost: { setEntries() {}, setVisible() {} },
  });
  layer.init(viewer);
  layer.enable();
  await layer.update();
  const runner = createGevActionRunner({
    viewer,
    styleManager: {
      activeStyle: 'normal',
      getContextModeState: () => ({ mode: null, active: false }),
      getCockpitState: () => ({ active: false }),
      getControlState: () => null,
    },
    dataManager: {
      layers: new Map([['local-ais', { module: layer }]]),
      isEnabled: (id) => id === 'local-ais',
      getAll: () => [
        {
          id: 'local-ais',
          name: 'Local AIS',
          enabled: true,
          stats: layer.getStats(),
        },
      ],
    },
  });
  try {
    return await runner('analyst_query', {
      layers: ['local-ais'],
      scope: { kind: 'anywhere' },
      limit: 10,
    });
  } finally {
    layer.destroy();
  }
}

test('the voice payload gives a validated fix as a position and withholds a flagged one', async () => {
  const result = await ask([
    vessel(1),
    vessel(2, { validated: false }),
    vessel(3, { approx: true }),
  ]);
  assert.equal(result.ok, true);
  const byMmsi = Object.fromEntries(result.items.map((i) => [i.mmsi, i]));
  assert.deepEqual(Object.keys(byMmsi).sort(), [
    '200000001',
    '200000002',
    '200000003',
  ]);
  assert.equal(byMmsi['200000001'].lat, 30.5);
  assert.equal(byMmsi['200000001'].lon, -40.5);
  for (const mmsi of ['200000002', '200000003']) {
    assert.equal(byMmsi[mmsi].lat, undefined, `${mmsi} must carry no lat`);
    assert.equal(byMmsi[mmsi].lon, undefined, `${mmsi} must carry no lon`);
    assert.equal(byMmsi[mmsi].speedKts, 9.4, 'the vessel is still described');
  }
  // The flags themselves do not reach the model; the withheld position is the
  // only signal, which is why it is default-deny.
  for (const item of result.items) {
    assert.equal('validated' in item, false);
    assert.equal('approx' in item, false);
  }
});

const beacon = (n, kind = 'sart', extra = {}) =>
  vessel(n, {
    id: `local-ais:97000000${n}`,
    mmsi: `97000000${n}`,
    name: '',
    speed: null,
    course: null,
    shipClass: 13,
    beaconType: kind,
    ...extra,
  });

test('the voice payload names a beacon by kind and withholds a flagged beacon position', async () => {
  const result = await ask([
    vessel(1),
    beacon(1, 'sart'),
    beacon(2, 'mob', { validated: false }),
    beacon(3, 'epirb', { approx: true }),
  ]);
  assert.equal(result.ok, true);
  const byMmsi = Object.fromEntries(result.items.map((i) => [i.mmsi, i]));
  assert.equal(byMmsi['970000001'].beaconType, 'sart');
  assert.equal(byMmsi['970000001'].lat, 30.5);
  assert.equal(byMmsi['970000002'].beaconType, 'mob');
  assert.equal(byMmsi['970000003'].beaconType, 'epirb');
  for (const mmsi of ['970000002', '970000003']) {
    assert.equal(byMmsi[mmsi].lat, undefined, `${mmsi} must carry no lat`);
    assert.equal(byMmsi[mmsi].lon, undefined, `${mmsi} must carry no lon`);
  }
  // A vessel is not a beacon.
  assert.ok(!byMmsi['200000001'].beaconType);
  for (const item of result.items) {
    assert.equal('validated' in item, false);
    assert.equal('approx' in item, false);
  }
});

test('only the boolean true validates: 1 and "true" withhold the position', async () => {
  const result = await ask([
    vessel(1, { validated: 1 }),
    vessel(2, { validated: 'true' }),
    beacon(1, 'sart', { validated: 1 }),
    beacon(2, 'sart', { validated: 'true' }),
  ]);
  assert.equal(result.items.length, 4);
  for (const item of result.items) {
    assert.equal(item.lat, undefined, `${item.mmsi} must carry no lat`);
    assert.equal(item.lon, undefined, `${item.mmsi} must carry no lon`);
  }
});
