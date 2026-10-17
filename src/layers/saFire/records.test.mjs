import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  linkWarningsToIncidents,
  normalizeSaIncidents,
  normalizeSaWarnings,
  parseReportedTime,
  safeWarningLink,
  validateSaFireSnapshot,
} from './records.js';

// SYNTHETIC fixture shaped like the public feed (see src/data/fixtures/README.md).
const fixture = JSON.parse(
  readFileSync(
    new URL(
      '../../data/fixtures/sa-fire-incidents.synthetic.json',
      import.meta.url,
    ),
    'utf8',
  ),
);

const incident = (overrides = {}) => ({
  ...fixture[0],
  ...overrides,
});
const at = (lat, lon) => ({
  ...fixture[0].location,
  coordinates: { lat, lon },
});

test('the fixture normalizes: string coordinates become numbers, times become UTC', () => {
  const rows = normalizeSaIncidents(fixture);
  assert.equal(rows.length, 2);
  assert.deepEqual(rows[0], {
    id: 'F0000000001',
    agency: 'CFS',
    name: 'TEST PLAINS',
    lat: -35.35,
    lon: 138.62,
    region: 'R1',
    fireBanDistrict: 'MOUNT LOFTY RANGES',
    type: 'BURN OFF',
    status: 'Controlled',
    level: 'L1',
    ground: 0,
    aircraft: 0,
    messageCount: 0,
    // 12/10/2026 19:30 in Adelaide (ACDT, UTC+10:30) is 09:00Z.
    reportedTime: Date.UTC(2026, 9, 12, 9, 0),
  });
  assert.equal(rows[1].agency, 'MFS');
  // 27/08/2026 21:18 is winter time (ACST, UTC+9:30).
  assert.equal(rows[1].reportedTime, Date.UTC(2026, 7, 27, 11, 48));
});

test('only a payload that is not an array rejects the whole snapshot', () => {
  for (const payload of [
    null,
    undefined,
    {},
    'File Unavailable',
    7,
    { incidents: [] },
  ])
    assert.equal(normalizeSaIncidents(payload), null);
  // A healthy empty feed is authoritative, not an error.
  assert.deepEqual(normalizeSaIncidents([]), []);
  assert.deepEqual(normalizeSaIncidents([null, 7, 'x', [], {}]), []);
});

test('missing, blank, NaN and non-finite coordinates skip only that record', () => {
  const bad = [
    at('', ''),
    at(null, null),
    at(undefined, '138.6'),
    at('abc', '138.6'),
    at('-35.3', 'NaN'),
    at('Infinity', '138.6'),
    at(Number.NaN, 138.6),
    { name: 'NO COORDINATES' },
  ].map((location, index) => incident({ id: `bad-${index}`, location }));
  const rows = normalizeSaIncidents([...bad, fixture[1]]);
  assert.deepEqual(
    rows.map((row) => row.id),
    ['F0000000002'],
  );
  assert.deepEqual(
    normalizeSaIncidents([incident({ location: undefined })]),
    [],
  );
});

test('points outside South Australia are rejected, border margins are kept', () => {
  const rows = normalizeSaIncidents([
    incident({ id: 'sydney', location: at('-33.87', '151.21') }),
    incident({ id: 'perth', location: at('-31.95', '115.86') }),
    incident({ id: 'null-island', location: at('0', '0') }),
    incident({ id: 'swapped', location: at('138.6', '-35.3') }),
    incident({ id: 'north-nt', location: at('-12.4', '130.8') }),
    incident({ id: 'melbourne', location: at('-37.81', '144.96') }),
    incident({ id: 'adelaide', location: at('-34.93', '138.6') }),
    incident({ id: 'ceduna', location: at('-32.12', '133.67') }),
    incident({ id: 'mount-gambier', location: at(-37.83, 140.78) }),
  ]);
  assert.deepEqual(
    rows.map((row) => row.id),
    ['adelaide', 'ceduna', 'mount-gambier'],
  );
});

test('duplicate ids keep the first record; unknown agencies and statuses are kept as-is', () => {
  const rows = normalizeSaIncidents([
    incident({ id: 'dup', agency: 'SAFECOM' }),
    incident({ id: 'dup', agency: 'CFS', location: at('-34.9', '138.6') }),
    incident({
      id: 'odd',
      agency: 'Forestry SA',
      incident: { type: 'SMOKE', status: 'Under Investigation', level: 'L9' },
    }),
    { ...incident({ id: '' }) },
    { ...incident({ id: 42 }) },
  ]);
  assert.deepEqual(
    rows.map((row) => [row.id, row.agency, row.status, row.level]),
    [
      ['dup', 'SAFECOM', 'Controlled', 'L1'],
      ['odd', 'Forestry SA', 'Under Investigation', 'L9'],
      ['42', 'CFS', 'Controlled', 'L1'],
    ],
  );
  assert.equal(rows[0].lat, -35.35, 'the first duplicate wins');
});

test('text fields are control-stripped, bounded and never non-strings', () => {
  const [row] = normalizeSaIncidents([
    incident({
      id: 'x',
      agency: 7,
      location: {
        ...fixture[0].location,
        name: 'A\u0000B\u001bC' + 'z'.repeat(500),
        fbd: '   ',
      },
      incident: { type: ['BURN OFF'], status: null, level: {} },
      resources: { ground: -3, aircraft: '2' },
      messages_count: 'many',
      messages: ['a', 'b'],
    }),
  ]);
  assert.equal(row.agency, null);
  assert.ok(row.name.startsWith('A B C') && row.name.length <= 120);
  assert.equal(row.fireBanDistrict, null);
  assert.equal(row.type, null);
  assert.equal(row.ground, null);
  assert.equal(row.aircraft, null);
  assert.equal(row.messageCount, 2);
});

test('reported times convert through the record zone across both Adelaide DST changes', () => {
  const adelaide = (date, time) =>
    parseReportedTime({ date, time, tz: 'Australia/Adelaide' });
  // DST starts first Sunday of October (2026-10-04, 02:00 ACST -> 03:00 ACDT).
  assert.equal(adelaide('03/10/2026', '12:00'), Date.UTC(2026, 9, 3, 2, 30)); // ACST +9:30
  assert.equal(adelaide('05/10/2026', '12:00'), Date.UTC(2026, 9, 5, 1, 30)); // ACDT +10:30
  assert.equal(adelaide('04/10/2026', '01:59'), Date.UTC(2026, 9, 3, 16, 29));
  assert.equal(adelaide('04/10/2026', '03:00'), Date.UTC(2026, 9, 3, 16, 30));
  // DST ends first Sunday of April (2026-04-05, 03:00 ACDT -> 02:00 ACST).
  assert.equal(adelaide('04/04/2026', '12:00'), Date.UTC(2026, 3, 4, 1, 30)); // ACDT
  assert.equal(adelaide('06/04/2026', '12:00'), Date.UTC(2026, 3, 6, 2, 30)); // ACST
  assert.equal(adelaide('05/04/2026', '01:59'), Date.UTC(2026, 3, 4, 15, 29));
  assert.equal(adelaide('05/04/2026', '03:30'), Date.UTC(2026, 3, 4, 18, 0));
  // The result must not depend on the server's own zone: another zone differs.
  assert.equal(
    parseReportedTime({ date: '12/10/2026', time: '19:30', tz: 'UTC' }),
    Date.UTC(2026, 9, 12, 19, 30),
  );
  assert.equal(
    parseReportedTime({
      date: '12/10/2026',
      time: '19:30',
      tz: 'Australia/Perth',
    }),
    Date.UTC(2026, 9, 12, 11, 30),
  );
});

test('unparseable dates, impossible calendar days and unknown zones give null', () => {
  const ok = { date: '12/10/2026', time: '19:30', tz: 'Australia/Adelaide' };
  assert.notEqual(parseReportedTime(ok), null);
  for (const bad of [
    undefined,
    null,
    {},
    { ...ok, tz: 'Nowhere/Land' },
    { ...ok, tz: undefined },
    { ...ok, tz: '' },
    { ...ok, tz: '../etc/passwd' },
    { ...ok, tz: 'A'.repeat(100) },
    { ...ok, date: '2026-10-12' },
    { ...ok, date: '31/02/2026' },
    { ...ok, date: '12/13/2026' },
    { ...ok, date: '00/10/2026' },
    { ...ok, date: '12/10/26' },
    { ...ok, time: '24:00' },
    { ...ok, time: '7pm' },
    { ...ok, time: '12:60' },
  ])
    assert.equal(parseReportedTime(bad), null, JSON.stringify(bad));
  // An unparseable time does not drop the incident: it is shown without a time.
  const [row] = normalizeSaIncidents([
    incident({ reported: { ...ok, tz: 'Nowhere/Land' } }),
  ]);
  assert.equal(row.reportedTime, null);
});

// --- Warnings ---------------------------------------------------------------
// SYNTHETIC FIXTURES. The CFS public-warnings layers returned zero features
// when this was written, so these GeoJSON features are built by hand from the
// published layer schemas (fields, types and lengths in the ArcGIS metadata
// for FeatureServer layers 0 and 1), not captured from the live service.

const NOW = Date.UTC(2026, 9, 13, 3, 0); // 13 Oct 2026 13:30 ACDT
const HOUR = 3_600_000;

const square = (lon, lat, size = 0.2) => [
  [
    [lon, lat],
    [lon + size, lat],
    [lon + size, lat + size],
    [lon, lat + size],
    [lon, lat],
  ],
];

const props = (overrides = {}) => ({
  objectid: 1,
  name: 'Mount Compass',
  description: 'A bushfire is burning near Mount Compass.',
  category: 'Watch and Act',
  public: 'True',
  icon: 'Watch and Act',
  expiry: NOW + HOUR,
  incident_id: null,
  mfs_incident_id: null,
  long_description: null,
  headline: 'Bushfire - Mount Compass',
  message_link: 'https://www.cfs.sa.gov.au/warnings-and-incidents/example',
  created_date: NOW - HOUR,
  last_edited_date: NOW - 60_000,
  expiry_with_offset: NOW + 2 * HOUR,
  ...overrides,
});
const polygonFeature = (
  overrides = {},
  coordinates = square(138.6, -35.4),
) => ({
  type: 'Feature',
  id: 1,
  properties: props(overrides),
  geometry: { type: 'Polygon', coordinates },
});
const pointFeature = (overrides = {}, coordinates = [138.6, -35.4]) => ({
  type: 'Feature',
  id: 1,
  properties: props(overrides),
  geometry: { type: 'Point', coordinates },
});
const collection = (...features) => ({ type: 'FeatureCollection', features });
const normalize = (points, polygons) =>
  normalizeSaWarnings(
    { points: collection(...points), polygons: collection(...polygons) },
    NOW,
  );

test('warnings: a public polygon and a public point normalize with ids by layer', () => {
  const rows = normalize(
    [pointFeature({ objectid: 7, category: 'Emergency Warning' })],
    [polygonFeature({ objectid: 7 })],
  );
  assert.deepEqual(
    rows.map((row) => [row.id, row.kind, row.category]),
    [
      ['g:7', 'polygon', 'Watch and Act'],
      ['p:7', 'point', 'Emergency Warning'],
    ],
  );
  const polygon = rows[0];
  assert.equal(polygon.headline, 'Bushfire - Mount Compass');
  assert.equal(polygon.expiryTime, NOW + 2 * HOUR, 'expiry_with_offset wins');
  assert.equal(
    polygon.link,
    'https://www.cfs.sa.gov.au/warnings-and-incidents/example',
  );
  assert.ok(
    Math.abs(polygon.lon - 138.7) < 1e-9 && Math.abs(polygon.lat + 35.3) < 1e-9,
  );
  assert.equal(polygon.polygons.length, 1);
});

test('warnings: only public ones are kept (fail closed on anything but "true")', () => {
  const flags = ['True', 'true', ' TRUE ', true];
  const hidden = [
    'False',
    'false',
    '',
    null,
    undefined,
    'yes',
    'Y',
    1,
    'True!',
  ];
  const rows = normalize(
    [],
    [
      ...flags.map((value, index) =>
        polygonFeature({ objectid: index, public: value }),
      ),
      ...hidden.map((value, index) =>
        polygonFeature({ objectid: 100 + index, public: value }),
      ),
    ],
  );
  assert.deepEqual(
    rows.map((row) => row.id),
    flags.map((_, index) => `g:${index}`),
  );
});

test('warnings: expired warnings are dropped using expiry_with_offset, else expiry', () => {
  const rows = normalize(
    [],
    [
      polygonFeature({
        objectid: 1,
        expiry_with_offset: NOW - 1,
        expiry: NOW + HOUR,
      }),
      polygonFeature({
        objectid: 2,
        expiry_with_offset: NOW + HOUR,
        expiry: NOW - HOUR,
      }),
      polygonFeature({
        objectid: 3,
        expiry_with_offset: null,
        expiry: NOW - 1,
      }),
      polygonFeature({
        objectid: 4,
        expiry_with_offset: null,
        expiry: NOW + 1,
      }),
      polygonFeature({ objectid: 5, expiry_with_offset: null, expiry: NOW }),
      polygonFeature({ objectid: 6, expiry_with_offset: null, expiry: null }),
      polygonFeature({
        objectid: 7,
        expiry_with_offset: '2026-10-13T00:00:00Z',
        expiry: null,
      }),
    ],
  );
  assert.deepEqual(
    rows.map((row) => row.id),
    ['g:2', 'g:4', 'g:5', 'g:6'],
  );
  assert.equal(rows.at(-1).expiryTime, null, 'no expiry stays displayable');
});

test('warnings: message_link must be https on cfs.sa.gov.au with no credentials', () => {
  const ok = [
    'https://www.cfs.sa.gov.au/warnings-and-incidents/x?id=1#top',
    'https://cfs.sa.gov.au/',
    '  https://alerts.cfs.sa.gov.au/path  ',
  ];
  for (const value of ok) assert.ok(safeWarningLink(value), value);
  const bad = [
    'http://www.cfs.sa.gov.au/x',
    'https://evil.example/cfs.sa.gov.au',
    'https://cfs.sa.gov.au.evil.example/',
    'https://evilcfs.sa.gov.au/',
    'https://www.cfs.sa.gov.au@evil.example/',
    'https://user@www.cfs.sa.gov.au/',
    'https://user:pass@www.cfs.sa.gov.au/',
    'https://www.cfs.sa.gov.au:8443/',
    'javascript:alert(1)',
    'JaVaScRiPt://www.cfs.sa.gov.au/%0aalert(1)',
    'data:text/html,<script>alert(1)</script>',
    'ftp://www.cfs.sa.gov.au/',
    '//www.cfs.sa.gov.au/',
    '/relative/path',
    'https://www.cfs.sa.gov.au/ x',
    'https://www.cfs.sa.gov.au\\@evil.example/',
    `https://www.cfs.sa.gov.au/${'a'.repeat(600)}`,
    '',
    null,
    undefined,
    42,
    {},
  ];
  for (const value of bad)
    assert.equal(safeWarningLink(value), null, String(value));
  const [row] = normalize(
    [],
    [polygonFeature({ message_link: 'javascript:alert(1)' })],
  );
  assert.equal(row.link, null, 'an invalid link never drops the warning');
});

test('warnings: polygon geometry is validated and out-of-state shapes are dropped', () => {
  const bowtie = [
    [
      [138, -35],
      [139, -35],
      [139, -34],
    ],
  ]; // open, too few points
  const rows = normalize(
    [],
    [
      polygonFeature({ objectid: 1 }),
      polygonFeature({ objectid: 2 }, bowtie),
      polygonFeature({ objectid: 3 }, square(138, 200)),
      polygonFeature({ objectid: 4 }, square('x', -35)),
      polygonFeature({ objectid: 5 }, square(151, -33.9)), // Sydney
      polygonFeature({ objectid: 6 }, square(141.4, -34)), // straddles the SA edge
      {
        type: 'Feature',
        id: 7,
        properties: props({ objectid: 7 }),
        geometry: null,
      },
      {
        type: 'Feature',
        id: 8,
        properties: props({ objectid: 8 }),
        geometry: { type: 'Point', coordinates: [138, -35] },
      },
      {
        type: 'Feature',
        id: 9,
        properties: null,
        geometry: { type: 'Polygon', coordinates: square(138, -35) },
      },
      {
        type: 'Feature',
        id: 10,
        properties: props({ objectid: 10 }),
        geometry: {
          type: 'MultiPolygon',
          coordinates: [
            square(138, -35, 0.1),
            square(151, -33.9),
            square(139, -34, 0.1),
          ],
        },
      },
    ],
  );
  assert.deepEqual(
    rows.map((row) => row.id),
    ['g:1', 'g:6', 'g:10'],
  );
  assert.equal(
    rows.at(-1).polygons.length,
    2,
    'the out-of-state part is dropped',
  );
});

test('warnings: points need in-state finite coordinates', () => {
  const rows = normalize(
    [
      pointFeature({ objectid: 1 }),
      pointFeature({ objectid: 2 }, [151.2, -33.9]),
      pointFeature({ objectid: 3 }, ['x', 1]),
      pointFeature({ objectid: 4 }, []),
      pointFeature({ objectid: 5 }, [138.6, -35.4, 12]),
    ],
    [],
  );
  assert.deepEqual(
    rows.map((row) => row.id),
    ['p:1', 'p:5'],
  );
});

test('warnings: a payload that is not two feature collections rejects the snapshot', () => {
  const good = collection();
  for (const bad of [
    { points: good },
    { polygons: good },
    { points: good, polygons: { error: { code: 400 } } },
    { points: { features: 'no' }, polygons: good },
    {},
    undefined,
  ])
    assert.equal(normalizeSaWarnings(bad, NOW), null);
  assert.deepEqual(
    normalizeSaWarnings({ points: good, polygons: good }, NOW),
    [],
  );
});

test('warnings: text is untrusted data and stays plain bounded strings', () => {
  const [row] = normalize(
    [],
    [
      polygonFeature({
        headline: '<img src=x onerror=alert(1)>\u0000',
        description: 'x'.repeat(5000),
        name: { toString: () => 'object' },
      }),
    ],
  );
  assert.equal(
    row.headline,
    '<img src=x onerror=alert(1)>',
    'stored verbatim, never interpreted',
  );
  assert.equal(row.description.length, 2000);
  assert.equal(row.name, null);
});

test('warnings link to an incident only on an explicit numeric match', () => {
  const incidents = normalizeSaIncidents([
    incident({ id: 'F2101010001', agency: 'CFS' }),
    incident({
      id: 'F2101010002',
      agency: 'MFS',
      location: at('-34.9', '138.6'),
    }),
    incident({
      id: 'F0000000001',
      agency: 'CFS',
      location: at('-35.0', '138.7'),
    }),
  ]);
  const warnings = normalize(
    [],
    [
      polygonFeature({ objectid: 1, incident_id: 2101010001 }),
      polygonFeature({ objectid: 2, mfs_incident_id: 2101010002 }),
      // Agency must agree: an MFS number does not link to a CFS incident.
      polygonFeature({ objectid: 3, incident_id: 2101010002 }),
      polygonFeature({ objectid: 4, incident_id: 999 }),
      polygonFeature({ objectid: 5 }),
      polygonFeature({ objectid: 6, incident_id: '2101010001' }),
      // 2026 ids do not fit a 32-bit Integer field, so no join is invented.
      polygonFeature({ objectid: 7, incident_id: 2147483647 }),
    ],
  );
  const links = linkWarningsToIncidents(incidents, warnings);
  assert.deepEqual(
    [...links],
    [
      ['g:1', 'F2101010001'],
      ['g:2', 'F2101010002'],
    ],
  );
});

// --- Browser envelope validation ---------------------------------------------

test('the browser envelope validator rejects wrong containers and drops bad rows', () => {
  const incidents = normalizeSaIncidents(fixture);
  const warnings = normalize([], [polygonFeature()]);
  const envelope = {
    incidents,
    warnings,
    warningsAvailable: true,
    incidentsFetchedAt: 10,
    warningsFetchedAt: 11,
    upstreamModified: 9,
    stale: false,
  };
  assert.deepEqual(validateSaFireSnapshot(envelope), envelope);
  for (const bad of [
    null,
    [],
    'x',
    { ...envelope, incidents: {} },
    { ...envelope, warnings: null },
    { ...envelope, warningsAvailable: 'yes' },
    { warnings: [] },
  ])
    assert.throws(
      () => validateSaFireSnapshot(bad),
      /Malformed SA fire snapshot/,
    );
  const dirty = validateSaFireSnapshot({
    ...envelope,
    incidents: [
      ...incidents,
      incidents[0],
      { ...incidents[0], id: 'far', lat: 10 },
      { ...incidents[0], id: 'nan', lon: null },
      { ...incidents[0], id: 'str', status: 5 },
      null,
    ],
    warnings: [
      ...warnings,
      { ...warnings[0], id: 'g:bad', link: 'javascript:alert(1)' },
      { ...warnings[0], id: 'g:poly', polygons: [[[[1, 2]]]] },
      { ...warnings[0], id: 'g:kind', kind: 'line' },
    ],
    incidentsFetchedAt: 'later',
    upstreamModified: undefined,
  });
  assert.equal(dirty.incidents.length, 2);
  assert.equal(dirty.warnings.length, 1);
  assert.equal(dirty.incidentsFetchedAt, null);
  assert.equal(dirty.upstreamModified, null);
  // Warnings reported unavailable never display, whatever the array holds.
  assert.deepEqual(
    validateSaFireSnapshot({ ...envelope, warningsAvailable: false }).warnings,
    [],
  );
});
