import assert from 'node:assert/strict';
import test from 'node:test';
import { getResolution, isPentagon, isValidCell } from 'h3-js';
import {
  accumulateGnssObservations,
  binGnssCells,
  GNSS_CLASSIFIER,
  GNSS_H3_RESOLUTION,
  GNSS_HIGH_PERCENT,
  GNSS_MEDIUM_PERCENT,
  GNSS_PROVENANCE,
  GNSS_WINDOW_MS,
  gnssCellKey,
  gnssCellRing,
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

test('normalization keeps airborne decoded ADS-B v1/v2 quality with current positions', () => {
  const rows = normalizeGnssAircraft({
    ac: [
      aircraft(),
      aircraft({
        hex: '000001',
        type: 'mlat',
        nic: undefined,
        nac_p: undefined,
      }),
      aircraft({ hex: '000002', type: 'tisb_icao' }),
      aircraft({ hex: '000003', version: 0 }),
      aircraft({ hex: '000004', alt_baro: 'ground' }),
      aircraft({ hex: '000005', seen_pos: 120 }),
      aircraft({ hex: '000006', nic: undefined, nac_p: undefined }),
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

test('cell keys are the H3 resolution-4 cells gpsjam.org uses', () => {
  assert.equal(GNSS_H3_RESOLUTION, 4);
  // Kraków: a known lat/lon lands in its known res-4 hexagon.
  assert.equal(gnssCellKey(50.1, 19.9), '841e2e7ffffffff');
  assert.equal(getResolution(gnssCellKey(50.1, 19.9)), 4);
  // Nearby points share the hexagon; a point ~50 km north does not.
  assert.equal(gnssCellKey(50.1, 19.9), gnssCellKey(50.12, 19.95));
  assert.notEqual(gnssCellKey(50.1, 19.9), gnssCellKey(50.55, 19.9));
  // The poles and both sides of the antimeridian still key valid cells.
  for (const [lat, lon] of [
    [90, 180],
    [-90, -180],
    [0, 179.99],
    [0, -179.99],
  ]) {
    const key = gnssCellKey(lat, lon);
    assert.ok(isValidCell(key), `${lat},${lon} → ${key}`);
    assert.equal(getResolution(key), 4);
  }
});

const cellAt = (lat, lon) => {
  const store = new Map();
  accumulateGnssObservations(
    store,
    [{ hex: 'c1', lat, lon, degraded: false }],
    0,
  );
  return binGnssCells(store)[0];
};

test('a cell carries its H3 centre and hexagon boundary', () => {
  const cell = cellAt(50.1, 19.9);
  assert.equal(cell.id, '841e2e7ffffffff');
  assert.ok(Math.abs(cell.lat - 50.17184) < 1e-4);
  assert.ok(Math.abs(cell.lon - 20.12566) < 1e-4);
  assert.equal(cell.boundary.length, 6);
  for (const { lat, lon } of cell.boundary) {
    // Res-4 hexagons are about 45 km across.
    assert.ok(Math.abs(lat - cell.lat) < 0.4, `lat ${lat}`);
    assert.ok(Math.abs(lon - cell.lon) < 0.6, `lon ${lon}`);
  }
  for (const key of ['south', 'west', 'north', 'east'])
    assert.equal(key in cell, false, `no rectangle field ${key}`);
  assert.deepEqual(
    gnssCellRing(cell),
    cell.boundary.flatMap(({ lat, lon }) => [lon, lat]),
  );
});

test('a cell across the antimeridian is drawn as one narrow polygon', () => {
  for (const lon of [179.99, -179.99]) {
    const cell = cellAt(0, lon);
    const lons = cell.boundary.map((vertex) => vertex.lon);
    assert.ok(
      Math.max(...lons) - Math.min(...lons) > 300,
      'the raw boundary straddles ±180°',
    );
    const drawn = gnssCellRing(cell).filter((_, index) => index % 2 === 0);
    const width = Math.max(...drawn) - Math.min(...drawn);
    assert.ok(width < 1, `drawn width ${width}° stays narrow`);
    for (const value of drawn) assert.ok(Math.abs(value - cell.lon) < 1);
  }
});

test('pentagon and polar cells give closed rings', () => {
  // 8408001ffffffff is one of the twelve res-4 pentagons.
  const pentagon = cellAt(64.7, 10.5);
  assert.ok(isPentagon(pentagon.id));
  assert.equal(pentagon.boundary.length, 5);
  assert.equal(gnssCellRing(pentagon).length, 10);
  for (const lat of [89.99, -89.99]) {
    const polar = cellAt(lat, 10);
    assert.ok(polar.boundary.length >= 6);
    for (const vertex of polar.boundary)
      assert.ok(Math.abs(vertex.lat) > 89 && Math.abs(vertex.lat) <= 90);
    // Unwrapped longitudes stay within half a turn of the centre.
    gnssCellRing(polar)
      .filter((_, index) => index % 2 === 0)
      .forEach((value) => assert.ok(Math.abs(value - polar.lon) <= 180));
  }
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
      { hex: 'h2', lat: 10.11, lon: 10.11, degraded: true },
      { hex: 'h3', lat: 10.12, lon: 10.12, degraded: false },
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
    id: 'gev-nic-nacp-v2',
    rule: 'gpsOkBefore set || aircraft-reported NACp < 8 || (aircraft-reported NIC < 7 && !(NIC === 0 && NACp >= 10))',
    basis: '14 CFR 91.227(c) ADS-B Out performance minima (US regulation)',
    definedBy: 'GEV',
    validated: false,
  });
  assert.equal(GNSS_PROVENANCE.classifier, GNSS_CLASSIFIER);
  assert.deepEqual(GNSS_PROVENANCE.aggregation, {
    id: 'gpsjam-cell-bands',
    formula: '100 * max(0, bad - 1) / total',
    bands: [2, 10],
    grid: 'h3',
    h3Resolution: 4,
    source: 'https://gpsjam.org/faq',
    definedBy: 'gpsjam.org',
  });
  assert.deepEqual(GNSS_PROVENANCE.window, {
    minutes: 30,
    scope: 'visited-view',
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
  assert.equal(gnssIntegrityLevel(100, 1 + medium).level, 'medium');
  assert.equal(gnssIntegrityLevel(100, 1 + high).level, 'medium');
  assert.equal(gnssIntegrityLevel(100, 2 + high).level, 'high');
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
  assert.equal(cell.id, gnssCellKey(50.2, 20.1));

  accumulateGnssObservations(store, [], 1200, { windowMs: 1000 });
  assert.equal(store.size, 1);
  [cell] = binGnssCells(store);
  assert.equal(cell.aircraft, 1, 'only a1, seen inside the window, remains');
  assert.equal(cell.degraded, 0);
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

test('every cell with an aircraft is shown, as on gpsjam.org; only the bad − 1 discount guards small samples', () => {
  const store = new Map();
  accumulateGnssObservations(
    store,
    [{ hex: 'b1', lat: 10.1, lon: 10.1, degraded: true }],
    0,
  );
  let [cell] = binGnssCells(store);
  assert.equal(cell.aircraft, 1);
  assert.equal(cell.level, 'low', 'one bad aircraft is discounted');
  assert.equal(cell.percentDegraded, 0);
  accumulateGnssObservations(
    store,
    [{ hex: 'b2', lat: 10.12, lon: 10.12, degraded: true }],
    0,
  );
  [cell] = binGnssCells(store);
  assert.equal(cell.aircraft, 2);
  assert.equal(cell.level, 'high');
  assert.equal(cell.percentDegraded, 50);
});

test('the gpsjam bands are unchanged by the hex grid', () => {
  assert.equal(GNSS_MEDIUM_PERCENT, 2);
  assert.equal(GNSS_HIGH_PERCENT, 10);
  // [total, bad] → level, at and either side of both band edges.
  for (const [total, bad, level] of [
    [100, 0, 'low'],
    [100, 1, 'low'],
    [100, 2, 'low'],
    [100, 3, 'medium'],
    [50, 2, 'medium'],
    [100, 11, 'medium'],
    [100, 12, 'high'],
    [10, 2, 'medium'],
    [10, 3, 'high'],
  ])
    assert.equal(
      gnssIntegrityLevel(total, bad).level,
      level,
      `${bad}/${total}`,
    );
  // Binned cells band the same way: 3 bad of 10 in one hexagon is high.
  const store = new Map();
  accumulateGnssObservations(
    store,
    Array.from({ length: 10 }, (_, index) => ({
      hex: `h${index}`,
      lat: 50.1,
      lon: 19.9,
      degraded: index < 3,
    })),
    0,
  );
  const [cell] = binGnssCells(store);
  assert.equal(cell.id, '841e2e7ffffffff');
  assert.equal(cell.level, 'high');
  assert.equal(cell.percentDegraded, 20);
});

test('MLAT GPS-loss evidence uses the last good GNSS location and ignores MLAT NIC', () => {
  const [row] = normalizeGnssAircraft({
    ac: [
      aircraft({
        type: 'mlat',
        nac_p: 0,
        nic: 0,
        mlat: ['lat', 'lon', 'nic'],
        gpsOkBefore: 1800000000,
        gpsOkLat: 54.2,
        gpsOkLon: 19.3,
      }),
    ],
  });
  assert.ok(row);
  assert.equal(row.lat, 54.2);
  assert.equal(row.lon, 19.3);
  assert.equal(row.nic, null);
  assert.equal(row.degraded, true);
  const [healthy] = normalizeGnssAircraft({
    ac: [aircraft({ type: 'mlat', nic: 0, mlat: ['nic'] })],
  });
  assert.equal(healthy.degraded, false);
});

test('TIS-B accuracy fields and unknown containment do not manufacture anomalies', () => {
  const rows = normalizeGnssAircraft({
    ac: [
      aircraft({ hex: 'a00001', nac_p: 0, tisb: ['nac_p'] }),
      aircraft({ hex: 'a00002', nic: 0, tisb: ['nic'] }),
      aircraft({ hex: 'a00003', nic: 0, nac_p: 10 }),
      aircraft({ hex: 'a00004', nic: 0, nac_p: 8 }),
      aircraft({ hex: 'a00005', nic: 6, nac_p: 10 }),
    ],
  });
  assert.deepEqual(
    rows.map((r) => r.degraded),
    [false, false, false, true, true],
  );
});

// Quality-field subsets captured from public adsb.lol US point responses on
// 2026-10-14 (34,-118 and 41,-73, radius 250 nm), ODbL 1.0 / adsb.lol contributors.
// Only field provenance is reused; the airborne ADS-B envelopes are synthetic.
test('public US quality-field fixtures do not turn rebroadcast accuracy into own accuracy', () => {
  const tisbQuality = {
    nic: 0,
    nac_p: 0,
    tisb: [
      'altitude',
      'alt_baro',
      'gs',
      'track',
      'geom_rate',
      'lat',
      'lon',
      'nic',
      'rc',
      'nac_p',
      'nac_v',
      'sil',
      'sil_type',
    ],
    mlat: [],
  };
  assert.deepEqual(normalizeGnssAircraft({ ac: [aircraft(tisbQuality)] }), []);
  const unknownContainment = {
    nic: 0,
    nac_p: 10,
    tisb: ['callsign'],
    mlat: [],
  };
  assert.equal(
    normalizeGnssAircraft({ ac: [aircraft(unknownContainment)] })[0].degraded,
    false,
  );
});
