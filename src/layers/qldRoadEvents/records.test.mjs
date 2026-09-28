import test from 'node:test';
import assert from 'node:assert/strict';
import {
  QLD_ROAD_EVENT_LIMITS,
  normalizeQldRoadEventGeometry,
  normalizeQldRoadEventSnapshot,
  qldRoadEventAnchor,
  qldRoadEventCategory,
  simplifyQldRoadEventLine,
} from './records.js';

const properties = (overrides = {}) => ({
  id: 717127,
  status: 'Published',
  source: { provided_by: 'City of Moreton Bay' },
  event_type: 'Flooding',
  event_subtype: 'Flash flooding',
  event_due_to: 'Heavy rain',
  impact: {
    direction: 'Both directions',
    towards: null,
    impact_type: 'Closures',
    impact_subtype: 'Road closed to all traffic',
    delay: 'Long delays expected',
  },
  duration: { start: '2026-05-29T01:27:00+10:00', end: null },
  event_priority: 'Medium',
  description: 'Flood damage at Bunya Crossing',
  advice: 'Do not drive in flood waters',
  information: null,
  road_summary: {
    road_name: 'Dugandan Road',
    locality: 'Bunya',
    local_government_area: 'Moreton Bay Regional',
    district: 'North Coast',
  },
  last_updated: '2026-05-29T11:40:01.352716+10:00',
  ...overrides,
});
const point = {
  type: 'MultiPoint',
  crs: { type: 'name', properties: { name: 'EPSG:7844' } },
  coordinates: [[152.948075928, -27.354923514]],
};
const feature = (props = {}, geometry = point) => ({
  type: 'Feature',
  properties: properties(props),
  geometry,
});

test('categories map every live event type and fall back to other', () => {
  assert.equal(qldRoadEventCategory('Roadworks'), 'roadworks');
  assert.equal(qldRoadEventCategory('Special event'), 'special-event');
  assert.equal(qldRoadEventCategory(' special  EVENT '), 'special-event');
  assert.equal(qldRoadEventCategory('Crash'), 'crash');
  assert.equal(qldRoadEventCategory('Congestion'), 'congestion');
  assert.equal(qldRoadEventCategory('Hazard'), 'hazard');
  assert.equal(qldRoadEventCategory('Volcano'), 'other');
  assert.equal(qldRoadEventCategory(null), 'other');
});

test('a feed feature normalizes to a compact record', () => {
  const [event] = normalizeQldRoadEventSnapshot({
    type: 'FeatureCollection',
    features: [feature()],
  });
  assert.deepEqual(event, {
    id: '717127',
    category: 'flooding',
    type: 'Flooding',
    subtype: 'Flash flooding',
    dueTo: 'Heavy rain',
    priority: 'Medium',
    description: 'Flood damage at Bunya Crossing',
    advice: 'Do not drive in flood waters',
    information: null,
    road: 'Dugandan Road',
    locality: 'Bunya',
    localGovernmentArea: 'Moreton Bay Regional',
    district: 'North Coast',
    direction: 'Both directions',
    towards: null,
    impactType: 'Closures',
    impactSubtype: 'Road closed to all traffic',
    delay: 'Long delays expected',
    startMs: Date.parse('2026-05-29T01:27:00+10:00'),
    endMs: null,
    lastUpdatedMs: Date.parse('2026-05-29T11:40:01.352716+10:00'),
    providedBy: 'City of Moreton Bay',
    anchor: [152.94808, -27.35492],
    points: [[152.94808, -27.35492]],
    lines: [],
  });
});

test('text is cleaned: N/A, control characters, whitespace and length caps', () => {
  const [event] = normalizeQldRoadEventSnapshot({
    features: [
      feature({
        event_subtype: 'N/A',
        description: `  Lane\u0000closed\n\tnear exit  ${'x'.repeat(900)}`,
        event_priority: 'Urgent',
        impact: 'not an object',
        road_summary: null,
        last_updated: 'yesterday',
      }),
    ],
  });
  assert.equal(event.subtype, null);
  assert.ok(event.description.startsWith('Lane closed near exit x'));
  assert.equal(event.description.length, 600);
  assert.ok(event.description.endsWith('…'));
  assert.equal(event.priority, null);
  assert.equal(event.impactType, null);
  assert.equal(event.road, null);
  assert.equal(event.lastUpdatedMs, null);
});

test('malformed input: non-collections reject, bad features are skipped', () => {
  assert.equal(normalizeQldRoadEventSnapshot(null), null);
  assert.equal(normalizeQldRoadEventSnapshot({ features: 'x' }), null);
  const events = normalizeQldRoadEventSnapshot({
    features: [
      null,
      { properties: null, geometry: point },
      { properties: [], geometry: point },
      feature({ id: { nested: true } }),
      feature({ id: 'bad id with spaces' }),
      feature({ id: 1 }, null),
      feature({ id: 2 }, { type: 'Point', coordinates: [200, -27] }),
      feature({ id: 3 }, { type: 'Point', coordinates: ['153', -27] }),
      feature({ id: 4 }, { type: 'Unknown', coordinates: [153, -27] }),
      feature({ id: 5 }),
      feature({ id: 5 }),
      {
        type: 'Feature',
        id: 'fallback-6',
        properties: properties({ id: null }),
        geometry: point,
      },
    ],
  });
  assert.deepEqual(
    events.map(({ id }) => id),
    ['5', 'fallback-6'],
  );
});

test('geometry: every GeoJSON type flattens to markers and lines', () => {
  const line = [
    [153, -27],
    [153.01, -27.01],
  ];
  assert.deepEqual(
    normalizeQldRoadEventGeometry({ type: 'Point', coordinates: [153, -27] }),
    { points: [[153, -27]], lines: [] },
  );
  assert.deepEqual(
    normalizeQldRoadEventGeometry({ type: 'LineString', coordinates: line }),
    { points: [], lines: [line] },
  );
  assert.deepEqual(
    normalizeQldRoadEventGeometry({
      type: 'MultiLineString',
      coordinates: [line, [[153.5, -27.5]]],
    }),
    { points: [[153.5, -27.5]], lines: [line] },
  );
  const ring = [
    [153, -27],
    [153.1, -27],
    [153.1, -27.1],
    [153, -27],
  ];
  assert.equal(
    normalizeQldRoadEventGeometry({ type: 'Polygon', coordinates: [ring] })
      .lines.length,
    1,
  );
  assert.equal(
    normalizeQldRoadEventGeometry({
      type: 'MultiPolygon',
      coordinates: [[ring], [ring]],
    }).lines.length,
    2,
  );
  assert.deepEqual(
    normalizeQldRoadEventGeometry({
      type: 'GeometryCollection',
      geometries: [
        { type: 'Point', coordinates: [145.48, -17.5] },
        { type: 'LineString', coordinates: line },
        {
          type: 'GeometryCollection',
          geometries: [
            {
              type: 'GeometryCollection',
              geometries: [{ type: 'Point', coordinates: [1, 1] }],
            },
          ],
        },
      ],
    }),
    { points: [[145.48, -17.5]], lines: [line] },
    'nesting beyond the depth cap is ignored',
  );
  assert.equal(normalizeQldRoadEventGeometry({ type: 'LineString' }), null);
  assert.equal(normalizeQldRoadEventGeometry('Point'), null);
});

test('long lines are simplified and capped per line, per event and per snapshot', () => {
  const dense = Array.from({ length: 2000 }, (_, i) => [
    153 + i * 0.0001,
    -27 + Math.sin(i / 7) * 0.01,
  ]);
  const simplified = simplifyQldRoadEventLine(dense);
  assert.ok(simplified.length <= QLD_ROAD_EVENT_LIMITS.verticesPerLine);
  assert.deepEqual(simplified[0], dense[0]);
  assert.deepEqual(simplified.at(-1), dense.at(-1));
  const straight = Array.from({ length: 1000 }, (_, i) => [
    153 + i * 1e-3,
    -27,
  ]);
  assert.equal(simplifyQldRoadEventLine(straight).length, 2);

  const geometry = normalizeQldRoadEventGeometry({
    type: 'MultiLineString',
    coordinates: Array.from({ length: 100 }, () => dense),
  });
  assert.ok(geometry.lines.length <= QLD_ROAD_EVENT_LIMITS.linesPerEvent);
  assert.ok(
    geometry.lines.reduce((sum, l) => sum + l.length, 0) <=
      QLD_ROAD_EVENT_LIMITS.verticesPerEvent,
  );

  const heavy = { type: 'MultiLineString', coordinates: [dense, dense, dense] };
  const events = normalizeQldRoadEventSnapshot({
    features: Array.from({ length: 110 }, (_, i) => feature({ id: i }, heavy)),
  });
  assert.equal(events.length, 110, 'over-budget events keep their markers');
  const total = events.reduce(
    (sum, e) => sum + e.lines.reduce((s, l) => s + l.length, 0),
    0,
  );
  assert.ok(total <= QLD_ROAD_EVENT_LIMITS.totalVertices);
  const dropped = events.at(-1);
  assert.deepEqual(dropped.lines, []);
  assert.equal(dropped.points.length, 1);
});

test('the anchor is the first point, else the middle of the longest line', () => {
  assert.deepEqual(
    qldRoadEventAnchor({
      points: [[1, 2]],
      lines: [
        [
          [0, 0],
          [9, 9],
        ],
      ],
    }),
    [1, 2],
  );
  assert.deepEqual(
    qldRoadEventAnchor({
      points: [],
      lines: [
        [
          [153, -27],
          [153.001, -27],
        ],
        [
          [152, -27],
          [152.1, -27],
          [152.1, -27.1],
        ],
      ],
    }),
    [152.1, -27],
  );
});
