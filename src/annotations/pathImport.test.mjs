// The import core: format detection, the limits applied to every format, and
// the annotation specs an imported file becomes.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  MAX_IMPORT_FEATURES,
  MAX_IMPORT_VERTICES,
  PATH_IMPORT_ACCEPT,
  PATH_IMPORT_FORMATS,
  PathImportError,
  detectPathFormat,
  featuresToSpecs,
  importSummary,
  readPathFile,
} from './pathImport.js';
import { finishSpec } from './drawMode.js';

const refusal = (code) => (error) =>
  error instanceof PathImportError && error.code === code;
const gpx = (body) => `<gpx version="1.1">${body}</gpx>`;
const track = (name, points) =>
  `<trk><name>${name}</name><trkseg>${points
    .map(([lon, lat]) => `<trkpt lat="${lat}" lon="${lon}"/>`)
    .join('')}</trkseg></trk>`;
const geojson = (features) =>
  JSON.stringify({ type: 'FeatureCollection', features });
const lineFeature = (name, coordinates) => ({
  type: 'Feature',
  properties: { name },
  geometry: { type: 'LineString', coordinates },
});

test('the extension decides the format when it is a known one', () => {
  assert.equal(detectPathFormat('hike.GPX', ''), 'gpx');
  assert.equal(detectPathFormat('a/b/trail.kml', ''), 'kml');
  assert.equal(detectPathFormat('area.geojson', ''), 'geojson');
  assert.deepEqual(PATH_IMPORT_FORMATS, ['gpx', 'kml', 'geojson']);
  for (const format of ['gpx', 'kml', 'geojson'])
    assert.ok(PATH_IMPORT_ACCEPT.includes(`.${format}`));
});

test('an unhelpful name falls back to sniffing the content', () => {
  assert.equal(
    detectPathFormat('download', '<?xml version="1.0"?>\n<gpx version="1.1">'),
    'gpx',
  );
  assert.equal(detectPathFormat('export.xml', '<kml xmlns="x">'), 'kml');
  assert.equal(
    detectPathFormat('x.txt', '\uFEFF  {"type":"Feature"}'),
    'geojson',
  );
  assert.equal(detectPathFormat('data.json', '{"type":"Point"}'), 'geojson');
  assert.equal(detectPathFormat('x', '<g:gpx xmlns:g="x">'), 'gpx');
});

test('KMZ and unknown content are refused with something to do next', () => {
  assert.throws(
    () => detectPathFormat('trip.kmz', ''),
    refusal('kmz-unsupported'),
  );
  assert.throws(
    () => detectPathFormat('trip', 'PK\u0003\u0004...'),
    refusal('kmz-unsupported'),
  );
  assert.throws(
    () => detectPathFormat('notes.txt', 'hello'),
    refusal('unknown-format'),
  );
  assert.match(
    (() => {
      try {
        detectPathFormat('trip.kmz', '');
      } catch (error) {
        return error.message;
      }
      return '';
    })(),
    /Unzip/,
  );
});

test('a GPX track reads into a line named after its track', () => {
  const result = readPathFile({
    name: 'ridge.gpx',
    text: gpx(
      track('Ridge walk', [
        [8.1, 46.5],
        [8.2, 46.6],
      ]),
    ),
  });
  assert.equal(result.format, 'gpx');
  assert.deepEqual(result.features, [
    {
      kind: 'line',
      name: 'Ridge walk',
      points: [
        [8.1, 46.5],
        [8.2, 46.6],
      ],
    },
  ]);
  assert.deepEqual(result.skipped, { invalid: 0, overLimit: 0 });
  assert.equal(result.simplified, 0);
});

test('an unnamed feature takes the file name without its extension or folders', () => {
  const result = readPathFile({
    name: 'C:\\tracks\\Morning loop.geojson',
    text: geojson([
      lineFeature(undefined, [
        [1, 1],
        [2, 2],
      ]),
    ]),
  });
  assert.equal(result.features[0].name, 'Morning loop');
});

test('names are one bounded line of plain text', () => {
  const result = readPathFile({
    name: 'x.geojson',
    text: geojson([
      lineFeature(`  Ridge\n\twalk\u0000  ${'x'.repeat(200)}`, [
        [1, 1],
        [2, 2],
      ]),
    ]),
  });
  const { name } = result.features[0];
  assert.ok(name.startsWith('Ridge walk x'));
  assert.equal(name.length, 80);
});

test('positions off the globe are dropped and repeats collapsed', () => {
  const result = readPathFile({
    name: 'x.geojson',
    text: geojson([
      lineFeature('L', [
        [1, 1],
        [1, 1],
        [500, 1],
        [1, -91],
        ['2', 2],
        [2, 2],
      ]),
    ]),
  });
  assert.deepEqual(result.features[0].points, [
    [1, 1],
    [2, 2],
  ]);
});

test('features that describe nothing are counted, not imported', () => {
  const result = readPathFile({
    name: 'x.geojson',
    text: geojson([
      lineFeature('one point', [[1, 1]]),
      lineFeature('no length', [
        [1, 1],
        [1, 1],
      ]),
      {
        type: 'Feature',
        properties: { name: 'collinear' },
        geometry: {
          type: 'Polygon',
          coordinates: [
            [
              [0, 0],
              [1, 0],
              [2, 0],
              [0, 0],
            ],
          ],
        },
      },
      { type: 'Feature', geometry: { type: 'Point', coordinates: [999, 0] } },
      lineFeature('good', [
        [1, 1],
        [2, 2],
      ]),
    ]),
  });
  assert.deepEqual(
    result.features.map((feature) => feature.name),
    ['good'],
  );
  assert.equal(result.skipped.invalid, 4);
});

test('an area is closed, whether or not the file closed it', () => {
  const polygon = (ring) => ({
    type: 'Feature',
    properties: {},
    geometry: { type: 'Polygon', coordinates: [ring] },
  });
  const open = [
    [0, 0],
    [0, 1],
    [1, 1],
  ];
  const closed = [...open, [0, 0]];
  const result = readPathFile({
    name: 'a.geojson',
    text: geojson([polygon(open), polygon(closed)]),
  });
  assert.deepEqual(result.features[0].points, closed);
  assert.deepEqual(result.features[1].points, closed);
});

test('a file takes at most the per-file mark limit and reports the rest', () => {
  const features = [];
  for (let i = 0; i < MAX_IMPORT_FEATURES + 7; i += 1)
    features.push({
      type: 'Feature',
      properties: { name: `P${i}` },
      geometry: { type: 'Point', coordinates: [i * 0.01, 0] },
    });
  const result = readPathFile({ name: 'p.geojson', text: geojson(features) });
  assert.equal(result.features.length, MAX_IMPORT_FEATURES);
  assert.equal(result.features[0].name, 'P0');
  assert.equal(result.skipped.overLimit, 7);
});

test('a long track is simplified to the vertex ceiling and counted', () => {
  const points = [];
  for (let i = 0; i < MAX_IMPORT_VERTICES * 3; i += 1)
    points.push([8 + i * 1e-5, 46 + Math.sin(i / 9) * 1e-4]);
  const result = readPathFile({
    name: 'long.gpx',
    text: gpx(track('Long', points)),
  });
  const [line] = result.features;
  assert.ok(line.points.length <= MAX_IMPORT_VERTICES);
  assert.deepEqual(line.points[0], points[0]);
  assert.deepEqual(line.points.at(-1), points.at(-1));
  assert.equal(result.simplified, 1);
});

test('empty, oversized and feature-less files are refused with a reason', () => {
  assert.throws(
    () => readPathFile({ name: 'a.gpx', text: '  ' }),
    refusal('empty'),
  );
  assert.throws(() => readPathFile({ name: 'a.gpx' }), refusal('empty'));
  assert.throws(
    () => readPathFile({ name: 'a.gpx', text: gpx('') }, { maxChars: 5 }),
    refusal('too-large'),
  );
  assert.throws(
    () => readPathFile({ name: 'a.gpx', text: gpx('') }),
    refusal('nothing-usable'),
  );
  assert.throws(
    () =>
      readPathFile({
        name: 'a.gpx',
        text: gpx('<wpt lat="x" lon="y"/>'),
      }),
    refusal('nothing-usable'),
  );
  assert.throws(
    () => readPathFile({ name: 'a.gpx', text: '<gpx><trk>' }),
    refusal('malformed-xml'),
  );
});

test('specs are the same shape Draw produces for a hand-drawn mark', () => {
  const [route, area, pin] = featuresToSpecs(
    [
      {
        kind: 'line',
        name: 'Trail',
        points: [
          [1, 1],
          [2, 2],
        ],
      },
      {
        kind: 'area',
        name: 'Lake',
        points: [
          [0, 0],
          [0, 1],
          [1, 1],
          [0, 0],
        ],
      },
      { kind: 'pin', name: '', points: [[7.5, 45.9]] },
    ],
    { color: 'amber' },
  );
  const drawn = (shape, vertices, label) =>
    finishSpec(
      { shape, vertices: vertices.map(([lon, lat]) => ({ lon, lat })) },
      { label, color: 'amber' },
    );
  assert.deepEqual(
    route,
    drawn(
      'line',
      [
        [1, 1],
        [2, 2],
      ],
      'Trail',
    ),
  );
  assert.deepEqual(
    area,
    drawn(
      'area',
      [
        [0, 0],
        [0, 1],
        [1, 1],
      ],
      'Lake',
    ),
  );
  assert.deepEqual(pin, drawn('pin', [[7.5, 45.9]], ''));
  assert.deepEqual(featuresToSpecs(null), []);
});

test('the summary says what was imported and what was left out', () => {
  const result = readPathFile({
    name: 'ridge.gpx',
    text: gpx(
      `${track('A', [
        [1, 1],
        [2, 2],
      ])}${track('B', [
        [3, 3],
        [4, 4],
      ])}<wpt lat="1" lon="1"/><wpt lat="x" lon="1"/>`,
    ),
  });
  assert.equal(
    importSummary(result),
    '2 lines, 1 pin from ridge.gpx · 1 skipped (no usable coordinates)',
  );
  assert.equal(importSummary(null), '');
  assert.match(
    importSummary({
      fileName: '',
      features: [{ kind: 'area' }],
      skipped: { invalid: 0, overLimit: 3 },
      simplified: 2,
    }),
    /^1 area · 2 simplified · 3 skipped \(over the 60-mark limit per file\)$/,
  );
});
