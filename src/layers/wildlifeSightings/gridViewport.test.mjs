import test from 'node:test';
import assert from 'node:assert/strict';
import {
  chooseWildlifeGridZoom,
  wildlifeGridTiles,
  wildlifeGridViewportBoxes,
  wildlifeGridCellBounds,
  wildlifeGridCellId,
  WILDLIFE_GRID_LOGICAL_SIZE,
  WILDLIFE_GRID_TILE_CAP,
} from './gridViewport.js';

const globe = [
  { south: -85.0511287798066, west: -180, north: 85.0511287798066, east: 180 },
];
const regional = [{ south: 0, west: 0, north: 40.979898069620134, east: 45 }];

test('glow sampling uses roughly 8–14px cells independently of the 28px icon buckets', () => {
  for (const [boxes, width, height, expected] of [
    [globe, 448, 448, 0],
    [regional, 448, 448, 3],
    [
      [{ south: 0, west: 0, north: 0.08789059053082508, east: 0.087890625 }],
      448,
      448,
      12,
    ],
  ]) {
    const zoom = chooseWildlifeGridZoom({ boxes, width, height });
    assert.equal(zoom, expected);
    const worldPixels = (width * 360) / (boxes[0].east - boxes[0].west);
    const spacing = worldPixels / 2 ** zoom / WILDLIFE_GRID_LOGICAL_SIZE;
    assert.ok(spacing >= 8 && spacing <= 14, `${zoom}: ${spacing}px`);
    assert.ok(
      wildlifeGridTiles({ boxes, z: zoom }).length <= WILDLIFE_GRID_TILE_CAP,
    );
  }
});

test('the named six-tile budget preserves complete coverage for common views', () => {
  for (const [boxes, width, height, expected] of [
    [globe, 896, 896, 1],
    [regional, 896, 896, 4],
    [[{ south: 7, west: -168, north: 72, east: -48 }], 1400, 900, 2],
    [globe, 4000, 4000, 1],
    [globe, 30_000, 400, 0],
  ]) {
    const z = chooseWildlifeGridZoom({ boxes, width, height });
    assert.equal(z, expected);
    const tiles = wildlifeGridTiles({ boxes, z });
    assert.ok(tiles.length > 0 && tiles.length <= WILDLIFE_GRID_TILE_CAP);
  }
});

test('tile ranges contain only intersecting tiles, no offscreen neighbors or duplicate boundary tiles', () => {
  assert.deepEqual(wildlifeGridTiles({ boxes: regional, z: 3 }), [
    { z: 3, x: 4, y: 3 },
  ]);
  assert.deepEqual(wildlifeGridTiles({ boxes: globe, z: 0 }), [
    { z: 0, x: 0, y: 0 },
  ]);
  const crossing = [{ south: 10, west: 179, north: 12, east: -178 }];
  const split = [
    { south: 10, west: 179, north: 12, east: 180 },
    { south: 10, west: -180, north: 12, east: -178 },
  ];
  const z = chooseWildlifeGridZoom({
    boxes: crossing,
    width: 896,
    height: 600,
  });
  assert.deepEqual(
    wildlifeGridTiles({ boxes: crossing, z }),
    wildlifeGridTiles({ boxes: split, z }),
  );
  assert.ok(
    wildlifeGridTiles({ boxes: crossing, z }).every(
      (tile) =>
        ((tile.x + 1) / 2 ** z) * 360 - 180 > 179 ||
        (tile.x / 2 ** z) * 360 - 180 < -178,
    ),
  );
});

test('tile cap degrades zoom to preserve complete coverage and oversized direct requests fail closed', () => {
  const z = chooseWildlifeGridZoom({
    boxes: globe,
    width: 30_000,
    height: 400,
  });
  assert.ok(
    wildlifeGridTiles({ boxes: globe, z }).length <= WILDLIFE_GRID_TILE_CAP,
  );
  assert.deepEqual(wildlifeGridTiles({ boxes: globe, z: 12 }), []);
  assert.equal(chooseWildlifeGridZoom({ boxes: [], width: 0, height: 0 }), 0);
  assert.deepEqual(wildlifeGridTiles({ boxes: [], z: 2 }), []);
});

test('grid camera viewport supports globe and antimeridian without detail-query degree limits', () => {
  const radians = (value) => (value * Math.PI) / 180;
  const viewer = {
    camera: {
      computeViewRectangle: () => ({
        south: radians(-80),
        west: radians(120),
        north: radians(80),
        east: radians(-120),
      }),
    },
  };
  const boxes = wildlifeGridViewportBoxes(viewer);
  assert.equal(boxes.length, 2);
  assert.ok(Math.abs(boxes[0].west - 120) < 1e-8);
  assert.equal(boxes[0].east, 180);
  assert.equal(boxes[1].west, -180);
  assert.deepEqual(wildlifeGridViewportBoxes({}), []);
});

test('logical cell ids and bounds share geographic coverage and wrap antimeridian', () => {
  const id = wildlifeGridCellId(65.94004866768753, -18.28125, 2);
  assert.equal(id, 'grid:2/1/1:1:51');
  const bounds = wildlifeGridCellBounds(id);
  assert.equal(bounds.west, -19.6875);
  assert.equal(bounds.east, -16.875);
  assert.ok(bounds.south < 65.94 && bounds.north > 65.94);
  assert.equal(
    wildlifeGridCellId(
      (bounds.south + bounds.north) / 2,
      (bounds.west + bounds.east) / 2,
      2,
    ),
    id,
  );
  assert.equal(wildlifeGridCellId(0, 180, 2), wildlifeGridCellId(0, -180, 2));
  for (const invalid of [
    'bad',
    'grid:23/0/0:1:1',
    'grid:2/4/0:1:1',
    'grid:2/0/0:64:1',
  ])
    assert.equal(wildlifeGridCellBounds(invalid), null);
});
