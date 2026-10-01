import assert from 'node:assert/strict';
import test from 'node:test';
import {
  accumulateGnssObservations,
  binGnssCells,
  GNSS_CLASSIFIER,
  GNSS_PROVENANCE,
  gnssCellKey,
  gnssIntegrityLevel,
  gnssProvenance,
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
      aircraft({ hex: '000008', version: undefined }),
      aircraft({ hex: 'not-hex' }),
      aircraft(),
      // A non-ICAO (`~`) address still self-reports over 1090ES ADS-B.
      aircraft({ hex: '~a1b2c3' }),
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
    {
      hex: '~a1b2c3',
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
  // Just south-west of the origin falls in the last cell before 0°, not cell 0.
  assert.equal(gnssCellKey(-0.1, -0.1), '179:359');
});

test('integrity level follows the gpsjam.org published cell formula and bands', () => {
  const nominal = {
    percent: 0,
    level: 'low',
    state: 'nominal',
    interpretation: null,
  };
  assert.deepEqual(gnssIntegrityLevel(10, 0), nominal);
  // One degraded aircraft is always discounted.
  assert.deepEqual(gnssIntegrityLevel(10, 1), nominal);
  assert.equal(gnssIntegrityLevel(50, 2).level, 'medium');
  assert.equal(gnssIntegrityLevel(10, 2).level, 'medium');
  assert.equal(gnssIntegrityLevel(10, 3).level, 'high');
  assert.equal(gnssIntegrityLevel(0, 0).level, 'low');
});

test('the primary state is a navigation-integrity anomaly; interference is only the secondary reading', () => {
  for (const [total, bad] of [
    [50, 2],
    [10, 3],
  ]) {
    const { state, interpretation } = gnssIntegrityLevel(total, bad);
    assert.equal(state, 'navigation-integrity-anomaly');
    assert.equal(interpretation, 'suspected-gnss-interference');
  }
  const store = new Map();
  accumulateGnssObservations(
    store,
    [
      { hex: 'h1', lat: 10.1, lon: 10.1, degraded: true },
      { hex: 'h2', lat: 10.2, lon: 10.2, degraded: true },
      { hex: 'h3', lat: 10.3, lon: 10.3, degraded: false },
    ],
    0,
  );
  const [cell] = binGnssCells(store);
  assert.equal(cell.level, 'high');
  assert.equal(cell.state, 'navigation-integrity-anomaly');
  assert.equal(cell.interpretation, 'suspected-gnss-interference');
  for (const key of Object.keys(cell))
    assert.doesNotMatch(key, /interference|jamming|spoof/i);
});

test('provenance separates the GEV classifier from the gpsjam aggregation and the GEV window', () => {
  assert.deepEqual(GNSS_PROVENANCE.classifier, {
    id: 'gev-nic-nacp-v1',
    rule: 'gpsOkBefore set || NIC < 7 || NACp < 8',
    basis: '14 CFR 91.227(c) ADS-B Out performance minima (US regulation)',
    definedBy: 'GEV',
    validated: false,
  });
  assert.equal(GNSS_PROVENANCE.classifier, GNSS_CLASSIFIER);
  assert.deepEqual(GNSS_PROVENANCE.aggregation, {
    id: 'gpsjam-cell-bands',
    formula: '100 * max(0, bad - 1) / total',
    bands: [0.02, 0.1],
    source: 'https://gpsjam.org/faq',
    definedBy: 'gpsjam.org',
  });
  assert.deepEqual(GNSS_PROVENANCE.window, {
    minutes: 30,
    scope: 'visited-view',
    cellDeg: 0.5,
    minAircraft: 3,
    definedBy: 'GEV',
  });
  assert.equal(GNSS_PROVENANCE.state.id, 'navigation-integrity-anomaly');
  assert.equal(
    GNSS_PROVENANCE.interpretation.id,
    'suspected-gnss-interference',
  );
  assert.equal(GNSS_PROVENANCE.interpretation.validated, false);
  assert.ok(Object.isFrozen(GNSS_PROVENANCE));
  assert.ok(Object.isFrozen(GNSS_PROVENANCE.aggregation.bands));
  // The bands in provenance are the ones the level function applies.
  const [medium, high] = GNSS_PROVENANCE.aggregation.bands;
  assert.equal(gnssIntegrityLevel(100, 1 + 100 * medium).level, 'medium');
  assert.equal(gnssIntegrityLevel(100, 1 + 100 * high).level, 'medium');
  assert.equal(gnssIntegrityLevel(100, 2 + 100 * high).level, 'high');
  assert.equal(gnssProvenance({ windowMs: 10 * 60_000 }).window.minutes, 10);
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

test('rows without finite coordinates never key a cell', () => {
  const store = new Map();
  accumulateGnssObservations(
    store,
    [
      { hex: 'n1', lat: Number.NaN, lon: 10.1, degraded: true },
      { hex: 'n2', lat: 10.1, lon: '10.1', degraded: true },
      null,
    ],
    0,
  );
  assert.equal(store.size, 0);
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
