// Tile fragments, holes and street extents for the OpenFreeMap outline rungs.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  buildingFromTiles,
  decodeOpenFreeMapOutlineTile,
  enclosingAreaFromTiles,
  streetFromTiles,
} from './openFreeMapOutlines.js';

const TILE = decodeOpenFreeMapOutlineTile(
  readFileSync(
    new URL(
      '../data/fixtures/ofm-outlines-austin-14-3743-6745.pbf',
      import.meta.url,
    ),
  ),
  14,
  3743,
  6745,
);
const CAPITOL = { lat: 30.27472, lon: -97.74035 };

const square = (lon, lat, d) => [
  [lon, lat],
  [lon + d, lat],
  [lon + d, lat + d],
  [lon, lat + d],
  [lon, lat],
];

test('decoded polygons keep identity and mark tile-cut fragments', () => {
  assert.ok(
    TILE.buildings.every((b) => b.tile === '14/3743/6745' && 'id' in b),
  );
  assert.ok(
    TILE.buildings.some((b) => b.clipped),
    'fragments at the cut line are marked',
  );
  assert.ok(
    buildingFromTiles([TILE], CAPITOL)?.contains,
    'the Capitol is complete',
  );
});

test('a clipped fragment is never the building, and no neighbour stands in', () => {
  const fragment = {
    rings: [square(0, 0, 0.001)],
    clipped: true,
    heightM: null,
  };
  const neighbour = {
    rings: [square(0.0011, 0, 0.0002)],
    clipped: false,
    heightM: null,
  };
  const point = { lat: 0.0005, lon: 0.0008 };
  assert.equal(
    buildingFromTiles([{ buildings: [fragment, neighbour] }], point),
    null,
  );
  // A complete copy from the neighbouring tile's buffer is used.
  const complete = { ...fragment, clipped: false };
  assert.ok(
    buildingFromTiles(
      [{ buildings: [fragment, neighbour] }, { buildings: [complete] }],
      point,
    )?.contains,
  );
  const lawn = { rings: [square(0, 0, 0.01)], clipped: true, class: 'park' };
  assert.equal(
    enclosingAreaFromTiles([{ areas: [lawn] }], { lat: 0.005, lon: 0.005 }),
    null,
    'clipped grounds are not grounds',
  );
});

test('a point in a courtyard is not inside the building', () => {
  const block = {
    rings: [square(0, 0, 0.001), square(0.0004, 0.0004, 0.0002).reverse()],
    clipped: false,
    heightM: 20,
  };
  const courtyard = { lat: 0.0005, lon: 0.0005 };
  assert.equal(
    buildingFromTiles([{ buildings: [block] }], {
      ...courtyard,
      maxDistanceM: 0,
    }),
    null,
  );
  const near = buildingFromTiles([{ buildings: [block] }], courtyard);
  assert.ok(near && !near.contains, 'near the courtyard walls, not inside');
});

test('grounds enclose the building sitting in their hole', () => {
  const lawn = {
    rings: [square(0, 0, 0.004), square(0.0015, 0.0015, 0.001).reverse()],
    clipped: false,
    class: 'park',
  };
  const grounds = enclosingAreaFromTiles([{ areas: [lawn] }], {
    lat: 0.002,
    lon: 0.002,
  });
  assert.ok(grounds, 'the Capitol-in-its-lawn case');
});

test('street proximity uses segments and clips to the search extent', () => {
  // One straight 4 km piece whose vertices are both 2 km from the point.
  const through = {
    name: 'Long Road',
    coordinates: [
      [-0.018, 0],
      [0.018, 0],
    ],
  };
  const street = streetFromTiles([{ streets: [through] }], {
    name: 'Long Road',
    lat: 0,
    lon: 0,
    radiusM: 500,
  });
  assert.ok(street, 'a street passing through the point is found');
  for (const [lon] of street.lines.flat())
    assert.ok(Math.abs(lon) <= 500 / 111_320 + 1e-9, 'within the extent');
  const far = {
    name: 'Long Road',
    coordinates: [
      [-0.018, 0.02],
      [0.018, 0.02],
    ],
  };
  assert.equal(
    streetFromTiles([{ streets: [far] }], {
      name: 'Long Road',
      lat: 0,
      lon: 0,
      radiusM: 500,
    }),
    null,
  );
});
