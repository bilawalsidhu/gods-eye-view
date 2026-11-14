import test from 'node:test';
import assert from 'node:assert/strict';
import {
  parseDauphinList,
  parsePikeList,
  parseYorkList,
  createPikeCountyFeed,
  createYorkDetails,
} from './listFeeds.js';
import {
  parseAdamsCalls,
  createAdamsCountyFeed,
  createAdamsDetails,
} from './adams.js';
import { decodePublicSnapshot, parseLebanonSnapshot } from './lebanon.js';
import {
  COUNTIES,
  incidentSource,
  COUNTY_INCIDENT_ID_PATTERN,
} from '../../../src/layers/chesterCountyEms/counties.js';
const now = Date.parse('2026-11-04T04:15:00Z');
const tr = (values, tag = 'td') =>
  '<tr>' +
  values.map((v) => '<' + tag + '>' + v + '</' + tag + '>').join('') +
  '</tr>';
const dauphin = (street = 'EXAMPLE ST') =>
  ['Fire', 'Medical', 'Traffic']
    .map(
      (kind) =>
        '<h2>Active ' +
        kind +
        ' Events</h2><table>' +
        tr(
          [
            'DATE/TIME',
            'MUNICIPALITY',
            'STREET',
            'CROSS STREETS',
            'EVENT TYPE',
          ],
          'th',
        ) +
        (kind === 'Fire'
          ? tr([
              '11-03-2026 23:00:00',
              'TEST TWP',
              street,
              'ONE ST / TWO ST',
              'STRUCTURE FIRE',
            ])
          : '') +
        '</table>',
    )
    .join('');
const pike = (date = '11/3/2026') =>
  '<h1>Pike County Completed Incidents</h1><table>' +
  tr(['Fire Incidents']) +
  tr([
    '2611000001<br>' + date + ' 23:00:00',
    'ASSIST EMS- (FIRE)',
    'EXAMPLE ST<br>TEST TWP',
    'TEST ENGINE',
  ]) +
  tr(['Medical Incidents']) +
  tr(['Road Closures and Controlled Burns']) +
  '</table>';
const york = (link = 'Details.aspx?abc+/==') =>
  'Data as of: 11/3/2026 11:10:00 PM<h2>Active Incidents</h2><table>' +
  tr(
    [
      'Incident Type',
      'Dispatch Time',
      'Box No.',
      'Incident Type',
      'Street',
      'Cross Street',
      'Nearest Intersection',
      'Location',
      '',
    ],
    'th',
  ) +
  tr([
    'TRAFFIC',
    '11/3/2026 11:00 PM',
    '01-01',
    'MVA',
    'EXAMPLE ST',
    '',
    'ONE ST / TWO ST',
    'TEST TWP',
    '<a href="' + link + '">Details</a>',
  ]) +
  '</table>';
const healthy = (calls = []) => ({
  monitoring_active: true,
  system_error: false,
  data_degraded: false,
  timestamp: '11/03/2026 23:10:00',
  calls,
});
const call = {
  call_number: '12345',
  nature_of_call: 'Fire-Brush',
  location: 'EXAMPLE ST',
  create_date_time: '11-03-26 23:00:00',
  unit_details: [
    {
      unit_id: 'TEST01',
      unit_type: 'ENGINE',
      enroute_time: '11-03-26 23:02:00',
      arrive_time: '11-03-26 23:05:00',
      clear_time: '',
    },
  ],
  notes: 'MUST NOT FORWARD',
};

test('nine source registry keeps Pike completed reports opt-in and source URLs constrained', () => {
  assert.equal(COUNTIES.length, 9);
  assert.equal(COUNTIES.find((c) => c.id === 'pike-pa').defaultEnabled, false);
  for (const row of [
    parseDauphinList(dauphin(), now).rows[0],
    parsePikeList(pike(), now).rows[0],
    parseYorkList(york()).rows[0],
    parseAdamsCalls(healthy([call])).rows[0],
  ]) {
    assert.match(row.id, new RegExp(COUNTY_INCIDENT_ID_PATTERN));
    assert.ok(incidentSource(row));
    assert.equal(
      incidentSource({ ...row, detailUrl: 'https://example.com/' }),
      null,
    );
  }
});
test('Dauphin preserves fields without inventing dispatch times, IDs or coordinates', () => {
  const snapshot = parseDauphinList(dauphin(), now),
    row = snapshot.rows[0];
  assert.equal(snapshot.timestampBasis, 'retrieved');
  assert.equal(row.incidentNumber, null);
  assert.equal(row.dispatchedAt, null);
  assert.equal(row.reportedAt, Date.parse('2026-11-04T04:00:00Z'));
  assert.equal(row.mapPosition, null);
  assert.equal(row.locationStatus, 'not-published');
  assert.equal(row.crossStreets, 'ONE ST / TWO ST');
  assert.equal(row.id, parseDauphinList(dauphin(), now + 1000).rows[0].id);
  assert.throws(() =>
    parseDauphinList(dauphin().replaceAll('DATE/TIME', 'TIME')),
  );
});
test('Pike fetches only the Eastern current date and explicitly marks completed reports', async () => {
  let requested;
  const feed = createPikeCountyFeed({
    now: () => now,
    fetchImpl: async (url) => {
      requested = new URL(url);
      return new Response(pike());
    },
  });
  const snapshot = await feed(),
    row = snapshot.rows[0];
  assert.equal(requested.searchParams.get('ddlOriginationDate'), '11/3/2026');
  assert.equal(snapshot.coverageKind, 'completed-reports');
  assert.equal(row.reportKind, 'completed');
  assert.equal(row.official, true);
  assert.equal(row.dispatchedAt, null);
  assert.equal(row.assignedUnits[0], 'TEST ENGINE');
  assert.equal(parsePikeList(pike('11/2/2026'), now).rows.length, 0);
  assert.throws(() => parsePikeList('<h1>Login</h1>', now));
});
test('York uses listed opaque details only and returns assignments without fabricated clocks', async () => {
  const snapshot = { ...parseYorkList(york()), fetchedAt: now },
    row = snapshot.rows[0];
  assert.equal(row.timePrecision, 'minute');
  assert.equal(row.nearestIntersection, 'ONE ST / TWO ST');
  let fetched = 0;
  const details = createYorkDetails({
    getSnapshot: async () => snapshot,
    now: () => now,
    fetchImpl: async (url) => {
      fetched++;
      assert.equal(url, row.detailUrl);
      return new Response(
        '<h2>Incident Details</h2><table class="incidentList">' +
          tr(['Unit Number', 'Description'], 'th') +
          tr(['TEST01', 'BLS']) +
          '</table>',
      );
    },
  });
  await assert.rejects(details('york-pa:ems:' + 'a'.repeat(24)), {
    statusCode: 404,
  });
  assert.equal(fetched, 0);
  const value = await details(row.id);
  await details(row.id);
  assert.equal(fetched, 1);
  assert.equal(value.assignmentOnly, true);
  assert.equal(value.units[0].enteredAt, null);
  assert.equal(value.units[0].description, 'BLS');
  assert.throws(() => parseYorkList(york('https://example.com/secret')));
});
test('Adams healthy-empty differs from failed monitoring; public unit status keeps its real date', async () => {
  assert.equal(parseAdamsCalls(healthy()).rows.length, 0);
  for (const bad of [
    { monitoring_active: false },
    { system_error: true },
    { data_degraded: true },
  ])
    assert.throws(() => parseAdamsCalls({ ...healthy(), ...bad }));
  const snapshot = parseAdamsCalls(
    healthy([call, { ...call, nature_of_call: 'UNRECOGNIZED' }]),
  );
  assert.equal(snapshot.excludedCount, 1);
  assert.equal(snapshot.limited, true);
  assert.equal(snapshot.rows[0].reportedAt, Date.parse('2026-11-04T04:00:00Z'));
  assert.equal(JSON.stringify(snapshot).includes('MUST NOT FORWARD'), false);
  const details = await createAdamsDetails({
    getSnapshot: async () => snapshot,
  })(snapshot.rows[0].id);
  assert.equal(details.units[0].status, 'On Scene');
  assert.equal(details.units[0].enteredAt, Date.parse('2026-11-04T04:05:00Z'));
  let time = Date.parse('2026-11-04T04:10:00Z'),
    failed = false;
  const feed = createAdamsCountyFeed({
    now: () => time,
    fetchImpl: async () =>
      new Response(
        JSON.stringify({ ...healthy([call]), data_degraded: failed }),
      ),
  });
  assert.equal((await feed()).stale, false);
  time += 61000;
  failed = true;
  const retained = await feed();
  assert.equal(retained.stale, true);
  assert.equal(retained.rows.length, 1);
});
test('Lebanon filters recent pager data, ignores resolved/private summaries, notes and EMS centroid pins', () => {
  const item = {
    id: 'test',
    incidentNumber: 'LEB-26-000001',
    county: 'lebanon',
    title: 'FIRE ALARM',
    type: 'fire',
    location: 'EXAMPLE ST',
    dispatchedAt: now - 60000,
    status: 'active',
    units: ['TEST01'],
    geocodeSource: 'google',
    lat: 40.35,
    lng: -76.42,
    notes: 'MUST NOT FORWARD',
    description: 'MUST NOT FORWARD',
  };
  const data = {
    fetchedAt: new Date(now).toISOString(),
    sources: [{ name: 'lcdes.org', ok: true }],
    incidents: [
      item,
      {
        ...item,
        id: 'ems',
        incidentNumber: 'EMS',
        type: 'ems',
        geocodeSource: 'centroid',
        geocodeApprox: true,
      },
      { ...item, incidentNumber: 'old', dispatchedAt: now - 7200001 },
      { ...item, incidentNumber: 'closed', status: 'resolved' },
      { ...item, incidentNumber: 'closed', status: 'active', dispatchedAt: now - 120000 },
      { ...item, incidentNumber: 'hidden', status: 'active', dispatchedAt: now - 120000 },
      { ...item, incidentNumber: 'hidden', redacted: true },
      { ...item, incidentNumber: 'elsewhere', county: 'york' },
    ],
  };
  const snapshot = parseLebanonSnapshot(data, now);
  assert.equal(snapshot.rows.length, 2);
  assert.equal(snapshot.rows[0].mapPosition.kind, 'community-published');
  assert.equal(snapshot.rows[1].mapPosition, null);
  assert.equal(snapshot.rows[0].reportKind, 'dispatch');
  assert.equal(snapshot.rows[0].incidentNumber, null);
  assert.equal(snapshot.rows[0].dispatchedAt, null);
  assert.equal(snapshot.rows[0].official, false);
  assert.equal(JSON.stringify(snapshot).includes('MUST NOT FORWARD'), false);
  assert.throws(() =>
    parseLebanonSnapshot(
      { ...data, sources: [{ name: 'lcdes.org', ok: false }] },
      now,
    ),
  );
});
test('Lebanon serialized public data decoder rejects code, prototype keys and schema drift', () => {
  const str = (s) => ({ t: 1, s }),
    obj = (k, v) => ({ t: 10, p: { k, v } });
  const decoded = decodePublicSnapshot(
    obj(
      ['result', 'error'],
      [
        obj(
          ['sources', 'incidents', 'fetchedAt'],
          [{ t: 9, a: [] }, { t: 9, a: [] }, str('2026-11-04T04:15:00Z')],
        ),
        { t: 2, s: 1 },
      ],
    ),
  );
  assert.deepEqual(decoded.incidents, []);
  assert.throws(() =>
    decodePublicSnapshot(obj(['result'], [{ t: 99, s: 'eval()' }])),
  );
  assert.throws(() => decodePublicSnapshot(obj(['__proto__'], [str('bad')])));
});
