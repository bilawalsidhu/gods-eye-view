// Focused tests for the satellite analyst-record mapper and snapshot seam.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as Cesium from 'cesium';
import { twoline2satrec } from 'satellite.js';
import satellitesLayer, {
  mapAnalystRecord,
  _clearDenseCatalogStateForTest,
  _setTrackedSatelliteRefreshStateForTest,
} from './satellites.js';

const ISS_NORAD = 25544;

const ISS_L1 = '1 25544U 98067A   08264.51782528 -.00002182  00000-0 -11606-4 0  2927';
const ISS_L2 = '2 25544  51.6416 247.4627 0006703 130.5360 325.0288 15.72125391563537';

const FULL_RAW = {
  noradId: 25544,
  name: 'ISS (ZARYA)',
  group: 'stations',
  lat: 51.64,
  lon: -97.4,
  altitudeM: 410_000,
  speedMps: 7660,
};

test('satellite analyst record: full record maps every contract field', () => {
  const r = mapAnalystRecord(FULL_RAW);
  assert.deepEqual(r, {
    id: 'ISS (ZARYA)',
    noradId: '25544',
    name: 'ISS (ZARYA)',
    lat: 51.64,
    lon: -97.4,
    altitudeM: 410_000,
    speedMps: 7660,
    satelliteClass: 'STATION · ISS',
    group: 'stations',
  });
});

test('satellite analyst record: nameless row falls back to SAT-norad id', () => {
  const r = mapAnalystRecord({ ...FULL_RAW, name: '  ', noradId: 25544 });
  assert.equal(r.id, 'SAT-25544');
  assert.equal(r.name, null);
});

test('satellite analyst record: ISS class wins even when ingested as visual', () => {
  const r = mapAnalystRecord({ ...FULL_RAW, group: 'visual' });
  assert.equal(r.satelliteClass, 'STATION · ISS');
});

test('satellite analyst record: GPS group maps to NAV · GPS', () => {
  const r = mapAnalystRecord({
    noradId: 24876,
    name: 'GPS BIIR-2  (PRN 13)',
    group: 'gps-ops',
    lat: 0,
    lon: 0,
    altitudeM: 20_200_000,
    speedMps: 3870,
  });
  assert.equal(r.satelliteClass, 'NAV · GPS');
  assert.equal(r.group, 'gps-ops');
});

test('satellite analyst record: empty record yields nulls, never NaN/undefined', () => {
  const r = mapAnalystRecord(undefined);
  assert.equal(r.id, 'SAT-00000');
  assert.equal(r.satelliteClass, null);
  for (const [key, value] of Object.entries(r)) {
    assert.notEqual(value, undefined, `${key} must not be undefined`);
    if (typeof value === 'number') assert.ok(Number.isFinite(value), `${key} must not be NaN`);
  }
});

test('satellite analyst record: output is JSON-safe (no Cesium types leak)', () => {
  const r = mapAnalystRecord({ ...FULL_RAW, position: { x: 1 }, satrec: { dummy: true } });
  assert.deepEqual(JSON.parse(JSON.stringify(r)), r);
  assert.equal('position' in r, false);
  assert.equal('satrec' in r, false);
});

test('satellite getAnalystRecords: disabled or empty catalog returns []', () => {
  _clearDenseCatalogStateForTest();
  assert.deepEqual(satellitesLayer.getAnalystRecords(), []);
});

test('satellite getAnalystRecords: core rows beat dense extras under the cap', () => {
  const satrec = twoline2satrec(ISS_L1, ISS_L2);
  const point = { position: Cesium.Cartesian3.fromDegrees(-97.7, 30.2, 420_000) };
  _setTrackedSatelliteRefreshStateForTest({
    noradId: ISS_NORAD,
    name: 'ISS (ZARYA)',
    satrec,
    entity: {},
    point,
    viewer: {},
    now: () => Date.now(),
    neighbours: [
      {
        noradId: 99999,
        name: 'STARLINK-TEST',
        satrec,
        group: 'dense',
        point: { position: Cesium.Cartesian3.fromDegrees(-90, 20, 550_000) },
      },
      {
        noradId: 24876,
        name: 'GPS BIIR-2',
        satrec,
        group: 'gps-ops',
        point: { position: Cesium.Cartesian3.fromDegrees(-100, 10, 20_200_000) },
      },
    ],
  });
  try {
    const capped = satellitesLayer.getAnalystRecords(2);
    assert.equal(capped.length, 2);
    assert.deepEqual(capped.map((r) => r.noradId), ['25544', '24876']);
    assert.equal(capped.some((r) => r.group === 'dense'), false);

    const all = satellitesLayer.getAnalystRecords(10);
    assert.equal(all.length, 3);
    assert.equal(all[2].noradId, '99999');
    assert.equal(all[2].satelliteClass, 'COMMS · STARLINK');
    for (const row of all) {
      assert.ok(Number.isFinite(row.lat) && Number.isFinite(row.lon), `${row.id} needs a geodetic position`);
      assert.deepEqual(JSON.parse(JSON.stringify(row)), row);
    }
  } finally {
    _clearDenseCatalogStateForTest();
  }
});
