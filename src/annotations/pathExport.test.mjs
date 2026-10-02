// Board export: marks become GeoJSON that the importer reads back unchanged.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { annotationsToGeoJson, exportFileName } from './pathExport.js';
import { featuresToSpecs, readPathFile } from './pathImport.js';

const route = {
  type: 'route',
  color: 'amber',
  label: 'Ridge walk — 12 km',
  anchor: { lon: 8.1, lat: 46.5, height: 0 },
  path: [
    { lon: 8.1, lat: 46.5, height: 0 },
    { lon: 8.2, lat: 46.6, height: 0 },
  ],
  ring: null,
};
const area = {
  type: 'area',
  color: 'cyan',
  label: 'Lake',
  anchor: { lon: 0.5, lat: 0.5, height: 12 },
  ring: [
    [0, 0],
    [0, 1],
    [1, 1],
  ],
};
const pin = {
  type: 'pin',
  color: 'primary',
  label: null,
  anchor: { lon: 7.5, lat: 45.9, height: 4478 },
  ring: null,
};

test('routes, areas and pins become LineString, Polygon and Point features', () => {
  const { geojson, exported, skipped } = annotationsToGeoJson([
    route,
    area,
    pin,
  ]);
  assert.equal(exported, 3);
  assert.equal(skipped, 0);
  assert.equal(geojson.type, 'FeatureCollection');
  assert.deepEqual(geojson.features, [
    {
      type: 'Feature',
      properties: { kind: 'route', name: 'Ridge walk', color: 'amber' },
      geometry: {
        type: 'LineString',
        coordinates: [
          [8.1, 46.5],
          [8.2, 46.6],
        ],
      },
    },
    {
      type: 'Feature',
      properties: { kind: 'area', name: 'Lake', color: 'cyan' },
      geometry: {
        type: 'Polygon',
        coordinates: [
          [
            [0, 0],
            [0, 1],
            [1, 1],
            [0, 0],
          ],
        ],
      },
    },
    {
      type: 'Feature',
      properties: { kind: 'pin', color: 'primary' },
      geometry: { type: 'Point', coordinates: [7.5, 45.9] },
    },
  ]);
});

test('an already-closed ring is not closed twice', () => {
  const { geojson } = annotationsToGeoJson([
    {
      ...area,
      ring: [
        [0, 0],
        [0, 1],
        [1, 1],
        [0, 0],
      ],
    },
  ]);
  assert.equal(geojson.features[0].geometry.coordinates[0].length, 4);
});

test('the distance the engine appended to a route label is not exported', () => {
  const nameFor = (label) =>
    annotationsToGeoJson([{ ...route, label }]).geojson.features[0].properties
      .name;
  assert.equal(nameFor('Ridge walk — 12 km'), 'Ridge walk');
  assert.equal(nameFor('Ridge walk — 850 m'), 'Ridge walk');
  assert.equal(nameFor('Loop — 3.4 km · 41 min walk'), 'Loop');
  assert.equal(nameFor('A — B — 2.0 km'), 'A — B');
  assert.equal(nameFor('12 km'), undefined);
  assert.equal(nameFor('North — south traverse'), 'North — south traverse');
  // Only routes carry an appended measure; an area called "… — 5 km" keeps it.
  assert.equal(
    annotationsToGeoJson([{ ...area, label: 'Zone — 5 km' }]).geojson
      .features[0].properties.name,
    'Zone — 5 km',
  );
});

test('an area still waiting for its outline exports as the point it is', () => {
  const { geojson } = annotationsToGeoJson([{ ...area, ring: null }]);
  assert.deepEqual(geojson.features[0].geometry, {
    type: 'Point',
    coordinates: [0.5, 0.5],
  });
});

test('arrows, labels and marks with no usable position are skipped and counted', () => {
  const { exported, skipped } = annotationsToGeoJson([
    { type: 'arrow', anchor: { lon: 1, lat: 1 }, to: { lon: 2, lat: 2 } },
    { type: 'label', anchor: { lon: 1, lat: 1 } },
    { type: 'pin', anchor: { lon: Number.NaN, lat: 1 } },
    { type: 'route', path: [{ lon: 1, lat: 1 }] },
    null,
    pin,
  ]);
  assert.equal(exported, 1);
  assert.equal(skipped, 5);
  assert.deepEqual(annotationsToGeoJson(undefined), {
    geojson: { type: 'FeatureCollection', features: [] },
    exported: 0,
    skipped: 0,
  });
});

test('an exported board imports back as the same specs', () => {
  const { geojson } = annotationsToGeoJson([route, area, pin]);
  const result = readPathFile({
    name: 'board.geojson',
    text: JSON.stringify(geojson),
  });
  assert.deepEqual(result.skipped, { invalid: 0, overLimit: 0 });
  const specs = featuresToSpecs(result.features);
  assert.deepEqual(
    specs.map((spec) => [spec.type, spec.label]),
    [
      ['route', 'Ridge walk'],
      ['area', 'Lake'],
      // An unnamed mark takes the file's name on the way back in.
      ['pin', 'board'],
    ],
  );
  assert.deepEqual(specs[0].path, [
    [8.1, 46.5],
    [8.2, 46.6],
  ]);
  assert.deepEqual(specs[1].ring, [
    [0, 0],
    [0, 1],
    [1, 1],
    [0, 0],
  ]);
  assert.equal(specs[2].longitude, 7.5);
  assert.equal(specs[2].latitude, 45.9);
});

test('the file name is sortable and has no characters a filesystem refuses', () => {
  const name = exportFileName(new Date('2026-10-02T14:05:09.123Z'));
  assert.equal(name, 'gods-eye-board-2026-10-02T14-05-09.geojson');
  assert.doesNotMatch(name, /[:\\/*?"<>|]/);
});
