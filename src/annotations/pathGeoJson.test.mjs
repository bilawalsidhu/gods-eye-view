// GeoJSON reading: geometries become raw line, area and pin features.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseGeoJson } from './pathGeoJson.js';
import { PathImportError } from './pathXml.js';

const refusal = (code) => (error) =>
  error instanceof PathImportError && error.code === code;
const parse = (value) => parseGeoJson(JSON.stringify(value));
const feature = (geometry, properties = {}) => ({
  type: 'Feature',
  properties,
  geometry,
});

test('a FeatureCollection yields its features in order with their names', () => {
  const features = parse({
    type: 'FeatureCollection',
    features: [
      feature(
        {
          type: 'LineString',
          coordinates: [
            [1, 2, 300],
            [3, 4, 310],
          ],
        },
        { name: ' Trail ' },
      ),
      feature({ type: 'Point', coordinates: [5, 6] }, { title: 'Hut' }),
    ],
  });
  assert.deepEqual(features, [
    {
      kind: 'line',
      name: 'Trail',
      points: [
        [1, 2],
        [3, 4],
      ],
    },
    { kind: 'pin', name: 'Hut', points: [[5, 6]] },
  ]);
});

test('a Polygon is an area from its outer ring; holes are not carried', () => {
  const [area] = parse(
    feature({
      type: 'Polygon',
      coordinates: [
        [
          [0, 0],
          [0, 1],
          [1, 1],
          [0, 0],
        ],
        [
          [0.2, 0.2],
          [0.2, 0.4],
          [0.4, 0.4],
          [0.2, 0.2],
        ],
      ],
    }),
  );
  assert.equal(area.kind, 'area');
  assert.equal(area.points.length, 4);
});

test('multi geometries fan out into one feature per member', () => {
  const features = parse({
    type: 'FeatureCollection',
    features: [
      feature(
        {
          type: 'MultiLineString',
          coordinates: [
            [
              [1, 1],
              [2, 2],
            ],
            [
              [5, 5],
              [6, 6],
            ],
          ],
        },
        { name: 'Legs' },
      ),
      feature({
        type: 'MultiPoint',
        coordinates: [
          [1, 1],
          [2, 2],
        ],
      }),
      feature({
        type: 'MultiPolygon',
        coordinates: [
          [
            [
              [0, 0],
              [0, 1],
              [1, 1],
              [0, 0],
            ],
          ],
          [
            [
              [5, 5],
              [5, 6],
              [6, 6],
              [5, 5],
            ],
          ],
        ],
      }),
    ],
  });
  assert.deepEqual(
    features.map((item) => [item.kind, item.name]),
    [
      ['line', 'Legs'],
      ['line', 'Legs'],
      ['pin', ''],
      ['pin', ''],
      ['area', ''],
      ['area', ''],
    ],
  );
});

test('a single Feature and a bare geometry are both accepted', () => {
  assert.equal(
    parse(feature({ type: 'Point', coordinates: [1, 2] })).length,
    1,
  );
  assert.deepEqual(parse({ type: 'Point', coordinates: [1, 2] }), [
    { kind: 'pin', name: '', points: [[1, 2]] },
  ]);
});

test('a GeometryCollection contributes each member, to a bounded depth', () => {
  const features = parse(
    feature(
      {
        type: 'GeometryCollection',
        geometries: [
          { type: 'Point', coordinates: [1, 1] },
          {
            type: 'LineString',
            coordinates: [
              [1, 1],
              [2, 2],
            ],
          },
        ],
      },
      { label: 'Group' },
    ),
  );
  assert.deepEqual(
    features.map((item) => [item.kind, item.name]),
    [
      ['pin', 'Group'],
      ['line', 'Group'],
    ],
  );

  let nested = { type: 'Point', coordinates: [1, 1] };
  for (let i = 0; i < 20; i += 1)
    nested = { type: 'GeometryCollection', geometries: [nested] };
  assert.deepEqual(parse(nested), []);
});

test('null geometry, unknown types and junk members add nothing', () => {
  assert.deepEqual(
    parse({
      type: 'FeatureCollection',
      features: [
        feature(null),
        feature({ type: 'Circle', coordinates: [1, 2] }),
        null,
        'text',
      ],
    }),
    [],
  );
  assert.deepEqual(parse({ type: 'FeatureCollection' }), []);
});

test('non-numeric positions are NaN, never coerced', () => {
  const [line] = parse(
    feature({
      type: 'LineString',
      coordinates: [['1', '2'], [3], null, [4, 5]],
    }),
  );
  assert.ok(Number.isNaN(line.points[0][0]));
  assert.ok(Number.isNaN(line.points[1][1]));
  assert.ok(Number.isNaN(line.points[2][0]));
  assert.deepEqual(line.points[3], [4, 5]);
});

test('invalid JSON and non-GeoJSON values are refused with a reason', () => {
  assert.throws(() => parseGeoJson('{ not json'), refusal('malformed-json'));
  assert.throws(() => parseGeoJson('[1, 2]'), refusal('not-geojson'));
  assert.throws(() => parseGeoJson('"text"'), refusal('not-geojson'));
  assert.throws(() => parseGeoJson('{"a": 1}'), refusal('not-geojson'));
});

test('a byte-order mark is tolerated', () => {
  assert.equal(parseGeoJson('﻿{"type":"Point","coordinates":[1,2]}').length, 1);
});
