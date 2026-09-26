import assert from 'node:assert/strict';
import test from 'node:test';
import {
  bboxAreaDeg2,
  countTilesForBbox,
  coverageZoomForHeight,
  overviewZoomForHeight,
  latToTileY,
  lonToTileX,
  normalizeBbox,
  tileBounds,
  tileLocalToLonLat,
  tilesForBbox,
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
  assert.equal(normalizeBbox('nope'), null);
  assert.equal(normalizeBbox([1, 2, Number.NaN, 3]), null);
});

test('city-scale boxes exceed the Mapillary bbox limit and need tiles', () => {
  const sacramento = [-121.56, 38.44, -121.36, 38.69];
  assert.ok(bboxAreaDeg2(sacramento) > 0.01);
  assert.equal(countTilesForBbox(sacramento, 14), 160);
  const detroit = [-83.29, 42.25, -82.91, 42.45];
  assert.equal(countTilesForBbox(detroit, 14), 234);
});

test('tilesForBbox orders from the centre outwards and honours the cap', () => {
  const result = tilesForBbox([-121.56, 38.44, -121.36, 38.69], 14, {
    limit: 5,
  });
  assert.equal(result.total, 160);
  assert.equal(result.truncated, true);
  assert.equal(result.tiles.length, 5);
  const centreX = lonToTileX(-121.46, 14);
  const centreY = latToTileY(38.565, 14);
  assert.ok(Math.abs(result.tiles[0].x - centreX) <= 1);
  assert.ok(Math.abs(result.tiles[0].y - centreY) <= 1);
  const full = tilesForBbox([-121.56, 38.44, -121.36, 38.69], 14);
  assert.equal(full.truncated, false);
  assert.equal(full.tiles.length, 160);
});

test('coverageZoomForHeight steps from coarse to z14 as the camera descends', () => {
  assert.equal(coverageZoomForHeight(100_000), null);
  assert.equal(coverageZoomForHeight(30_000), 11);
  assert.equal(coverageZoomForHeight(8_000), 12);
  assert.equal(coverageZoomForHeight(3_000), 13);
  assert.equal(coverageZoomForHeight(500), 14);
  assert.equal(coverageZoomForHeight(Number.NaN), null);
});

test('overviewZoomForHeight covers the globe above the sequence ceiling', () => {
  assert.equal(overviewZoomForHeight(30_000), null);
  assert.equal(overviewZoomForHeight(100_000), 5);
  assert.equal(overviewZoomForHeight(900_000), 4);
  assert.equal(overviewZoomForHeight(2_000_000), 3);
  assert.equal(overviewZoomForHeight(5_000_000), 2);
  assert.equal(overviewZoomForHeight(10_000_000), 1);
  assert.equal(overviewZoomForHeight(25_000_000), 0);
});
