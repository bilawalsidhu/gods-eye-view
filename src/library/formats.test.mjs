import test from 'node:test';
import assert from 'node:assert/strict';
import {
  arcgisPageUrl,
  boundLibraryFeatures,
  loadLibraryDataset,
  parseCsvRows,
  parseLibraryBody,
  presentLibraryProperties,
  validLibraryGeometry,
} from './formats.js';
import { validateLibraryManifest } from './manifest.js';

const point = (lon, lat, properties = {}) => ({
  type: 'Feature',
  geometry: { type: 'Point', coordinates: [lon, lat] },
  properties,
});

function entry(source, display = {}) {
  const {
    ok,
    errors,
    entry: value,
  } = validateLibraryManifest({
    id: 'fixture-entry',
    kind: 'dataset',
    family: 'events',
    title: 'Fixture',
    provider: 'Fixture',
    description: 'Fixture dataset.',
    maintainer: 'test',
    coverage: { global: true },
    source: { fetch: 'proxied', url: 'https://data.example.org/x', ...source },
    display,
    licence: { name: 'Public domain', url: 'https://example.org/licence' },
    attribution: { text: 'Fixture' },
    status: 'community',
  });
  assert.deepEqual(errors, []);
  assert.ok(ok);
  return value;
}

test('only real, in-range geometries survive', () => {
  assert.ok(validLibraryGeometry({ type: 'Point', coordinates: [1, 2] }));
  assert.equal(
    validLibraryGeometry({ type: 'Point', coordinates: [181, 2] }),
    false,
  );
  assert.equal(
    validLibraryGeometry({ type: 'Point', coordinates: [NaN, 2] }),
    false,
  );
  assert.equal(
    validLibraryGeometry({ type: 'GeometryCollection', geometries: [] }),
    false,
  );
  assert.ok(
    validLibraryGeometry({
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
  );
  assert.equal(
    validLibraryGeometry({ type: 'Polygon', coordinates: [[]] }),
    false,
  );
});

test('features are capped and counted, never silently passed whole', () => {
  const candidates = [point(0, 0), point(500, 0), point(1, 1), point(2, 2)];
  const result = boundLibraryFeatures(candidates, { maxFeatures: 2 });
  assert.equal(result.features.length, 2);
  assert.equal(result.dropped, 1);
  assert.equal(result.truncated, true);
});

test('the manifest label and fields become the card copy; values stay as sent', () => {
  const properties = presentLibraryProperties(
    {
      Plant_Name: '  Grand   Coulee ',
      PrimSource: 'hydroelectric',
      Total_MW: 6809,
      nested: { a: 1 },
    },
    { label: 'Plant_Name', fields: ['PrimSource', 'Total_MW', 'nested'] },
  );
  assert.equal(properties.name, 'Grand Coulee');
  assert.deepEqual(properties.__gevDetails, [
    'PrimSource: hydroelectric',
    'Total_MW: 6809',
  ]);
  assert.equal(properties.Plant_Name, '  Grand   Coulee ');
});

test('CSV parsing follows RFC 4180 and finds lat/lon columns', () => {
  assert.deepEqual(parseCsvRows('a,b\r\n"x, y","he said ""hi"""\n\n'), [
    ['a', 'b'],
    ['x, y', 'he said "hi"'],
  ]);
  const { candidates } = parseLibraryBody(
    'csv',
    '﻿name,Latitude,Longitude\n"Pier, 39",37.8087,-122.4098\n',
  );
  assert.deepEqual(candidates[0].geometry.coordinates, [-122.4098, 37.8087]);
  assert.deepEqual(candidates[0].properties, { name: 'Pier, 39' });
  assert.throws(
    () => parseLibraryBody('csv', 'name,value\na,1'),
    /latitude\/longitude/,
  );
  assert.throws(() => parseCsvRows('"open'), /unterminated/);
});

test('explicit CSV columns win over the guessed ones', () => {
  const { candidates } = parseLibraryBody(
    'csv',
    'y,x,lat_wgs,lon_wgs\n1,2,10,20\n',
    {
      columns: { lat: 'lat_wgs', lon: 'lon_wgs' },
    },
  );
  assert.deepEqual(candidates[0].geometry.coordinates, [20, 10]);
});

test('GeoJSON Lines and malformed bodies', () => {
  const { candidates } = parseLibraryBody(
    'geojsonl',
    `${JSON.stringify(point(1, 2))}\n\n${JSON.stringify(point(3, 4))}\n`,
  );
  assert.equal(candidates.length, 2);
  assert.throws(() => parseLibraryBody('geojson', '<html>'), /not JSON/);
  assert.throws(
    () => parseLibraryBody('geojson', '{"a":1}'),
    /FeatureCollection/,
  );
  assert.throws(
    () => parseLibraryBody('arcgis', '{"error":{"code":499}}'),
    /ArcGIS service returned an error/,
  );
});

test('ArcGIS pages are WGS84 GeoJSON with the manifest query', () => {
  const url = new URL(
    arcgisPageUrl(
      'https://s.example.org/FeatureServer/0/',
      { where: 'MW >= 100', f: 'json' },
      2000,
    ),
  );
  assert.equal(url.pathname, '/FeatureServer/0/query');
  assert.equal(url.searchParams.get('where'), 'MW >= 100');
  assert.equal(url.searchParams.get('f'), 'geojson');
  assert.equal(url.searchParams.get('outSR'), '4326');
  assert.equal(url.searchParams.get('resultOffset'), '2000');
});

test('ArcGIS paging follows exceededTransferLimit up to maxPages', async () => {
  const value = entry({
    format: 'arcgis',
    url: 'https://s.example.org/FeatureServer/0',
    maxPages: 2,
  });
  const offsets = [];
  const collection = await loadLibraryDataset(value, async (url) => {
    offsets.push(new URL(url).searchParams.get('resultOffset'));
    return JSON.stringify({
      type: 'FeatureCollection',
      properties: { exceededTransferLimit: true },
      features: [point(offsets.length, 0)],
    });
  });
  assert.deepEqual(offsets, ['0', '1']);
  assert.equal(collection.features.length, 2);
  assert.equal(collection.truncated, true);
});

test('ArcGIS stopping at maxFeatures with more upstream reads as truncated', async () => {
  const value = entry({
    format: 'arcgis',
    url: 'https://s.example.org/FeatureServer/0',
    maxFeatures: 3,
    maxPages: 5,
  });
  let pages = 0;
  const collection = await loadLibraryDataset(value, async () => {
    pages += 1;
    return JSON.stringify({
      type: 'FeatureCollection',
      properties: { exceededTransferLimit: true },
      features: [point(1, 0), point(2, 0), point(3, 0)],
    });
  });
  assert.equal(pages, 1);
  assert.equal(collection.features.length, 3);
  assert.equal(collection.truncated, true);
});

test('a plain dataset request carries the manifest query once', async () => {
  const value = entry({
    format: 'geojson',
    url: 'https://data.example.org/x?keep=1',
    query: { status: 'open' },
  });
  let requested;
  const collection = await loadLibraryDataset(value, async (url) => {
    requested = new URL(url);
    return JSON.stringify({
      type: 'FeatureCollection',
      features: [point(1, 1, { title: 'Storm' })],
    });
  });
  assert.equal(requested.searchParams.get('keep'), '1');
  assert.equal(requested.searchParams.get('status'), 'open');
  assert.equal(collection.features[0].properties.name, 'Storm');
  assert.equal(collection.truncated, false);
});

test('a manifest rank keeps the most important features and scores them for the map', () => {
  const candidates = [
    point(0, 0, { Plant_Name: 'small', Total_MW: '120' }),
    point(1, 1, { Plant_Name: 'none' }),
    point(2, 2, { Plant_Name: 'huge', Total_MW: 6809 }),
    point(3, 3, { Plant_Name: 'mid', Total_MW: 900 }),
  ];
  const { features, truncated } = boundLibraryFeatures(candidates, {
    maxFeatures: 3,
    display: { label: 'Plant_Name', rank: { field: 'Total_MW' } },
  });
  assert.equal(truncated, true);
  assert.deepEqual(
    features.map(({ properties }) => [properties.name, properties.__gevRank]),
    [
      ['huge', 600],
      ['mid', 300],
      ['small', 0],
    ],
  );
  const dated = boundLibraryFeatures(
    [
      point(0, 0, { date: '2026-10-01T00:00:00Z' }),
      point(0, 0, { date: '2026-10-20T00:00:00Z' }),
    ],
    { maxFeatures: 5, display: { rank: { field: 'date', order: 'desc' } } },
  );
  assert.deepEqual(
    dated.features.map(({ properties }) => properties.date),
    ['2026-10-20T00:00:00Z', '2026-10-01T00:00:00Z'],
  );
});

test('a JSON record list becomes points from named or guessed lat/lon fields', () => {
  const body = JSON.stringify({
    count: 3,
    stations: [
      { id: '1611400', name: 'Nawiliwili', lat: 21.9544, lng: -159.3561 },
      { id: 'x', name: 'Bad', lat: 'n/a', lng: 1 },
      'not a record',
    ],
  });
  const { candidates } = parseLibraryBody('json', body, {
    records: 'stations',
    columns: { lat: 'lat', lon: 'lng' },
  });
  assert.deepEqual(candidates[0].geometry.coordinates, [-159.3561, 21.9544]);
  assert.deepEqual(candidates[0].properties, {
    id: '1611400',
    name: 'Nawiliwili',
  });
  const bounded = boundLibraryFeatures(candidates, { maxFeatures: 10 });
  assert.equal(bounded.features.length, 1);
  assert.equal(bounded.dropped, 2);
  // Without columns, lat/latitude and lon/lng/longitude are found by name.
  const guessed = parseLibraryBody(
    'json',
    JSON.stringify([{ Latitude: '10', Longitude: '20', name: 'A' }]),
  );
  assert.deepEqual(guessed.candidates[0].geometry.coordinates, [20, 10]);
  assert.throws(
    () => parseLibraryBody('json', '{"items":[]}', { records: 'stations' }),
    /no record list/,
  );
});

test('a colorBy field, nested or not, becomes the flat colour key', () => {
  const properties = presentLibraryProperties(
    { categories: [{ title: 'Wildfires' }], title: 'Fire' },
    {
      colorBy: {
        field: 'categories.0.title',
        colors: { Wildfires: '#c98500' },
      },
    },
  );
  assert.equal(properties.__gevColorKey, 'Wildfires');
});
