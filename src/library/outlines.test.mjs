import test from 'node:test';
import assert from 'node:assert/strict';
import { outlineRings } from './outlines.js';
import { libraryEntry } from './catalog.js';

const square = (lon, lat, size = 1) => [
  [lon, lat],
  [lon + size, lat],
  [lon + size, lat + size],
  [lon, lat + size],
  [lon, lat],
];
const country = (code, polygons, iso = code) => ({
  properties: { ISO_A2_EH: code, ISO_A2: iso },
  geometry: {
    type: 'MultiPolygon',
    coordinates: polygons.map((ring) => [ring]),
  },
});
const features = [
  // Netherlands: the European part and a Caribbean island.
  country('NL', [square(4, 52), square(-68.3, 12.1, 0.3)]),
  // Natural Earth writes France's ISO_A2 as -99; ISO_A2_EH carries FR.
  country('FR', [square(2, 46), square(-53, 4)], '-99'),
  country('BE', [square(4, 50.5)]),
];

test('coverage outlines keep only the parts inside the declared area', () => {
  const rings = outlineRings(features, libraryEntry('pdok-aerial-netherlands'));
  assert.equal(rings.length, 1);
  assert.equal(rings[0][0][0], 4);
});

test('country outlines keep every part and read the ISO_A2_EH code', () => {
  const everyPart = {
    coverage: { countries: ['FR'] },
    display: { outline: 'countries' },
  };
  assert.equal(
    outlineRings(features, everyPart).length,
    2,
    'metropolitan France and French Guiana',
  );
  // IGN is clipped to metropolitan France, so its outline is too.
  const ign = outlineRings(features, libraryEntry('ign-orthophotos-france'));
  assert.equal(ign.length, 1);
  assert.equal(ign[0][0][0], 2);
  assert.deepEqual(
    outlineRings(features, libraryEntry('nasa-black-marble')),
    [],
  );
});

test('a bbox outline is the coverage rectangle, with no border file needed', () => {
  const rings = outlineRings([], libraryEntry('lawrence-ks'));
  const [west, south, east, north] = libraryEntry('lawrence-ks').coverage.bbox;
  assert.deepEqual(rings, [
    [
      [west, south],
      [east, south],
      [east, north],
      [west, north],
      [west, south],
    ],
  ]);
});
