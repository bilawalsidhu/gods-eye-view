import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import {
  WZDX_LOOKAHEAD_MS,
  WZDX_MAX_EVENT_VERTICES,
  WZDX_MAX_LINE_VERTICES,
  capLine,
  cleanText,
  eventVertexCount,
  flattenGeometry,
  lineMidpoint,
  normalizeWzdxFeed,
  simplifyLine,
} from './records.js';

// Trimmed real feeds read on 24 Oct 2026 (CC0 1.0, as each header states).
const fixture = (id) =>
  JSON.parse(
    readFileSync(new URL(`./fixtures/wzdx-${id}.json`, import.meta.url)),
  );
const NOW = Date.parse('2026-10-24T03:13:00Z');
const normalize = (id, now = NOW) =>
  normalizeWzdxFeed(fixture(id), { id }, { now });

test('reads WZDx 4.0, 4.1 and 4.2 headers and refuses other versions', () => {
  assert.equal(normalize('mn').version, '4.0'); // road_event_feed_info
  assert.equal(normalize('md').version, '4.1'); // feed_info
  assert.equal(normalize('ms').version, '4.2');
  assert.equal(normalize('nd').version, '4.0'); // sends both headers
  const legacy = fixture('md');
  legacy.feed_info.version = '3.1';
  assert.throws(
    () => normalizeWzdxFeed(legacy, { id: 'md' }, { now: NOW }),
    (error) => error.code === 'unsupported_version',
  );
  const noHeader = { type: 'FeatureCollection', features: [] };
  assert.throws(
    () => normalizeWzdxFeed(noHeader, { id: 'md' }, { now: NOW }),
    (error) => error.code === 'invalid',
  );
  assert.throws(
    () =>
      normalizeWzdxFeed(
        { feed_info: { version: '4.1' } },
        { id: 'md' },
        { now: NOW },
      ),
    (error) => error.code === 'invalid',
  );
});

test('ended events are dropped and so are those starting over a week ahead', () => {
  const ky = normalize('ky');
  assert.equal(ky.counts.features, 3);
  assert.equal(ky.counts.ended, 1);
  assert.ok(!ky.events.some((event) => event.id === 'ky:TRIMARC-254857'));
  const indiana = normalize('in');
  assert.equal(indiana.counts.future, 1);
  assert.deepEqual(
    indiana.events.map((event) => event.id),
    ['in:CARSy-2807'],
  );
  // The same event is kept once its start is within the look-ahead.
  const later = normalizeWzdxFeed(
    fixture('in'),
    { id: 'in' },
    {
      now:
        Date.parse(fixture('in').features[1].properties.start_date) -
        WZDX_LOOKAHEAD_MS +
        1,
    },
  );
  assert.equal(later.counts.future, 0);
  assert.equal(later.events.length, 2);
});

test('a reused feature id keeps both segments under distinct ids', () => {
  const ky = normalize('ky');
  assert.deepEqual(
    ky.events.map((event) => event.id),
    ['ky:TOC-27852', 'ky:TOC-27852#2'],
  );
  assert.equal(ky.counts.duplicateIds, 1);
});

test('compact records carry road, direction, impact, dates and workers', () => {
  const [closed, detour, point] = normalize('mn').events;
  assert.equal(closed.type, 'work-zone');
  assert.equal(closed.impact, 'all-lanes-closed');
  assert.equal(closed.feed, 'mn');
  assert.ok(closed.roads.length >= 1);
  assert.ok(Number.isFinite(closed.start));
  assert.equal(detour.type, 'detour');
  assert.equal(detour.impact, null, 'detours carry no lane impact');
  assert.equal(point.lines.length, 0);
  assert.equal(point.anchor.length, 2);
  const [nd] = normalize('nd').events;
  assert.equal(nd.workers, true);
  for (const event of normalize('ms').events) assert.equal(event.workers, null);
});

test('long lines are simplified and capped; markers sit at the middle', () => {
  const [event] = normalize('in').events;
  const source = fixture('in').features[0].geometry.coordinates;
  assert.ok(source.length > 300);
  const vertices = eventVertexCount([event]);
  assert.ok(vertices <= WZDX_MAX_LINE_VERTICES, `${vertices} vertices`);
  assert.ok(vertices < source.length / 3, `${vertices} of ${source.length}`);
  assert.deepEqual(event.lines[0][0], [
    Math.round(source[0][0] * 1e5) / 1e5,
    Math.round(source[0][1] * 1e5) / 1e5,
  ]);
  // The anchor is on the simplified line, between its ends.
  const [lon, lat] = event.anchor;
  const lons = event.lines[0].map(([x]) => x);
  const lats = event.lines[0].map(([, y]) => y);
  assert.ok(lon >= Math.min(...lons) && lon <= Math.max(...lons));
  assert.ok(lat >= Math.min(...lats) && lat <= Math.max(...lats));
  assert.deepEqual(
    lineMidpoint([
      [0, 0],
      [0, 1],
      [0, 3],
    ]),
    [0, 1.5],
  );
});

test('simplification keeps shape within tolerance and caps by evenly thinning', () => {
  const straight = Array.from({ length: 50 }, (_, i) => [-93 + i * 1e-4, 45]);
  assert.equal(simplifyLine(straight).length, 2);
  const bend = [
    [-93, 45],
    [-92.999, 45.001],
    [-92.998, 45],
  ];
  assert.equal(simplifyLine(bend).length, 3);
  const long = Array.from({ length: 1000 }, (_, i) => [i, 0]);
  const capped = capLine(long, 200);
  assert.equal(capped.length, 200);
  assert.deepEqual(capped[0], [0, 0]);
  assert.deepEqual(capped.at(-1), [999, 0]);
});

test('an event keeps at most WZDX_MAX_EVENT_VERTICES across its lines', () => {
  const zigzag = (offset) =>
    Array.from({ length: 400 }, (_, i) => [
      -90 + i * 1e-3,
      offset + (i % 2) * 1e-3,
    ]);
  const payload = {
    feed_info: { version: '4.2' },
    features: [
      {
        id: 'many',
        properties: {
          core_details: { event_type: 'work-zone', road_names: ['I-1'] },
          vehicle_impact: 'some-lanes-closed',
        },
        geometry: {
          type: 'MultiLineString',
          coordinates: [zigzag(40), zigzag(41), zigzag(42), zigzag(43)],
        },
      },
    ],
  };
  const [event] = normalizeWzdxFeed(payload, { id: 'x' }, { now: NOW }).events;
  assert.ok(eventVertexCount([event]) <= WZDX_MAX_EVENT_VERTICES);
  assert.ok(event.lines.every((line) => line.length <= WZDX_MAX_LINE_VERTICES));
});

test('geometry flattening validates every source vertex', () => {
  assert.deepEqual(
    flattenGeometry({
      type: 'GeometryCollection',
      geometries: [
        { type: 'Point', coordinates: [-90, 40] },
        {
          type: 'LineString',
          coordinates: [
            [-90, 40],
            [-90.1, 40.1],
          ],
        },
      ],
    }),
    {
      lines: [
        [
          [-90, 40],
          [-90.1, 40.1],
        ],
      ],
      points: [[-90, 40]],
    },
  );
  const bad = {
    type: 'LineString',
    coordinates: [
      [-90, 40],
      [-90.05, 400],
      [-90.1, 40.1],
    ],
  };
  assert.equal(flattenGeometry(bad), null);
  assert.equal(flattenGeometry({ type: 'Polygon', coordinates: [] }), null);
  assert.equal(flattenGeometry(null), null);
});

test('feed text is stripped of markup, controls and bidi overrides', () => {
  assert.equal(cleanText('<b>Lane</b>‮ closed\u0007  now'), 'Lane closed now');
  assert.equal(cleanText('x'.repeat(400)).length, 300);
  assert.equal(cleanText('  '), null);
  assert.equal(cleanText(42), null);
});
