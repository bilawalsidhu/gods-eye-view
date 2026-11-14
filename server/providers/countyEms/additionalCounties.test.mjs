import test from 'node:test';
import assert from 'node:assert/strict';
import { easternTime } from '../chesterCountyEms/parser.js';
import {
  parseLancasterList,
  locateLancasterRows,
  createLancasterCountyFeed,
  LANCASTER_PAGE,
} from './lancaster.js';
import {
  parseDelcoPages,
  createDelawareCountyFeed,
  DELCO_FEED,
} from './delaware.js';
import { createAssignmentDetails } from './publicFeed.js';
const now = easternTime('11/3/2026 22:00:00');
const list = (records = true) =>
  '<title>Live Incident List</title><p>Last refreshed time: Tue, Nov 3, 2026 22:00<br></p>' +
  (records
    ? '<h2>Active Medical Incidents</h2><table class="live-incidents"><tr><th>Date/Time</th><th>Incident Type</th><th>Location</th><th>Units Assigned</th></tr><tr><td>Tue, Nov 3, 2026 21:59</td><td>SYNTHETIC TEST</td><td>EXAMPLE RD &amp; TEST ST<br>EXAMPLE TOWNSHIP</td><td>AMB 01-1<br>MEDIC 01-2</td></tr><tr><td>Tue, Nov 3, 2026 21:58</td><td>SYNTHETIC UNMAPPED</td><td>OTHER COUNTY</td><td></td></tr></table>'
    : '');
const feature = (patch = {}) => ({
  attributes: {
    IsPublic: 1,
    IncidentNumber: '2026000001',
    IncidentMunicipality: 'EXAMPLE TOWNSHIP',
    IncidentOrigination: now - 60000 + 12000,
    PublicLocation: 'TEST ST / EXAMPLE RD',
    PublicType: 'SYNTHETIC TEST',
    PrimaryAgency: '01',
    ...patch,
  },
  geometry: { x: -76.3, y: 40.05 },
});
const results = (features) => [
  { status: 'fulfilled', value: { features: [] } },
  { status: 'fulfilled', value: { features } },
  { status: 'fulfilled', value: { features: [] } },
];
test('Lancaster retains category, assigned units and unmapped public rows, with stable non-invented identities', () => {
  const s = parseLancasterList(list());
  assert.equal(s.rows.length, 2);
  assert.equal(s.rows[0].category, 'ems');
  assert.deepEqual(s.rows[0].assignedUnits, ['AMB 01-1', 'MEDIC 01-2']);
  assert.equal(s.rows[0].incidentNumber, null);
  assert.match(s.rows[0].id, /^lancaster-pa:ems:[a-f0-9]{24}$/);
  const located = locateLancasterRows(s.rows, results([feature()]));
  assert.equal(located[0].id, s.rows[0].id);
  assert.equal(located[0].incidentNumber, '2026000001');
  assert.equal(located[0].mapPosition.kind, 'county-published');
  assert.equal(located[1].mapPosition, null);
  assert.equal(located[1].locationStatus, 'unmatched');
  assert.equal(parseLancasterList(list(false)).rows.length, 0);
  assert.throws(() =>
    parseLancasterList(
      list().replace('<th>Units Assigned</th>', '<th>Changed</th>'),
    ),
  );
  assert.throws(() => parseLancasterList('upstream failed'));
});
test('Lancaster declines private, ambiguous or failed map matches without dropping list reports', () => {
  const row = parseLancasterList(list()).rows[0];
  for (const features of [
    [feature({ IsPublic: 0 })],
    [feature(), feature()],
    [feature({ PublicLocation: 'OTHER ROAD' })],
  ]) {
    assert.equal(
      locateLancasterRows([row], results(features))[0].mapPosition,
      null,
    );
  }
  const unavailable = locateLancasterRows(
    [row],
    [{ status: 'rejected' }, { status: 'rejected' }, { status: 'rejected' }],
  );
  assert.equal(unavailable.length, 1);
  assert.equal(unavailable[0].locationStatus, 'unavailable');
});
test('Lancaster shares bounded source reads, recovers empty, and exposes assignments without status times', async () => {
  let calls = 0,
    clock = now,
    fail = false,
    empty = false;
  const feed = createLancasterCountyFeed({
    now: () => clock,
    fetchImpl: async (url) => {
      calls++;
      if (fail) throw new Error('offline');
      if (url === LANCASTER_PAGE) return new Response(list(!empty));
      assert.match(url, /where=IsPublic%3D1/);
      return Response.json({
        features: empty ? [] : url.includes('/1/query') ? [feature()] : [],
      });
    },
  });
  const [a, b] = await Promise.all([feed(), feed()]);
  assert.deepEqual(a, b);
  assert.equal(calls, 4);
  const details = createAssignmentDetails({ getSnapshot: feed });
  const units = await details(a.rows[0].id);
  assert.equal(calls, 4);
  assert.equal(units.assignmentOnly, true);
  assert.equal(units.units[0].status, 'Assigned');
  assert.equal(units.units[0].enteredAt, null);
  assert.equal(units.units[0].entered, '');
  await assert.rejects(details('lancaster-pa:ems:wrong'));
  clock += 120000;
  fail = true;
  assert.equal((await feed()).stale, true);
  clock += 120000;
  fail = false;
  empty = true;
  assert.equal((await feed()).rows.length, 0);
});

const page = (patch = {}) => ({
  pageId: 123,
  incidentNumber: 'F26000001',
  isStationPrivate: false,
  stationType: { name: 'EMS' },
  station: 'SYNTHETIC STATION',
  nature: 'SYNTHETIC TEST',
  dateReceived: '11/03/2026',
  timeReceived: '21:59:00',
  municipality: 'Example Township',
  location: 'EXAMPLE RD',
  notes: 'PATIENT_SECRET',
  message: 'RAW_SECRET',
  apartmentSuite: 'PRIVATE_SUITE',
  capcode: 'PRIVATE_CODE',
  additionalFields: [
    { key: 'Latitude', value: '39.9' },
    { key: 'Longitude', value: '-75.35' },
    { key: 'Trucks', value: 'AMB01,MEDIC01' },
  ],
  ...patch,
});
test('Delco is recent, bounded, community paging with unknown active status and a strict public-field allowlist', () => {
  const s = parseDelcoPages(
    {
      pages: [
        page(),
        page({ pageId: 124, isStationPrivate: true }),
        page({ pageId: 125, timeReceived: '18:00:00' }),
        page({ pageId: 126, timeReceived: '22:30:00' }),
      ],
    },
    now,
  );
  assert.equal(s.rows.length, 1);
  assert.equal(s.limited, true);
  assert.equal(s.sourceLimit, 20);
  const row = s.rows[0];
  assert.equal(row.reportKind, 'dispatch');
  assert.equal(row.official, false);
  assert.equal(row.timeBasis, 'received');
  assert.equal(row.dispatchedAt, null);
  assert.equal(row.receivedAt, now - 60000);
  assert.equal(row.timezoneAssumed, true);
  assert.equal(row.mapPosition.kind, 'community-published');
  assert.deepEqual(row.assignedUnits, ['AMB01', 'MEDIC01']);
  for (const secret of [
    'PATIENT_SECRET',
    'RAW_SECRET',
    'PRIVATE_SUITE',
    'PRIVATE_CODE',
    'capcode',
    'additionalFields',
  ])
    assert.equal(JSON.stringify(s).includes(secret), false);
});
test('Delco collapses duplicate public pages, bounds lookback and row count, and tolerates malformed incident labels without guessing', () => {
  const a = page(),
    b = page({
      pageId: 124,
      timeReceived: '21:58:00',
      additionalFields: [{ key: 'Trucks', value: 'RESCUE01' }],
    });
  const rows = parseDelcoPages({ pages: [a, b] }, now).rows;
  assert.equal(rows.length, 1);
  assert.deepEqual(rows[0].assignedUnits, ['AMB01', 'MEDIC01', 'RESCUE01']);
  const malformed = parseDelcoPages(
    { pages: [page({ incidentNumber: 'F2600001 Beat:' })] },
    now,
  ).rows[0];
  assert.equal(malformed.incidentNumber, null);
  assert.match(malformed.id, /page-123$/);
  const many = Array.from({ length: 21 }, (_, i) =>
    page({ pageId: 1000 + i, incidentNumber: 'F' + (26000000 + i) }),
  );
  assert.equal(parseDelcoPages({ pages: many }, now).rows.length, 20);
  assert.throws(() =>
    parseDelcoPages({ pages: [page({ isStationPrivate: undefined })] }, now),
  );
  const invalid = parseDelcoPages(
    {
      pages: [
        page({
          additionalFields: [
            { key: 'Latitude', value: '80' },
            { key: 'Longitude', value: '-75' },
          ],
        }),
      ],
    },
    now,
  ).rows[0];
  assert.equal(invalid.mapPosition, null);
});
test('Delco requests only the newest public page, throttles failures, and marks cached dispatches stale', async () => {
  let calls = 0,
    clock = now,
    failed = false;
  const feed = createDelawareCountyFeed({
    now: () => clock,
    fetchImpl: async (url) => {
      calls++;
      assert.equal(url, DELCO_FEED);
      if (failed) throw new Error('offline');
      return Response.json({ pages: [page()] });
    },
  });
  await Promise.all([feed(), feed()]);
  assert.equal(calls, 1);
  clock += 60000;
  failed = true;
  assert.equal((await feed()).stale, true);
  await feed();
  assert.equal(calls, 2);
});
