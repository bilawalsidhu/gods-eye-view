import assert from 'node:assert/strict';
import test from 'node:test';
import {
  accumulateGnssObservations,
  binGnssCells,
  gnssCellKey,
  gnssInterferenceLevel,
  normalizeGnssAircraft,
} from './records.js';

const aircraft = (overrides = {}) => ({
  hex: '4ca7b5',
  type: 'adsb_icao',
  version: 2,
  alt_baro: 36000,
  lat: 50.1,
  lon: 19.9,
  nic: 8,
  nac_p: 10,
  seen_pos: 1.2,
  ...overrides,
});

test('normalization keeps only airborne self-reported ADS-B v1/v2 positions', () => {
  const rows = normalizeGnssAircraft({
    ac: [
      aircraft(),
      aircraft({ hex: '000001', type: 'mlat', nic: 0 }),
      aircraft({ hex: '000002', type: 'tisb_icao' }),
      aircraft({ hex: '000003', version: 0 }),
      aircraft({ hex: '000004', alt_baro: 'ground' }),
      aircraft({ hex: '000005', seen_pos: 120 }),
      aircraft({ hex: '000006', nic: undefined }),
      aircraft({ hex: '000007', lat: 95 }),
      aircraft({ hex: 'not-hex' }),
      aircraft(),
      null,
    ],
  });
  assert.deepEqual(rows, [
    {
      hex: '4ca7b5',
      lat: 50.1,
      lon: 19.9,
      nic: 8,
      nacp: 10,
      gpsLost: false,
      degraded: false,
    },
  ]);
  assert.equal(normalizeGnssAircraft({}), null);
  assert.equal(normalizeGnssAircraft(null), null);
});

test('low NIC, low NACp or a readsb GPS-loss flag each mark an aircraft degraded', () => {
  const rows = normalizeGnssAircraft({
    ac: [
      aircraft({ hex: 'a00001', nic: 6 }),
      aircraft({ hex: 'a00002', nac_p: 7 }),
      aircraft({ hex: 'a00003', gpsOkBefore: 1790690000.1 }),
      aircraft({ hex: 'a00004', nic: 7, nac_p: 8 }),
    ],
  });
  assert.deepEqual(
    rows.map(({ hex, degraded, gpsLost }) => [hex, degraded, gpsLost]),
    [
      ['a00001', true, false],
      ['a00002', true, false],
      ['a00003', true, true],
      ['a00004', false, false],
    ],
  );
});

test('cell keys are stable half-degree bins, clamped at the poles and antimeridian', () => {
  assert.equal(gnssCellKey(50.1, 19.9), gnssCellKey(50.4, 19.6));
  assert.notEqual(gnssCellKey(50.1, 19.9), gnssCellKey(50.6, 19.9));
  assert.equal(gnssCellKey(90, 180), gnssCellKey(89.9, 179.9));
  assert.equal(gnssCellKey(-90, -180), '0:0');
});

test('interference level follows the published gpsjam formula and bands', () => {
  assert.deepEqual(gnssInterferenceLevel(10, 0), { percent: 0, level: 'low' });
  // One degraded aircraft is always discounted.
  assert.deepEqual(gnssInterferenceLevel(10, 1), { percent: 0, level: 'low' });
  assert.equal(gnssInterferenceLevel(50, 2).level, 'medium');
  assert.equal(gnssInterferenceLevel(10, 2).level, 'medium');
  assert.equal(gnssInterferenceLevel(10, 3).level, 'high');
  assert.equal(gnssInterferenceLevel(0, 0).level, 'low');
});

test('observations count each aircraft once per cell and expire after the window', () => {
  const store = new Map();
  const at = (lat, hex, degraded) => ({ hex, lat, lon: 20.1, degraded });
  accumulateGnssObservations(
    store,
    [at(50.1, 'a1', true), at(50.2, 'a2', false), at(50.3, 'a3', false)],
    0,
    { windowMs: 1000 },
  );
  // a1 recovers inside the same cell: it stays degraded for the window.
  accumulateGnssObservations(store, [at(50.2, 'a1', false)], 500, {
    windowMs: 1000,
  });
  let [cell] = binGnssCells(store);
  assert.equal(cell.aircraft, 3);
  assert.equal(cell.degraded, 1);
  assert.equal(cell.level, 'low');
  assert.deepEqual(
    [cell.south, cell.west, cell.north, cell.east],
    [50, 20, 50.5, 20.5],
  );

  accumulateGnssObservations(store, [], 1200, { windowMs: 1000 });
  assert.equal(store.size, 1);
  assert.deepEqual(binGnssCells(store), []);
});

test('cells below the minimum aircraft count are withheld', () => {
  const store = new Map();
  accumulateGnssObservations(
    store,
    [
      { hex: 'b1', lat: 10.1, lon: 10.1, degraded: true },
      { hex: 'b2', lat: 10.2, lon: 10.2, degraded: true },
    ],
    0,
  );
  assert.deepEqual(binGnssCells(store), []);
  const [cell] = binGnssCells(store, { minAircraft: 2 });
  assert.equal(cell.level, 'high');
  assert.equal(cell.percentDegraded, 50);
});
