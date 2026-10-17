import test from 'node:test';
import assert from 'node:assert/strict';
import { createControls as bikeshareControls } from '../layers/bikeshare/controls.js';
import { createControls as launchControls } from '../layers/launches/controls.js';
import { createControls as installationControls } from '../layers/installations/controls.js';
import { createQueries as transitQueries } from '../layers/transit/queries.js';
import { createCyclonesLayer } from '../layers/cyclones/index.js';
import { ANALYST_LAYERS } from '../data/analystEngine.js';

/** Every declared analyst field must be a key the accessor actually emits. */
function assertDeclaredFields(layerId, record) {
  const layer = ANALYST_LAYERS[layerId];
  for (const field of [
    ...layer.numeric,
    ...layer.text,
    ...layer.flags,
    ...layer.time,
  ])
    assert.ok(Object.hasOwn(record, field), `${layerId} record lacks ${field}`);
  assert.equal(typeof record.lat, 'number');
  assert.equal(typeof record.lon, 'number');
}

test('bikeshare stations join coordinates from station information', () => {
  const state = {
    _enabled: true,
    _stationRenderMap: new Map([
      [
        'austin:1',
        {
          cityId: 'austin',
          stationId: '1',
          stationName: 'Congress',
          bikesAvailable: 4,
          docksAvailable: 6,
          capacity: 10,
          isRenting: true,
        },
      ],
      [
        'austin:2',
        {
          cityId: 'austin',
          stationId: '2',
          stationName: 'No coordinates',
          bikesAvailable: 1,
        },
      ],
    ]),
    _stationInfoCache: new Map([
      ['austin', new Map([['1', { lat: 30.27, lon: -97.74 }]])],
    ]),
  };
  const { methods } = bikeshareControls({ state, parts: {} });
  const rows = methods.getAnalystRecords();
  assert.equal(
    rows.length,
    1,
    'a station without coordinates is not countable',
  );
  assert.deepEqual(rows[0], {
    id: 'Congress',
    name: 'Congress',
    city: 'austin',
    lat: 30.27,
    lon: -97.74,
    bikesAvailable: 4,
    docksAvailable: 6,
    capacity: 10,
    renting: true,
  });
  assertDeclaredFields('bikeshare', rows[0]);
  state._enabled = false;
  assert.deepEqual(methods.getAnalystRecords(), []);
});

test('launches carry time and hours until launch', () => {
  const at = Date.now() + 5 * 3_600_000;
  const state = {
    _enabled: true,
    _launches: [
      {
        id: 'L1',
        name: 'Falcon 9 | Starlink',
        provider: 'SpaceX',
        status: 'Go',
        launchSite: 'SLC-40',
        missionName: 'Starlink',
        lat: 28.56,
        lon: -80.58,
        launchTime: new Date(at).toISOString(),
      },
    ],
  };
  const { methods } = launchControls({ state, parts: {} });
  const [row] = methods.getAnalystRecords();
  assert.equal(row.launchTimeMs, at);
  assert.equal(row.hoursUntil, 5);
  assertDeclaredFields('rocket-launches', row);
});

test('mapped installations flatten latitude/longitude', () => {
  const state = {
    enabled: true,
    records: [
      {
        id: 'node/1',
        name: 'Fort Example',
        class: 'military_land',
        kind: 'installation',
        latitude: 31,
        longitude: -97,
      },
    ],
  };
  const { methods } = installationControls({ state, parts: {} });
  const [row] = methods.getAnalystRecords();
  assert.deepEqual(row, {
    id: 'Fort Example',
    name: 'Fort Example',
    class: 'military_land',
    kind: 'installation',
    lat: 31,
    lon: -97,
  });
  assertDeclaredFields('military-installations', row);
});

test('transit vehicles report their last fix, mode and route', () => {
  const state = {
    _enabled: true,
    _vehicles: new Map([
      [
        'cap:1',
        {
          key: 'cap:1',
          mode: 'bus',
          courseDeg: 90,
          record: {
            id: '1',
            label: '2554',
            routeId: '335',
            lat: 30.2,
            lon: -97.7,
            speedMps: 8,
            status: 'IN_TRANSIT_TO',
            occupancy: null,
          },
        },
      ],
    ]),
  };
  const { methods } = transitQueries({ state, parts: {} });
  const [row] = methods.getAnalystRecords();
  assert.equal(row.id, '2554');
  assert.equal(row.mode, 'bus');
  assertDeclaredFields('transit', row);
});

test('cyclones flatten the storm position and stay empty while off', async () => {
  const storm = {
    id: 'al052026',
    name: 'Fay',
    classification: 'TS',
    basin: 'AL',
    position: { latitude: 29.8, longitude: -40 },
    windKt: 35,
    pressureHpa: 1010,
    issuedAt: '2026-09-23T00:00:00Z',
    forecastPoints: [],
    track: null,
    cone: null,
  };
  const layer = createCyclonesLayer({
    feed: {
      getSnapshot: async () => ({
        schemaVersion: 1,
        storms: [storm],
        unavailable: false,
        stale: false,
        fetchedAt: Date.now(),
      }),
    },
    cesium: {
      ScreenSpaceEventType: { LEFT_CLICK: 'left' },
      ScreenSpaceEventHandler: class {
        setInputAction() {}
        destroy() {}
        isDestroyed() {
          return false;
        }
      },
    },
    createRendering: () => ({
      setSnapshot: async () => true,
      setSelection() {},
      clear() {},
      destroy() {},
      pickStorm: () => null,
      ownsPickId: () => false,
      getDiagnostics: () => ({}),
    }),
    hitTestOverlay: () => null,
  });
  layer.init({
    scene: { canvas: new EventTarget(), pick: () => null },
    camera: {},
  });
  assert.deepEqual(layer.getAnalystRecords(), []);
  layer.enable();
  await layer.update();
  const [row] = layer.getAnalystRecords();
  assert.deepEqual(row, {
    id: 'Fay',
    name: 'Fay',
    classification: 'TS',
    basin: 'AL',
    lat: 29.8,
    lon: -40,
    windKt: 35,
    pressureHpa: 1010,
  });
  assertDeclaredFields('weather-cyclones', row);
  layer.destroy?.();
});
