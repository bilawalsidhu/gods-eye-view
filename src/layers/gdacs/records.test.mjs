import assert from 'node:assert/strict';
import test from 'node:test';
import {
  compareGdacsEvents,
  normalizeGdacsCollection,
  normalizeGdacsFeature,
  parseGdacsTime,
  sanitizeGdacsEvents,
} from './records.js';

/** A feature shaped like the live GDACS MAP feed (verified 2026-09-29). */
function gdacsFeature(overrides = {}, geometry = {}) {
  return {
    type: 'Feature',
    geometry: {
      type: 'Point',
      coordinates: [126.4511491, 7.0530672],
      ...geometry,
    },
    properties: {
      eventtype: 'FL',
      eventid: 1104176,
      episodeid: 3,
      name: 'Flood in Philippines',
      alertlevel: 'Green',
      country: 'Philippines',
      fromdate: '2026-09-18T01:00:00',
      todate: '2026-09-26T01:00:00',
      datemodified: '2026-09-28T10:03:44',
      iscurrent: 'true',
      severitydata: {
        severity: 0,
        severitytext: 'Magnitude 0 ',
        severityunit: '',
      },
      url: {
        report:
          'https://www.gdacs.org/report.aspx?eventid=1104176&episodeid=3&eventtype=FL',
      },
      Class: 'Point_Centroid',
      affectedcountries: [{ iso2: 'PH', countryname: 'Philippines' }],
      ...overrides,
    },
  };
}

test('GDACS stamps without a zone are read as UTC', () => {
  assert.equal(parseGdacsTime('2026-09-18T01:00:00'), Date.UTC(2026, 8, 18, 1));
  assert.equal(
    parseGdacsTime('2026-09-18T01:00:00Z'),
    Date.UTC(2026, 8, 18, 1),
  );
  assert.equal(
    parseGdacsTime('2026-09-18T03:00:00+02:00'),
    Date.UTC(2026, 8, 18, 1),
  );
  assert.equal(parseGdacsTime(''), null);
  assert.equal(parseGdacsTime('not a date'), null);
  assert.equal(parseGdacsTime(5), null);
});

test('an event centroid becomes a trimmed record', () => {
  assert.deepEqual(normalizeGdacsFeature(gdacsFeature()), {
    id: 'FL-1104176',
    type: 'FL',
    eventId: 1104176,
    episodeId: 3,
    level: 'green',
    name: 'Flood in Philippines',
    country: 'Philippines',
    lon: 126.4511491,
    lat: 7.0530672,
    fromMs: Date.UTC(2026, 8, 18, 1),
    toMs: Date.UTC(2026, 8, 26, 1),
    modifiedMs: Date.UTC(2026, 8, 28, 10, 3, 44),
    severity: '',
    current: true,
    reportUrl:
      'https://www.gdacs.org/report.aspx?eventid=1104176&episodeid=3&eventtype=FL',
  });
});

test('severity text, names, countries and report links are cleaned', () => {
  const record = normalizeGdacsFeature(
    gdacsFeature({
      eventtype: 'TC',
      alertlevel: 'Red',
      name: `  Tropical   Cyclone ${'X'.repeat(300)}`,
      country: '',
      affectedcountries: [
        { countryname: 'Japan' },
        { countryname: 'Guam' },
        {},
      ],
      severitydata: {
        severitytext: 'Tropical Storm (maximum wind speed of 111 km/h)',
      },
      url: { report: 'https://evil.example/report.aspx' },
      iscurrent: 'false',
    }),
  );
  assert.equal(record.level, 'red');
  assert.equal(record.name.length, 160);
  assert.ok(record.name.startsWith('Tropical Cyclone X'));
  assert.equal(record.country, 'Japan, Guam');
  assert.equal(
    record.severity,
    'Tropical Storm (maximum wind speed of 111 km/h)',
  );
  assert.equal(record.reportUrl, null);
  assert.equal(record.current, false);
  for (const report of [
    'http://www.gdacs.org/report.aspx',
    'https://www.gdacs.org.evil.example/report.aspx',
    'javascript:alert(1)',
  ])
    assert.equal(
      normalizeGdacsFeature(gdacsFeature({ url: { report } })).reportUrl,
      null,
    );
  assert.equal(
    normalizeGdacsFeature(gdacsFeature({ name: '' })).name,
    'Flood 1104176',
  );
});

test('track, footprint and malformed features are not events', () => {
  const rejected = [
    gdacsFeature({ Class: 'Point_Polygon_Point_0' }),
    gdacsFeature({ Class: 'Poly_Cones' }),
    gdacsFeature({ eventtype: 'XX' }),
    gdacsFeature({ eventid: 0 }),
    gdacsFeature({ eventid: 'abc' }),
    gdacsFeature({ alertlevel: 'Purple' }),
    gdacsFeature({}, { type: 'Polygon' }),
    gdacsFeature({}, { coordinates: [200, 0] }),
    gdacsFeature({}, { coordinates: [0, 91] }),
    gdacsFeature({}, { coordinates: ['1', 2] }),
    { properties: null },
    null,
  ];
  for (const feature of rejected)
    assert.equal(normalizeGdacsFeature(feature), null);
});

test('a feed keeps one record per event, the latest episode winning', () => {
  const events = normalizeGdacsCollection({
    features: [
      gdacsFeature({ episodeid: 2, alertlevel: 'Orange' }),
      gdacsFeature({ episodeid: 3 }),
      gdacsFeature({ episodeid: 1, alertlevel: 'Red' }),
      gdacsFeature({ Class: 'Point_Affected' }),
      gdacsFeature({ eventtype: 'EQ', eventid: 1104176 }),
    ],
  });
  assert.deepEqual(
    events.map(({ id, episodeId, level }) => [id, episodeId, level]),
    [
      ['FL-1104176', 3, 'green'],
      ['EQ-1104176', 3, 'green'],
    ],
  );
  assert.equal(normalizeGdacsCollection({}), null);
  assert.equal(normalizeGdacsCollection(null), null);
  assert.deepEqual(normalizeGdacsCollection({ features: [] }), []);
});

test('events sort by alert level, then most recent, then id', () => {
  const row = (id, level, toMs) => ({ id, level, toMs, fromMs: null });
  const sorted = [
    row('FL-1', 'green', 5),
    row('TC-2', 'red', 1),
    row('EQ-3', 'orange', 1),
    row('EQ-4', 'orange', 9),
    row('DR-5', 'green', 5),
  ].sort(compareGdacsEvents);
  assert.deepEqual(
    sorted.map(({ id }) => id),
    ['TC-2', 'EQ-4', 'EQ-3', 'DR-5', 'FL-1'],
  );
});

test('client validation keeps only well-formed proxy rows and their known fields', () => {
  const good = normalizeGdacsFeature(gdacsFeature());
  const red = normalizeGdacsFeature(
    gdacsFeature({ eventtype: 'TC', eventid: 1001, alertlevel: 'Red' }),
  );
  const events = sanitizeGdacsEvents([
    { ...good, injected: '<img src=x>', reportUrl: 'https://evil.example' },
    good,
    red,
    { ...good, id: 'FL-9', eventId: 9, level: 'purple' },
    { ...good, id: 'FL-8', eventId: 7 },
    { ...good, id: 'FL-10', eventId: 10, lat: 95 },
    { ...good, id: 'XX-11', type: 'XX', eventId: 11 },
    null,
  ]);
  assert.deepEqual(
    events.map(({ id }) => id),
    ['TC-1001', 'FL-1104176'],
  );
  assert.equal('injected' in events[1], false);
  assert.equal(events[1].reportUrl, null, 'the first copy of an id wins');
  assert.deepEqual(events[0], red);
  assert.equal(sanitizeGdacsEvents('nope'), null);
});
