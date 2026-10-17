import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  SA_ROAD_EVENT_LIMITS,
  SA_ROAD_POINT_KINDS,
  SA_ROAD_WORKS_KINDS,
  adelaideWallClockToInstant,
  cleanText,
  lineKind,
  normalizeSaRoadEventLines,
  normalizeSaRoadEventPoints,
  normalizeSaRoadEventSnapshot,
  parseTrafficDirection,
  pointKind,
  validateSaRoadEventsPayload,
} from './records.js';

const fixture = (name) =>
  JSON.parse(
    readFileSync(
      new URL(`../../data/fixtures/${name}`, import.meta.url),
      'utf8',
    ),
  );
const pointsFixture = fixture('trafficsa-points-sample.json');
const linesFixture = fixture('trafficsa-lines.json');

const collection = (features) => ({ type: 'FeatureCollection', features });
const point = (properties = {}, coordinates = [138.6, -34.9]) => ({
  type: 'Feature',
  id: 1,
  geometry: { type: 'Point', coordinates },
  properties: {
    ROADWORKS_AND_INCIDENTS_ID: '100',
    REC_TYPE: 'INCIDENT',
    ...properties,
  },
});
const line = (properties = {}, geometry) => ({
  type: 'Feature',
  id: 7,
  geometry: geometry || {
    type: 'LineString',
    coordinates: [
      [138.6, -34.9],
      [138.61, -34.91],
    ],
  },
  properties: { LOCATION_ID: 7, PLOT_TYPE: 'RD_CLOSURE', ...properties },
});

test('real point rows keep their kind, text, times and coordinates', () => {
  const { records, skipped } = normalizeSaRoadEventPoints(pointsFixture);
  assert.equal(skipped, 0);
  assert.equal(records.length, pointsFixture.features.length);
  const kinds = new Set(records.map(({ kind }) => kind));
  assert.deepEqual([...kinds].sort(), ['incident', 'works', 'works24']);
  const incident = records.find(({ kind }) => kind === 'incident');
  assert.equal(incident.id, '3398487668');
  assert.equal(incident.description, 'Ferry Closed');
  assert.equal(incident.road, 'Birdsville Track');
  assert.equal(incident.endMs, null, 'an open-ended incident has no end');
  assert.equal(incident.startMs, Date.parse('2026-04-08T15:40:50+09:30'));
  assert.equal(incident.direction, null);
  assert.ok(Math.abs(incident.lon - 138.6395252) < 1e-6);
  assert.ok(Math.abs(incident.lat - -28.7112356) < 1e-6);
  const works = records.find(({ id }) => id === '3398487791');
  assert.equal(works.kind, 'works');
  assert.equal(works.sideStreet, 'Patricia St');
  assert.equal(works.suburb, 'Woodville South');
  assert.equal(works.direction, 'South Bound');
  assert.equal(works.lanesClosed, 'One Lane');
  assert.equal(works.speedLimit, '40');
  assert.equal(works.endMs, Date.parse('2026-10-19T16:00:00+10:30'));
  assert.equal(works.startMs, Date.parse('2026-10-05T09:00:00+10:30'));
});

test('upstream wall-clock times become real instants across daylight saving', () => {
  const wall = (iso) => Date.parse(`${iso}Z`);
  // Winter (ACST, +09:30) and summer (ACDT, +10:30).
  assert.equal(
    adelaideWallClockToInstant(wall('2025-09-01T20:00:00')),
    Date.parse('2025-09-01T20:00:00+09:30'),
  );
  assert.equal(
    adelaideWallClockToInstant(wall('2026-01-15T08:00:00')),
    Date.parse('2026-01-15T08:00:00+10:30'),
  );
  // The weekend daylight saving starts (4 Oct 2026, 02:00 -> 03:00).
  assert.equal(
    adelaideWallClockToInstant(wall('2026-10-04T01:59:00')),
    Date.parse('2026-10-04T01:59:00+09:30'),
  );
  assert.equal(
    adelaideWallClockToInstant(wall('2026-10-04T03:30:00')),
    Date.parse('2026-10-04T03:30:00+10:30'),
  );
  for (const bad of [null, undefined, NaN, 'x', Infinity, 1e20])
    assert.equal(adelaideWallClockToInstant(bad), null);
});

test('REC_TYPE and PLOT_TYPE map to kinds; anything new is unknown', () => {
  assert.equal(pointKind('INCIDENT'), 'incident');
  assert.equal(pointKind(' 24hr roadworks '), 'works24');
  assert.equal(pointKind('ROADWORKS'), 'works');
  assert.equal(pointKind('HAZARD'), 'unknown');
  assert.equal(pointKind(null), 'unknown');
  assert.equal(lineKind('RD_CLOSURE'), 'closure');
  assert.equal(lineKind('RD_DETOUR'), 'detour');
  assert.equal(lineKind('SOMETHING_ELSE'), 'unknown');
  assert.equal(lineKind(undefined), 'unknown');
});

test('real closure lines normalize, including a null END_DATE and CRLF details', () => {
  const { records, skipped } = normalizeSaRoadEventLines(linesFixture);
  assert.equal(skipped, 0);
  assert.equal(records.length, 8);
  assert.ok(records.every(({ kind }) => kind === 'closure'));
  const flood = records.find(({ id }) => id === '105527');
  assert.equal(flood.endMs, null);
  assert.equal(flood.road, 'MORGAN VALE ROAD');
  assert.deepEqual(flood.startStreets, ['PINE VALLEY RD']);
  assert.deepEqual(flood.endStreets, ['MORGAN MAIL RD']);
  assert.equal(flood.startSuburb, 'PINE VALLEY STATION');
  assert.equal(flood.endSuburb, 'CANEGRASS');
  assert.equal(
    flood.details,
    'MORGAN MAIL RD Closed due to flooding over road\n\nRef# 2138578',
    'CRLF becomes newlines and no carriage return survives',
  );
  assert.ok(!records.some(({ details }) => details?.includes('\r')));
  const dated = records.find(({ id }) => id === '105525');
  assert.equal(dated.endMs, 1806604620000 - 10.5 * 3600000);
  assert.ok(
    !dated.details.includes('<br>'),
    'markup inside PLOT_DETAILS is not kept',
  );
  assert.equal(flood.lines.length, 1);
  assert.equal(flood.lines[0].length, 13);
  assert.deepEqual(flood.anchor, flood.lines[0][6]);
});

test('MultiLineString geometry is accepted as several lines of one event', () => {
  const result = normalizeSaRoadEventLines(
    collection([
      line(
        {},
        {
          type: 'MultiLineString',
          coordinates: [
            [
              [138.6, -34.9],
              [138.61, -34.91],
            ],
            [
              [138.7, -34.8],
              [138.71, -34.81],
            ],
          ],
        },
      ),
    ]),
  );
  assert.equal(result.records[0].lines.length, 2);
});

test('text is plain: markup, controls and oversize input are neutralised', () => {
  assert.equal(
    cleanText('<script>alert(1)</script>Hello<br/>World <b>now</b>'),
    'alert(1) Hello\nWorld now',
  );
  assert.equal(
    cleanText('  a\u0000b\u202ec \r\n\r\n\r\n\r\nd  '),
    'a b c\n\nd',
  );
  assert.equal(cleanText('   '), null);
  assert.equal(cleanText(42), null);
  assert.equal(cleanText('x'.repeat(500), 10).length, 10);
  assert.ok(cleanText('x'.repeat(500), 10).endsWith('…'));
  const { records } = normalizeSaRoadEventPoints(
    collection([
      point({ DESCRIPTION: '<img src=x onerror=alert(1)>Crash', SUBURB: ' ' }),
    ]),
  );
  assert.equal(records[0].description, 'Crash');
  assert.equal(records[0].suburb, null);
});

test('rows with bad geometry, ids or coordinates are skipped, not fatal', () => {
  const id = (value) => ({ ROADWORKS_AND_INCIDENTS_ID: value });
  const { records, skipped } = normalizeSaRoadEventPoints(
    collection([
      point(id('1')),
      null,
      { type: 'Feature', geometry: null, properties: {} },
      point(id('2'), [NaN, -34.9]),
      point(id('3'), [151.2, -33.9]),
      point(id('4'), [138.6, 34.9]),
      point(id('5'), [138.6]),
      { ...point(id('6')), properties: [] },
      { ...point(id('7')), geometry: { type: 'LineString', coordinates: [] } },
      point(id('bad id!')),
      { ...point(id(null)), id: undefined },
    ]),
  );
  assert.deepEqual(
    records.map((record) => record.id),
    ['1'],
  );
  assert.equal(skipped, 10);
});

test('the SA bounds include the state edges and reject neighbours', () => {
  const at = (lon, lat) =>
    normalizeSaRoadEventPoints(collection([point({}, [lon, lat])]));
  assert.ok(at(129.0, -31.7), 'Nullarbor edge');
  assert.ok(at(140.9, -37.5), 'Mount Gambier');
  assert.ok(at(135.8, -25.9), 'northern border');
  assert.equal(at(145, -37.8), null, 'Melbourne');
  assert.equal(at(115.9, -31.9), null, 'Perth');
  assert.equal(at(0, 0), null, 'null island');
});

test('duplicate ids keep the first row only', () => {
  const { records, skipped } = normalizeSaRoadEventPoints(
    collection([
      point({ DESCRIPTION: 'first' }),
      point({ DESCRIPTION: 'second' }),
    ]),
  );
  assert.equal(records.length, 1);
  assert.equal(records[0].description, 'first');
  assert.equal(skipped, 1);
  const lines = normalizeSaRoadEventLines(
    collection([line({}), line({ PLOT_DETAILS: 'again' })]),
  );
  assert.equal(lines.records.length, 1);
  assert.equal(lines.skipped, 1);
});

test('the numeric feature id is used when the id property is missing', () => {
  const { records } = normalizeSaRoadEventPoints(
    collection([point({ ROADWORKS_AND_INCIDENTS_ID: undefined })]),
  );
  assert.equal(records[0].id, '1');
});

test('payloads that are not feature collections are rejected whole', () => {
  const empty = collection([]);
  for (const bad of [
    null,
    undefined,
    [],
    'File Unavailable',
    { error: { code: 400, message: 'Failed to execute query.' } },
    { type: 'Feature', features: [] },
    { type: 'FeatureCollection' },
    { type: 'FeatureCollection', features: {} },
  ]) {
    assert.equal(normalizeSaRoadEventPoints(bad), null);
    assert.equal(normalizeSaRoadEventLines(bad), null);
    assert.equal(
      normalizeSaRoadEventSnapshot({ points: bad, lines: empty }),
      null,
    );
    assert.equal(
      normalizeSaRoadEventSnapshot({ points: empty, lines: bad }),
      null,
    );
  }
  assert.equal(normalizeSaRoadEventSnapshot(null), null);
});

test('a collection with rows but no usable row is a failure; an empty one is not', () => {
  assert.equal(
    normalizeSaRoadEventPoints(
      collection([{ type: 'Feature', properties: {}, geometry: null }]),
    ),
    null,
    'a schema change must not look like an empty network',
  );
  assert.deepEqual(normalizeSaRoadEventPoints(collection([])), {
    records: [],
    skipped: 0,
    ignored: 0,
  });
  assert.deepEqual(
    normalizeSaRoadEventSnapshot({
      points: collection([point()]),
      lines: collection([]),
    }).lines,
    [],
    'no active closures is a valid state',
  );
});

test('long lines are thinned to the vertex bound and keep both endpoints', () => {
  const coordinates = Array.from({ length: 5000 }, (_, i) => [
    138 + i / 10000,
    -34.5,
  ]);
  const { records } = normalizeSaRoadEventLines(
    collection([line({}, { type: 'LineString', coordinates })]),
  );
  const [vertices] = records[0].lines;
  assert.ok(vertices.length <= SA_ROAD_EVENT_LIMITS.maxLineVertices + 1);
  assert.deepEqual(vertices[0], [138, -34.5]);
  assert.deepEqual(vertices.at(-1), [138.4999, -34.5]);
});

test('the snapshot-wide vertex budget skips lines instead of growing without bound', () => {
  const longLine = (id) =>
    line(
      { LOCATION_ID: id },
      {
        type: 'LineString',
        coordinates: Array.from({ length: 1000 }, (_, i) => [
          138 + i / 100000,
          -34.5,
        ]),
      },
    );
  const features = Array.from({ length: 80 }, (_, i) => longLine(i + 1));
  const { records, skipped } = normalizeSaRoadEventLines(collection(features));
  const vertices = records.reduce(
    (sum, record) => sum + record.lines.reduce((n, l) => n + l.length, 0),
    0,
  );
  assert.ok(vertices <= SA_ROAD_EVENT_LIMITS.maxTotalVertices);
  assert.ok(skipped > 0);
});

test('lines with out-of-state, malformed or too-short geometry are skipped', () => {
  const bad = (geometry, id) => line({ LOCATION_ID: id }, geometry);
  const { records, skipped } = normalizeSaRoadEventLines(
    collection([
      line({ LOCATION_ID: 1 }),
      bad({ type: 'Point', coordinates: [138.6, -34.9] }, 2),
      bad({ type: 'LineString', coordinates: [[138.6, -34.9]] }, 3),
      bad(
        {
          type: 'LineString',
          coordinates: [
            [138.6, -34.9],
            [151.2, -33.9],
          ],
        },
        4,
      ),
      bad({ type: 'LineString', coordinates: 'nope' }, 5),
      bad({ type: 'MultiLineString', coordinates: [] }, 6),
    ]),
  );
  assert.deepEqual(
    records.map((record) => record.id),
    ['1'],
  );
  assert.equal(skipped, 5);
});

// Thinning only decides which vertices are drawn; every source vertex is still
// checked, so a bad point the stride skips cannot ride in with a good line.
test('line admission checks every source vertex, not just the thinned ones', () => {
  const longLine = (mutate) => {
    const coordinates = Array.from({ length: 5000 }, (_, i) => [
      138 + i / 100000,
      -34.5,
    ]);
    mutate(coordinates);
    return coordinates;
  };
  const only = (properties, geometry) =>
    normalizeSaRoadEventLines(collection([line(properties, geometry)]));
  const lineString = (coordinates) => ({ type: 'LineString', coordinates });

  // 5,000 points thin with stride 6, so indexes 1-5 are never sampled.
  assert.equal(
    only(
      { LOCATION_ID: 'thinning-repro', PLOT_TYPE: 'RD_CLOSURE' },
      lineString(
        longLine((points) => {
          points[1] = [151, -34.5];
        }),
      ),
    ),
    null,
    'an out-of-state vertex between sampled ones is not silently dropped',
  );
  for (const [name, bad] of [
    ['NaN', [Number.NaN, -34.5]],
    ['null', null],
    ['a numeric-string longitude', ['138.5', -34.5]],
    ['a missing latitude', [138.5]],
  ])
    assert.equal(
      only(
        {},
        lineString(
          longLine((points) => {
            points[2] = bad;
          }),
        ),
      ),
      null,
      `${name} at an unsampled index rejects the line`,
    );

  assert.equal(
    only(
      {},
      {
        type: 'MultiLineString',
        coordinates: [
          longLine(() => {}),
          longLine((points) => {
            points[3] = [151, -34.5];
          }),
        ],
      },
    ),
    null,
    'corruption in a later part of a MultiLineString is rejected',
  );

  // Controls: valid geometry still normalises, and the vertex cap is unchanged.
  const single = only({}, lineString(longLine(() => {})));
  assert.equal(single.records.length, 1);
  assert.ok(
    single.records[0].lines[0].length <=
      SA_ROAD_EVENT_LIMITS.maxLineVertices + 1,
  );
  const multi = only(
    {},
    {
      type: 'MultiLineString',
      coordinates: [longLine(() => {}), longLine(() => {})],
    },
  );
  assert.equal(multi.records[0].lines.length, 2);
  // A bad vertex on a sampled index (0, 6, 12, ...) is still rejected.
  assert.equal(
    only(
      {},
      lineString(
        longLine((points) => {
          points[6] = [151, -34.5];
        }),
      ),
    ),
    null,
  );
});

const incidentsFixture = fixture('trafficsa-geohub-incidents.json');
const closuresFixture = fixture('trafficsa-geohub-closures.json');

test('incident-class rec_types get their own kinds; anything else stays unknown', () => {
  assert.equal(pointKind('COLLISION'), 'collision');
  assert.equal(pointKind(' flooding '), 'flooding');
  assert.equal(pointKind('EMERGENCY WATERWORKS'), 'waterworks');
  assert.equal(pointKind('SOMETHING NEW'), 'unknown');
  for (const kind of ['incident', 'collision', 'flooding', 'waterworks'])
    assert.ok(SA_ROAD_POINT_KINDS.includes(kind));
  assert.ok(SA_ROAD_WORKS_KINDS.every((k) => SA_ROAD_POINT_KINDS.includes(k)));
  assert.ok(!SA_ROAD_WORKS_KINDS.includes('incident'));
});

test('geohub incident rows normalize: lower-case fields, object-id ids, local dates', () => {
  const { records, skipped, ignored } = normalizeSaRoadEventPoints(
    incidentsFixture,
    { source: 'incidents' },
  );
  assert.equal(skipped, 0);
  assert.equal(ignored, 0);
  assert.equal(records.length, incidentsFixture.features.length);
  assert.deepEqual([...new Set(records.map(({ kind }) => kind))].sort(), [
    'collision',
    'flooding',
    'incident',
    'waterworks',
  ]);
  // Ids come from the numeric object id: the long roadworks_and_incidents_id
  // strings hold punctuation and exceed the id pattern.
  assert.ok(records.every(({ id }) => /^inc-\d+$/.test(id)));
  const ferry = records.find(({ id }) => id === 'inc-3');
  assert.equal(ferry.description, 'Ferry Closed');
  assert.equal(ferry.road, 'Cooper Creek Ferry Crossing');
  assert.equal(ferry.sideStreet, 'Birdsville Trk');
  assert.equal(ferry.suburb, 'ETADUNNA');
  assert.equal(ferry.direction, null, '"[]" carries no direction');
  assert.equal(ferry.lanesClosed, null);
  assert.equal(ferry.endMs, null);
  // start_date_string "Tue 04 Aug 2026 08:24 AM", ACST (+09:30)
  assert.equal(ferry.startMs, Date.parse('2026-08-04T08:24:12.500+09:30'));
  const breakdown = records.find(({ id }) => id === 'inc-5780');
  assert.equal(breakdown.direction, 'NORTHBOUND');
  assert.equal(breakdown.lanesClosed, '1');
  assert.equal(breakdown.speedLimit, '40');
  // start_date_string "Fri 16 Oct 2026 11:05 PM", ACDT (+10:30)
  assert.equal(breakdown.startMs, Date.parse('2026-10-16T23:05:11.410+10:30'));
  const collision = records.find(({ kind }) => kind === 'collision');
  assert.equal(collision.direction, 'NORTHBOUND / EASTBOUND / SOUTHBOUND');
  assert.equal(collision.lanesClosed, null, 'every lanes_closed is 0');
  assert.equal(
    validateSaRoadEventsPayload({
      points: records,
      lines: [],
      fetchedAt: 1,
    }).points.length,
    records.length,
  );
});

test('an incident id never collides with a roadworks id', () => {
  const roadworks = normalizeSaRoadEventPoints(pointsFixture, {
    source: 'roadworks',
  }).records;
  const incidents = normalizeSaRoadEventPoints(incidentsFixture, {
    source: 'incidents',
  }).records;
  const ids = [...roadworks, ...incidents].map(({ id }) => id);
  assert.equal(new Set(ids).size, ids.length);
  assert.equal(
    validateSaRoadEventsPayload({
      points: [...roadworks, ...incidents],
      lines: [],
      fetchedAt: 1,
    })?.points.length,
    ids.length,
  );
});

test('the roadworks group keeps roadworks only; legacy INCIDENT rows are ignored, not failures', () => {
  const { records, skipped, ignored } = normalizeSaRoadEventPoints(
    pointsFixture,
    { source: 'roadworks' },
  );
  assert.deepEqual([...new Set(records.map(({ kind }) => kind))].sort(), [
    'works',
    'works24',
  ]);
  assert.equal(ignored, 1, 'the fixture carries one stale INCIDENT row');
  assert.equal(skipped, 0);
  assert.equal(records.length + ignored, pointsFixture.features.length);
  // A roadworks payload that is only stale incidents is empty, not broken...
  const onlyIncident = collection(
    pointsFixture.features.filter((f) => f.properties.REC_TYPE === 'INCIDENT'),
  );
  assert.deepEqual(
    normalizeSaRoadEventPoints(onlyIncident, { source: 'roadworks' }),
    { records: [], skipped: 0, ignored: 1 },
  );
  // ...but unusable rows still reject the group.
  assert.equal(
    normalizeSaRoadEventPoints(
      collection([{ type: 'Feature', properties: {}, geometry: null }]),
      { source: 'roadworks' },
    ),
    null,
  );
});

test('traffic_dir parses the JSON string defensively and never throws', () => {
  const json = (value) => JSON.stringify(value);
  assert.deepEqual(
    parseTrafficDirection(
      json([
        { direction: 'NORTHBOUND', lanes_closed: 1 },
        { direction: 'SOUTHBOUND', lanes_closed: 0 },
      ]),
    ),
    { direction: 'NORTHBOUND / SOUTHBOUND', lanesClosed: '1 NORTHBOUND' },
  );
  assert.deepEqual(
    parseTrafficDirection(
      json([
        { direction: 'EASTBOUND', lanes_closed: 2 },
        { direction: 'WESTBOUND', lanes_closed: 1 },
      ]),
    ),
    {
      direction: 'EASTBOUND / WESTBOUND',
      lanesClosed: '2 EASTBOUND, 1 WESTBOUND',
    },
  );
  assert.deepEqual(
    parseTrafficDirection(json([{ direction: 'NORTHBOUND', lanes_closed: 3 }])),
    { direction: 'NORTHBOUND', lanesClosed: '3' },
  );
  assert.deepEqual(
    parseTrafficDirection(
      json([{ direction: 'NORTHBOUND', lanes_closed: '2' }]),
    ),
    { direction: 'NORTHBOUND', lanesClosed: '2' },
    'a numeric string is a lane count',
  );
  const none = { direction: null, lanesClosed: null };
  for (const empty of ['[]', '', '   ', null, undefined, 5, {}, [], '{}'])
    assert.deepEqual(parseTrafficDirection(empty), none, String(empty));
  for (const malformed of [
    '[{"direction": "NORTHBOUND"',
    '[not json]',
    '[1, 2, null, "x"]',
    '[{"lanes_closed": 1}]',
    '[{"direction": 5, "lanes_closed": 1}]',
    '{"direction":"NORTHBOUND"}',
    '[' + 'x'.repeat(5000) + ']',
  ])
    assert.deepEqual(
      parseTrafficDirection(malformed),
      none,
      malformed.slice(0, 30),
    );
  // Odd lane counts are dropped, the direction is kept.
  for (const lanes of [-1, 1.5, 1000, 'many', null, NaN])
    assert.deepEqual(
      parseTrafficDirection(
        json([{ direction: 'NORTHBOUND', lanes_closed: lanes }]),
      ),
      { direction: 'NORTHBOUND', lanesClosed: null },
      String(lanes),
    );
  // The roadworks service still sends plain text.
  assert.deepEqual(parseTrafficDirection('South Bound'), {
    direction: 'South Bound',
    lanesClosed: null,
  });
  assert.equal(
    parseTrafficDirection(
      json(
        Array.from({ length: 20 }, (_, i) => ({
          direction: 'D' + i,
          lanes_closed: 1,
        })),
      ),
    ).direction.length <= 80,
    true,
    'the shown text is bounded',
  );
  // A bad traffic_dir on a row costs that row nothing but its direction.
  const row = point({ traffic_dir: '[{oops' }, [138.6, -34.9]);
  const { records } = normalizeSaRoadEventPoints(collection([row]));
  assert.equal(records[0].direction, null);
});

test('no_lanes_closed text is the lanes fallback when traffic_dir has none', () => {
  const row = point({
    NO_LANES_CLOSED: 'One Lane',
    TRAFFIC_DIR: 'South Bound',
  });
  const [record] = normalizeSaRoadEventPoints(collection([row])).records;
  assert.equal(record.lanesClosed, 'One Lane');
  assert.equal(record.direction, 'South Bound');
});

test('geohub closure rows normalize: GUID ids, HTML stripped, wall-clock dates', () => {
  const { records, skipped } = normalizeSaRoadEventLines(closuresFixture);
  assert.equal(skipped, 0);
  assert.equal(records.length, closuresFixture.features.length);
  assert.deepEqual([...new Set(records.map(({ kind }) => kind))].sort(), [
    'closure',
    'detour',
  ]);
  assert.ok(
    records.every(({ id }) =>
      /^[0-9A-F]{8}(-[0-9A-F]{4}){3}-[0-9A-F]{12}$/.test(id),
    ),
    'location_id GUIDs lose their braces',
  );
  const belton = records.find(({ road }) => road === 'BELTON ROAD');
  assert.match(belton.details, /^District Council of Orroroo Carrieton/);
  assert.ok(!/[<>]/.test(belton.details), 'the <p> markup is stripped');
  assert.deepEqual(belton.startStreets, ['WIERRA DOWNS RD']);
  assert.deepEqual(belton.endStreets, [], 'a blank end street is dropped');
  assert.equal(belton.endMs, null);
  assert.equal(belton.startMs, Date.parse('2026-03-13T18:00:00+10:30'));
  const detour = records.find(({ kind }) => kind === 'detour');
  assert.equal(detour.road, 'TEMPLETON ROAD');
  assert.ok(Number.isFinite(detour.endMs) && detour.endMs > detour.startMs);
  assert.equal(
    validateSaRoadEventsPayload({ points: [], lines: records, fetchedAt: 1 })
      ?.lines.length,
    records.length,
  );
});

test('the payload carries per-group source status, defaulting to all live', () => {
  const body = { points: [], lines: [], fetchedAt: 1_700_000_000_000 };
  assert.deepEqual(validateSaRoadEventsPayload(body).sources, {
    roadworks: { status: 'live', fetchedAt: body.fetchedAt, mirror: false },
    incidents: { status: 'live', fetchedAt: body.fetchedAt, mirror: false },
    closures: { status: 'live', fetchedAt: body.fetchedAt, mirror: false },
  });
  assert.equal(
    validateSaRoadEventsPayload({ ...body, stale: true }).sources.closures
      .status,
    'stale',
  );
  const sources = {
    roadworks: { status: 'live', fetchedAt: 5, mirror: true },
    incidents: { status: 'stale', fetchedAt: 3 },
    closures: { status: 'unavailable', fetchedAt: null },
  };
  const ok = validateSaRoadEventsPayload({ ...body, sources });
  assert.equal(ok.sources.roadworks.mirror, true);
  assert.equal(ok.sources.incidents.mirror, false);
  assert.equal(ok.sources.closures.status, 'unavailable');
  for (const bad of [
    null,
    [],
    'live',
    { ...sources, closures: undefined },
    { ...sources, closures: { status: 'down', fetchedAt: null } },
    { ...sources, closures: { status: 'live', fetchedAt: 'now' } },
    { ...sources, closures: { status: 'unavailable', fetchedAt: 4 } },
    { roadworks: sources.roadworks, incidents: sources.incidents },
  ])
    assert.equal(
      validateSaRoadEventsPayload({ ...body, sources: bad }),
      null,
      JSON.stringify(bad),
    );
});

// Thinning only decides which vertices are drawn; every source vertex is still
// checked, so a bad point the stride skips cannot ride in with a good line.
test('line admission checks every source vertex, not just the thinned ones', () => {
  const longLine = (mutate) => {
    const coordinates = Array.from({ length: 5000 }, (_, i) => [
      138 + i / 100000,
      -34.5,
    ]);
    mutate(coordinates);
    return coordinates;
  };
  const only = (properties, geometry) =>
    normalizeSaRoadEventLines(collection([line(properties, geometry)]));
  const lineString = (coordinates) => ({ type: 'LineString', coordinates });

  // 5,000 points thin with stride 6, so indexes 1-5 are never sampled.
  assert.equal(
    only(
      { LOCATION_ID: 'thinning-repro', PLOT_TYPE: 'RD_CLOSURE' },
      lineString(
        longLine((points) => {
          points[1] = [151, -34.5];
        }),
      ),
    ),
    null,
    'an out-of-state vertex between sampled ones is not silently dropped',
  );
  for (const [name, bad] of [
    ['NaN', [Number.NaN, -34.5]],
    ['null', null],
    ['a numeric-string longitude', ['138.5', -34.5]],
    ['a missing latitude', [138.5]],
  ])
    assert.equal(
      only(
        {},
        lineString(
          longLine((points) => {
            points[2] = bad;
          }),
        ),
      ),
      null,
      `${name} at an unsampled index rejects the line`,
    );

  assert.equal(
    only(
      {},
      {
        type: 'MultiLineString',
        coordinates: [
          longLine(() => {}),
          longLine((points) => {
            points[3] = [151, -34.5];
          }),
        ],
      },
    ),
    null,
    'corruption in a later part of a MultiLineString is rejected',
  );

  // Controls: valid geometry still normalises, and the vertex cap is unchanged.
  const single = only({}, lineString(longLine(() => {})));
  assert.equal(single.records.length, 1);
  assert.ok(
    single.records[0].lines[0].length <=
      SA_ROAD_EVENT_LIMITS.maxLineVertices + 1,
  );
  const multi = only(
    {},
    {
      type: 'MultiLineString',
      coordinates: [longLine(() => {}), longLine(() => {})],
    },
  );
  assert.equal(multi.records[0].lines.length, 2);
  // A bad vertex on a sampled index (0, 6, 12, ...) is still rejected.
  assert.equal(
    only(
      {},
      lineString(
        longLine((points) => {
          points[6] = [151, -34.5];
        }),
      ),
    ),
    null,
  );
});

test('validatePayload accepts a proxy-shaped body and refuses anything malformed', () => {
  const points = normalizeSaRoadEventPoints(pointsFixture).records;
  const lines = normalizeSaRoadEventLines(linesFixture).records;
  const body = { points, lines, fetchedAt: 1_700_000_000_000 };
  const ok = validateSaRoadEventsPayload({
    ...body,
    stale: true,
    mirror: true,
  });
  assert.equal(ok.points.length, points.length);
  assert.equal(ok.stale, true);
  assert.equal(ok.mirror, true);
  assert.equal(validateSaRoadEventsPayload(body).stale, false);

  const mutate = (change) => {
    const next = structuredClone(body);
    change(next);
    return next;
  };
  for (const bad of [
    null,
    [],
    {},
    mutate((b) => delete b.points),
    mutate((b) => (b.lines = {})),
    mutate((b) => (b.fetchedAt = 'now')),
    mutate((b) => (b.fetchedAt = NaN)),
    mutate((b) => (b.points[0].kind = 'volcano')),
    mutate((b) => (b.points[0].lon = 0)),
    mutate((b) => (b.points[0].id = '../x')),
    mutate((b) => (b.points[1].id = b.points[0].id)),
    mutate((b) => (b.points[0].description = 5)),
    mutate((b) => (b.points[0].startMs = '2026')),
    mutate((b) => (b.lines[0].lines = [])),
    mutate((b) => (b.lines[0].lines[0][0] = [0, 0])),
    mutate((b) => (b.lines[0].startStreets = 'x')),
    mutate((b) => (b.lines[0].anchor = null)),
    mutate((b) => (b.lines[1].id = b.lines[0].id)),
  ])
    assert.equal(validateSaRoadEventsPayload(bad), null);
});
