import test from 'node:test';
import assert from 'node:assert/strict';
import { getSanAntonioDataset } from './config.js';
import {
  normalizeSanAntonioSnapshot,
  SAN_ANTONIO_GEOMETRY_LIMITS,
} from './records.js';

const parks = getSanAntonioDataset('san-antonio-parks');
const trails = getSanAntonioDataset('san-antonio-trails');
const trailheads = getSanAntonioDataset('san-antonio-trailheads');
const square = (lon = -98.5, lat = 29.4, size = 0.01) => [
  [lon, lat],
  [lon + size, lat],
  [lon + size, lat + size],
  [lon, lat + size],
  [lon, lat],
];
const feature = (id, geometry, properties = {}) => ({
  type: 'Feature',
  id: 'untrusted-alternate-id',
  properties: { OBJECTID: id, ...properties },
  geometry,
});
const normalize = (features, dataset = parks, metadata = {}) =>
  normalizeSanAntonioSnapshot({ features, ...metadata }, dataset);

test('keeps stable City object ids and only approved plain display fields', () => {
  const input = feature(
    '12',
    { type: 'Polygon', coordinates: [square()] },
    {
      ParkName: ' <b>Park</b>\u0000 name ',
      ParkType: 'Neighborhood Park',
      AltParkName: 'Another name',
      ModifiedBy: 'staff account',
      Comments: '<script>unrelated private field</script>',
      TrailSubtype: 'unapproved field for this dataset',
    },
  );
  const { records } = normalize([input]);
  assert.equal(records[0].id, 'san-antonio-parks:12');
  assert.equal(records[0].objectId, 12);
  assert.equal(records[0].name, 'Park name');
  assert.deepEqual(records[0].details, [
    'Type: Neighborhood Park',
    'Also named: Another name',
  ]);
  assert.equal(JSON.stringify(records).includes('staff account'), false);
  assert.equal(JSON.stringify(records).includes('unapproved'), false);
});

test('preserves polygon holes and disconnected polygon parts without mutating input', () => {
  const outer = square(-98.5, 29.4, 0.02);
  const hole = square(-98.494, 29.406, 0.008);
  const island = square(-98.45, 29.4, 0.005);
  const geometry = {
    type: 'MultiPolygon',
    coordinates: [[outer, hole], [island]],
  };
  const { records, skippedCount } = normalize([feature(1, geometry)]);
  assert.equal(skippedCount, 0);
  assert.deepEqual(records[0].geometry, geometry);
  assert.notEqual(records[0].geometry.coordinates, geometry.coordinates);
  assert.notEqual(records[0].geometry.coordinates[0][1], hole);
  // The largest part's centroid is in its hole; the safe anchor is on the
  // actual outer boundary, not in the excluded interior.
  assert.deepEqual(records[0].anchor, { lon: outer[0][0], lat: outer[0][1] });
});

test('keeps every multiline part and uses provided segment mileage only', () => {
  const geometry = {
    type: 'MultiLineString',
    coordinates: [
      [
        [-98.5, 29.4],
        [-98.49, 29.4],
      ],
      [
        [-98.47, 29.4],
        [-98.43, 29.4],
      ],
    ],
  };
  const { records } = normalize(
    [
      feature(4, geometry, {
        TrailName: 'Connector',
        TrailType: 'Sidewalk',
        TrailSubtype: 'Concrete',
        TrailMiles: 0.00601768,
      }),
      feature(5, geometry, { TrailName: 'Unknown' }),
    ],
    trails,
  );
  assert.deepEqual(records[0].geometry, geometry);
  assert.ok(Math.abs(records[0].anchor.lon + 98.45) < 1e-9);
  assert.equal(records[0].anchor.lat, 29.4);
  assert.deepEqual(records[0].details, [
    'Type: Sidewalk',
    'Subtype: Concrete',
    'Reported segment miles: 0.00601768',
  ]);
  assert.deepEqual(records[1].details, []);
  assert.equal(records[1].name, 'Unknown');
});

test('rejects whole malformed features and duplicates, without dropping a bad hole silently', () => {
  const valid = { type: 'Polygon', coordinates: [square()] };
  const unclosed = square();
  unclosed.pop();
  const items = [
    feature(1, valid),
    feature(1, valid),
    feature(2, { type: 'Polygon', coordinates: [square(), [[NaN, 29.4]]] }),
    feature(3, { type: 'Polygon', coordinates: [unclosed] }),
    feature(4, {
      type: 'Polygon',
      coordinates: [
        [
          [0, 0],
          [1, 0],
          [1, 1],
          [0, 0],
        ],
      ],
    }),
    feature(5, { type: 'Point', coordinates: [-98.5, 29.4] }),
    feature(-1, valid),
    feature(Number.MAX_SAFE_INTEGER + 1, valid),
    feature(9, null),
  ];
  const result = normalize(items);
  assert.equal(result.records.length, 1);
  assert.equal(result.skippedCount, items.length - 1);
  assert.equal(result.sourceCount, items.length);
});

test('accepts finite local WGS84 points and rejects numeric strings or StatePlane coordinates', () => {
  const result = normalize(
    [
      feature(1, { type: 'Point', coordinates: [-98.5, 29.4, 200] }),
      feature(2, { type: 'Point', coordinates: ['-98.5', 29.4] }),
      feature(3, { type: 'Point', coordinates: [2138445, 13703996] }),
      feature(4, { type: 'Point', coordinates: [-98.5, Infinity] }),
    ],
    trailheads,
  );
  assert.equal(result.records.length, 1);
  assert.equal(result.skippedCount, 3);
  assert.deepEqual(result.records[0].geometry.coordinates, [-98.5, 29.4, 200]);
  assert.deepEqual(result.records[0].anchor, { lon: -98.5, lat: 29.4 });
});

test('preserves source clocks and reports unknown clocks without inventing freshness', () => {
  const result = normalize([], parks, {
    sourceUpdatedAt: 1770000000000,
    fetchedAt: 1780000000000,
    sourceCount: 337,
  });
  assert.equal(result.sourceUpdatedAt, 1770000000000);
  assert.equal(result.fetchedAt, 1780000000000);
  assert.equal(result.sourceCount, 337);
  const unknown = normalize([], parks, {
    sourceUpdatedAt: '2026-01-01',
    fetchedAt: Infinity,
  });
  assert.equal(unknown.sourceUpdatedAt, null);
  assert.equal(unknown.fetchedAt, null);
  assert.throws(() => normalizeSanAntonioSnapshot({}, parks), /Malformed/);
});

test('geometry and feature limits are explicit skipped records, not truncated coordinates', () => {
  const { maxPositionsPerFeature, maxFeatures } = SAN_ANTONIO_GEOMETRY_LIMITS;
  const oversized = Array.from(
    { length: maxPositionsPerFeature + 1 },
    (_, i) => [-98.5 + (i % 2) * 0.001, 29.4],
  );
  const result = normalize(
    [
      feature(1, { type: 'LineString', coordinates: oversized }),
      feature(2, {
        type: 'LineString',
        coordinates: [
          [-98.5, 29.4],
          [-98.4, 29.4],
        ],
      }),
    ],
    trails,
  );
  assert.equal(result.skippedCount, 1);
  assert.equal(result.records[0].objectId, 2);
  const many = normalize(
    Array.from({ length: maxFeatures + 1 }, (_, i) =>
      feature(i, { type: 'Point', coordinates: [-98.5, 29.4] }),
    ),
    trailheads,
  );
  assert.equal(many.records.length, maxFeatures);
  assert.equal(many.skippedCount, 1);
});
