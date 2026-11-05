import test from 'node:test';
import assert from 'node:assert/strict';
import {
  decodeRiverTile,
  normalizeRiverName,
  riverNamesOf,
  riverStretches,
  riverTilePlan,
  riverTilesFor,
} from './rivers.js';

const gauge = (id, lat, lon, band, river = 'Rhein', riverNative = null) => ({
  id,
  lat,
  lon,
  band,
  river,
  riverNative,
});

test('river names match across spelling, accents and punctuation', () => {
  assert.equal(normalizeRiverName('Main-Donau-Kanal'), 'main donau kanal');
  assert.equal(normalizeRiverName('La Moselle'), 'la moselle');
  assert.equal(normalizeRiverName('Große Nister'), 'grosse nister');
  assert.equal(normalizeRiverName('磺溪'), '磺溪');
  assert.deepEqual(
    riverNamesOf({
      class: 'river',
      name: 'Rhein',
      'name:en': 'Rhine',
      name_de: 'Rhein',
      'name:latin': 'Rhein',
    }).sort(),
    ['rhein', 'rhine'],
  );
});

test('a stretch belongs to the nearest gauge on the same river', () => {
  const line = {
    names: ['rhein'],
    // Due north along one meridian, ~11 km per step.
    coords: [0, 1, 2, 3, 4].map((i) => [7, 50 + i / 10]),
  };
  const stretches = riverStretches(
    [line],
    [
      gauge('a', 50.0, 7, 'record-low'),
      gauge('b', 50.4, 7, 'flood'),
      gauge('mosel', 50.2, 7, 'watch', 'Mosel'),
    ],
  );
  assert.deepEqual(
    stretches.map((s) => [s.stationId, s.band, s.coords.length]),
    [
      // Halfway between the two, the downstream gauge takes the point.
      ['a', 'record-low', 3],
      ['b', 'flood', 3],
    ],
  );
  // The two stretches touch where the colour changes.
  assert.deepEqual(stretches[0].coords.at(-1), stretches[1].coords[0]);
});

test('unmatched rivers, unreferenced gauges and far reaches stay undrawn', () => {
  const near = {
    names: ['lahn'],
    coords: [
      [7, 50],
      [7, 50.05],
    ],
  };
  const far = {
    names: ['rhein'],
    coords: [
      [7, 52],
      [7, 52.1],
    ],
  };
  assert.deepEqual(
    riverStretches([near, far], [gauge('a', 50, 7, 'normal')]),
    [],
  );
  assert.deepEqual(
    riverStretches(
      [
        {
          names: ['rhein'],
          coords: [
            [7, 50],
            [7, 50.05],
          ],
        },
      ],
      [gauge('a', 50, 7, 'unknown')],
    ),
    [],
  );
});

test('a Taiwanese river matches on its native name', () => {
  const [stretch] = riverStretches(
    [
      {
        names: ['磺溪'],
        coords: [
          [121.6, 25.2],
          [121.61, 25.21],
        ],
      },
    ],
    [gauge('wra:1', 25.2, 121.6, 'normal', 'HUANG CHI', '磺溪')],
  );
  assert.equal(stretch.stationId, 'wra:1');
});

test('detailed tiles while they cover the view, generalized beyond, none from space', () => {
  const view = { west: 5, south: 47, east: 15, north: 55 };
  const one = [gauge('a', 50.36, 7.6, 'low')];
  assert.equal(riverTilePlan(one, view, 200_000).zoom, 9);
  // Gauges all over Germany need far more detailed tiles than the cap.
  const many = [];
  for (let lat = 47.5; lat < 55; lat += 0.5)
    for (let lon = 6; lon < 15; lon += 0.7)
      many.push(gauge(`${lat}/${lon}`, lat, lon, 'normal'));
  const plan = riverTilePlan(many, view, 200_000);
  assert.equal(plan.zoom, 6);
  assert.ok(plan.tiles.length > 0 && plan.tiles.length <= 40);
  assert.equal(riverTilePlan(one, view, 2_000_000).zoom, 6);
  assert.equal(riverTilePlan(one, view, 10_000_000), null);
  assert.equal(riverTilePlan(one, view, NaN), null);
});

test('tiles are those around referenced gauges in view, capped', () => {
  const view = { west: 6, south: 49, east: 9, north: 52 };
  const tiles = riverTilesFor(
    [
      gauge('a', 50.36, 7.6, 'low'),
      gauge('grey', 51, 8.5, 'unknown'),
      gauge('outside', 53.5, 10, 'flood'),
    ],
    view,
    9,
  );
  // Koblenz's tile and its eight neighbours; nothing for the others.
  assert.equal(tiles.length, 9);
  assert.ok(tiles.every((t) => t.z === 9));
  assert.equal(
    riverTilesFor([gauge('a', 50.36, 7.6, 'low')], view, 9, 3).length,
    3,
  );
  assert.deepEqual(
    riverTilesFor([gauge('a', 50, 7, 'low')], { ...view, east: 5 }, 9),
    [],
  );
});

test('a tile yields named rivers and canals only, clipped to the tile', () => {
  const feature = (properties, coordinates) => ({
    properties,
    toGeoJSON: () => ({ geometry: { type: 'LineString', coordinates } }),
  });
  // Tile 9/266/172 spans roughly 7.03–7.73 °E, 50.29–50.74 °N.
  const features = [
    feature({ class: 'river', name: 'Rhein' }, [
      [7.4, 50.3],
      [7.5, 50.4],
      [8.5, 50.4],
    ]),
    feature({ class: 'stream', name: 'Bach' }, [
      [7.4, 50.3],
      [7.5, 50.4],
    ]),
    feature({ class: 'river' }, [
      [7.4, 50.3],
      [7.5, 50.4],
    ]),
  ];
  const tile = {
    layers: {
      waterway: { length: features.length, feature: (i) => features[i] },
    },
  };
  const lines = decodeRiverTile(null, 9, 266, 172, tile);
  assert.equal(lines.length, 1);
  assert.deepEqual(lines[0].names, ['rhein']);
  assert.ok(lines[0].coords.every(([lon]) => lon <= 7.74));
  assert.deepEqual(decodeRiverTile(null, 9, 266, 172, { layers: {} }), []);
});
