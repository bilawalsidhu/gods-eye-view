import assert from 'node:assert/strict';
import test from 'node:test';
import {
  coverageZoomForHeight,
  latToTileY,
  lonToTileX,
  normalizeBbox,
  tileBounds,
  tileLocalToLonLat,
  tilesForBbox,
  wrapLon,
} from './tileMath.js';

test('lon/lat to tile matches the Sacramento reference tile', () => {
  assert.equal(lonToTileX(-121.4944, 14), 2662);
  assert.equal(latToTileY(38.5816, 14), 6286);
  const bounds = tileBounds(2662, 6286, 14);
  assert.ok(bounds.west < -121.4944 && -121.4944 < bounds.east);
  assert.ok(bounds.south < 38.5816 && 38.5816 < bounds.north);
});

test('tile-local coordinates round-trip into the tile bounds', () => {
  const bounds = tileBounds(2662, 6286, 14);
  const [lon, lat] = tileLocalToLonLat(0, 0, 4096, 2662, 6286, 14);
  assert.ok(Math.abs(lon - bounds.west) < 1e-9);
  assert.ok(Math.abs(lat - bounds.north) < 1e-9);
  const [lon2, lat2] = tileLocalToLonLat(4096, 4096, 4096, 2662, 6286, 14);
  assert.ok(Math.abs(lon2 - bounds.east) < 1e-9);
  assert.ok(Math.abs(lat2 - bounds.south) < 1e-9);
});

test('normalizeBbox orders and clamps coordinates', () => {
  assert.deepEqual(normalizeBbox([-121.36, 38.69, -121.56, 38.44]), {
    west: -121.56,
    south: 38.44,
    east: -121.36,
    north: 38.69,
  });
  assert.equal(normalizeBbox([0, 0, 0, 1]), null);
  assert.equal(normalizeBbox([1, 2, 3]), null);
  assert.equal(normalizeBbox([1, 2, Number.NaN, 3]), null);
});

test('tilesForBbox orders from the centre outwards and honours the cap', () => {
  const tiles = tilesForBbox([-121.56, 38.44, -121.36, 38.69], 14, {
    limit: 5,
  });
  assert.equal(tiles.length, 5);
  const centreX = lonToTileX(-121.46, 14);
  const centreY = latToTileY(38.565, 14);
  assert.ok(Math.abs(tiles[0].x - centreX) <= 1);
  assert.ok(Math.abs(tiles[0].y - centreY) <= 1);
  const full = tilesForBbox([-121.56, 38.44, -121.36, 38.69], 14);
  assert.equal(full.length, 160);
});

test('coverageZoomForHeight steps from coarse to z14 as the camera descends', () => {
  assert.equal(coverageZoomForHeight(100_000), null);
  assert.equal(coverageZoomForHeight(30_000), 11);
  assert.equal(coverageZoomForHeight(8_000), 12);
  assert.equal(coverageZoomForHeight(3_000), 13);
  assert.equal(coverageZoomForHeight(500), 14);
  assert.equal(coverageZoomForHeight(Number.NaN), null);
});

test('longitude 180 is the last column, so a world view keeps the eastern hemisphere', () => {
  assert.equal(lonToTileX(180, 1), 1);
  assert.equal(lonToTileX(179.99, 1), 1);
  assert.equal(lonToTileX(-180, 1), 0);
  const columns = new Set(
    tilesForBbox([-180, -85, 180, 85], 1).map((tile) => tile.x),
  );
  assert.deepEqual([...columns].sort(), [0, 1]);
});

test('a box across the date line takes tiles on both sides of it, not the far side of the globe', () => {
  const tiles = tilesForBbox([179, -1, -179, 1], 8);
  const columns = new Set(tiles.map((tile) => tile.x));
  assert.ok(columns.has(255), 'west of the line');
  assert.ok(columns.has(0), 'east of the line');
  assert.ok(
    [...columns].every((x) => x <= 1 || x >= 254),
    'nothing from the middle of the map',
  );
  // The limit keeps the tiles nearest the line.
  const limited = tilesForBbox([170, -1, -170, 1], 8, { limit: 4 });
  assert.ok(limited.every((tile) => tile.x <= 8 || tile.x >= 247));
});

test('a box across the date line ranks from the line, or from the camera across it', () => {
  const z = 14;
  const n = 2 ** z;
  const bbox = [179.9, 0, -179.9, 0.1];
  const key = (t) => `${t.x}/${t.y}`;
  const [north, south] = [latToTileY(0.1, z), latToTileY(0, z)];
  const plain = tilesForBbox(bbox, z);
  assert.equal(plain.length, 10 * (south - north + 1), '5 columns either side');
  // The box centre is the date line itself, not the middle of the map: the
  // columns touching it come first, then the ones beside them.
  for (const tile of plain.slice(0, 4))
    assert.ok([n - 1, 0].includes(tile.x), `${key(tile)} at the line`);
  for (const tile of plain.slice(4, 12))
    assert.ok(
      [n - 2, n - 1, 0, 1].includes(tile.x),
      `${key(tile)} near the line`,
    );
  // From a camera metres from the line: its tile, then the one across it.
  const row = latToTileY(0.05, z);
  const { south: rowSouth, north: rowNorth } = tileBounds(0, row, z);
  const lat = (rowSouth + rowNorth) / 2;
  const west = tilesForBbox(bbox, z, { from: { lon: 179.999, lat } });
  assert.deepEqual(west.slice(0, 2).map(key), [`${n - 1}/${row}`, `0/${row}`]);
  const east = tilesForBbox(bbox, z, { from: { lon: -179.999, lat } });
  assert.deepEqual(east.slice(0, 2).map(key), [`0/${row}`, `${n - 1}/${row}`]);
});

test('ranking from the camera keeps the ground under it, not the box centre', () => {
  // A box that runs far north of the camera, as a tilted view's does: the
  // box centre is kilometres from the camera.
  const from = { lon: -121.4944, lat: 38.5816 };
  const bbox = [-121.6, 38.57, -121.38, 38.9];
  const z = 14;
  const key = (t) => `${t.x}/${t.y}`;
  const under = `${lonToTileX(from.lon, z)}/${latToTileY(from.lat, z)}`;
  const plain = tilesForBbox(bbox, z, { limit: 9 }).map(key);
  assert.equal(plain.includes(under), false, 'the box centre drops it');
  const ranked = tilesForBbox(bbox, z, { limit: 9, from });
  assert.equal(key(ranked[0]), under, 'the tile under the camera first');
});

test('wrapLon wraps longitudes and their differences into [-180, 180]', () => {
  assert.equal(wrapLon(10.0005), 10.0005, 'in range: unchanged');
  assert.equal(wrapLon(180), 180);
  assert.equal(wrapLon(-180), -180);
  assert.ok(Math.abs(wrapLon(180.001) - -179.999) < 1e-9);
  assert.ok(Math.abs(wrapLon(-359.9998) - 0.0002) < 1e-9);
  assert.ok(Math.abs(wrapLon(359.9998) - -0.0002) < 1e-9);
  assert.ok(Math.abs(wrapLon(540.5) - -179.5) < 1e-9);
  assert.ok(Number.isNaN(wrapLon(NaN)));
});
