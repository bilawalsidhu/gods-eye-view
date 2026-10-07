import assert from 'node:assert/strict';
import test from 'node:test';
import {
  accumulateGnssObservations,
  binGnssCells,
  GNSS_CLASSIFIER,
  GNSS_PROVENANCE,
  GNSS_WINDOW_MS,
  gnssCellKey,
  gnssIntegrityLevel,
  gnssProvenance,
  normalizeGnssAircraft,
  pruneGnssObservations,
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
      // Only DO-260A/B (versions 1 and 2) define NIC and NACp.
      aircraft({ hex: '000009', version: 3 }),
      aircraft({ hex: '00000a', version: '2' }),
      aircraft({ hex: '00000b', version: 1.5 }),
      // A position is current only when its age is known, finite and 0..60 s.
      aircraft({ hex: '00000c', seen_pos: undefined }),
      aircraft({ hex: '00000d', seen_pos: null }),
      aircraft({ hex: '00000e', seen_pos: -0.5 }),
      aircraft({ hex: '00000f', seen_pos: '1.2' }),
      aircraft({ hex: '000010', seen_pos: Number.NaN }),
      aircraft({ hex: '000011', seen_pos: 60.1 }),
      aircraft({ hex: 'not-hex' }),
      aircraft(),
      // A non-ICAO (`~`) address still self-reports over 1090ES ADS-B.
      aircraft({ hex: '~a1b2c3' }),
      // Version 1, and both ends of the position-age range, qualify.
      aircraft({ hex: 'b00001', version: 1, seen_pos: 0 }),
      aircraft({ hex: 'b00002', seen_pos: 60 }),
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
    ...['b00001', 'b00002'].map((hex) => ({
      hex,
      lat: 50.1,
      lon: 19.9,
      nic: 8,
      nacp: 10,
      gpsLost: false,
      degraded: false,
    })),
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

const MIN = 60_000;
const report = (hex, degraded, lat = 50.1) => ({
  hex,
  lat,
  lon: 20.1,
  degraded,
});
const entry = (store, hex) =>
  [...store].find(([key]) => key.startsWith(`${hex}|`))?.[1];

test('degraded evidence expires one window after the degraded report, despite continuing healthy reports', () => {
  const store = new Map();
  accumulateGnssObservations(store, [report('a1', true)], 0);
  // a1 keeps reporting healthy every minute in the same cell.
  for (let minute = 1; minute <= 30; minute += 1)
    accumulateGnssObservations(store, [report('a1', false)], minute * MIN);
  assert.equal(entry(store, 'a1').seenAt, 30 * MIN);
  assert.equal(
    entry(store, 'a1').degradedAt,
    0,
    'healthy reports do not refresh the degraded evidence',
  );
  accumulateGnssObservations(store, [report('a1', false)], 31 * MIN);
  assert.deepEqual(entry(store, 'a1'), {
    cell: gnssCellKey(50.1, 20.1),
    seenAt: 31 * MIN,
    degradedAt: null,
  });
  // A new degraded report starts its own window.
  accumulateGnssObservations(store, [report('a1', true)], 32 * MIN);
  assert.equal(entry(store, 'a1').degradedAt, 32 * MIN);
  accumulateGnssObservations(store, [report('a1', false)], 40 * MIN);
  assert.equal(entry(store, 'a1').degradedAt, 32 * MIN);
});

test('a degraded cell turns healthy once its degraded evidence is older than the window', () => {
  const store = new Map();
  const healthy = [report('a2', false), report('a3', false)];
  accumulateGnssObservations(
    store,
    [report('a1', true), report('b1', true), ...healthy],
    0,
  );
  assert.equal(binGnssCells(store)[0].level, 'high');
  for (let minute = 10; minute <= 30; minute += 10)
    accumulateGnssObservations(
      store,
      [report('a1', false), report('b1', false), ...healthy],
      minute * MIN,
    );
  assert.equal(binGnssCells(store)[0].degraded, 2);
  accumulateGnssObservations(
    store,
    [report('a1', false), report('b1', false), ...healthy],
    31 * MIN,
  );
  const [cell] = binGnssCells(store);
  assert.equal(cell.aircraft, 4);
  assert.equal(cell.degraded, 0);
  assert.equal(cell.level, 'low');
});

test('an aircraft returning after the window starts fresh', () => {
  const store = new Map();
  accumulateGnssObservations(store, [report('a1', true)], 0);
  // a1 leaves; nothing is heard from it for longer than the window.
  accumulateGnssObservations(store, [], 31 * MIN);
  assert.equal(store.size, 0);
  accumulateGnssObservations(store, [report('a1', false)], 32 * MIN);
  assert.deepEqual(entry(store, 'a1'), {
    cell: gnssCellKey(50.1, 20.1),
    seenAt: 32 * MIN,
    degradedAt: null,
  });
  // Returning degraded dates the evidence from the new report.
  const again = new Map();
  accumulateGnssObservations(again, [report('a9', true)], 0);
  accumulateGnssObservations(again, [], 31 * MIN);
  accumulateGnssObservations(again, [report('a9', true)], 33 * MIN);
  assert.equal(entry(again, 'a9').degradedAt, 33 * MIN);
});

test('an aircraft heard healthy right after the window drops its stale degraded evidence', () => {
  // No prune runs in between: the old entry is still in the store when the
  // healthy report arrives, so the new report alone must not carry it over.
  const store = new Map();
  accumulateGnssObservations(store, [report('a1', true)], 0);
  accumulateGnssObservations(store, [report('a1', false)], 31 * MIN);
  assert.deepEqual(entry(store, 'a1'), {
    cell: gnssCellKey(50.1, 20.1),
    seenAt: 31 * MIN,
    degradedAt: null,
  });
  // Exactly one window after the degraded report it still counts.
  const edge = new Map();
  accumulateGnssObservations(edge, [report('a1', true)], 0);
  accumulateGnssObservations(edge, [report('a1', false)], 30 * MIN);
  assert.equal(entry(edge, 'a1').degradedAt, 0);
});

test('rows are dated by the snapshot observation time, so a replay never restarts the window', () => {
  const store = new Map();
  const snapshot = [report('a1', true), report('a2', false)];
  accumulateGnssObservations(store, snapshot, 0, { observedAt: 0 });
  // The same snapshot replayed (cached or stale) 29 minutes later.
  accumulateGnssObservations(store, snapshot, 29 * MIN, { observedAt: 0 });
  assert.equal(entry(store, 'a1').seenAt, 0);
  assert.equal(entry(store, 'a1').degradedAt, 0);
  accumulateGnssObservations(store, snapshot, 31 * MIN, { observedAt: 0 });
  assert.equal(store.size, 0, 'a replay older than the window adds nothing');

  // An older replay never moves an entry's age backwards either.
  accumulateGnssObservations(store, snapshot, 40 * MIN);
  accumulateGnssObservations(store, [report('a2', true)], 41 * MIN, {
    observedAt: 35 * MIN,
  });
  assert.equal(entry(store, 'a2').seenAt, 40 * MIN);
  assert.equal(entry(store, 'a2').degradedAt, 35 * MIN);

  // A future time is clamped to now; an undated snapshot adds nothing.
  accumulateGnssObservations(store, [report('f1', true)], 50 * MIN, {
    observedAt: 99 * MIN,
  });
  assert.equal(entry(store, 'f1').seenAt, 50 * MIN);
  for (const observedAt of [null, Number.NaN])
    accumulateGnssObservations(store, [report('u1', true)], 50 * MIN, {
      observedAt,
    });
  assert.equal(entry(store, 'u1'), undefined);
});

test('pruning without new rows drops expired observations and expired degraded evidence', () => {
  const store = new Map();
  accumulateGnssObservations(store, [report('a1', true)], 0);
  accumulateGnssObservations(store, [report('a1', false)], 20 * MIN);
  accumulateGnssObservations(store, [report('a2', false)], 0);
  assert.equal(pruneGnssObservations(store, 31 * MIN), store);
  assert.deepEqual(
    [...store.keys()].map((key) => key.split('|')[0]),
    ['a1'],
  );
  assert.equal(entry(store, 'a1').degradedAt, null);
  pruneGnssObservations(store, 51 * MIN);
  assert.equal(store.size, 0);
  assert.equal(GNSS_WINDOW_MS, 30 * MIN);
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
