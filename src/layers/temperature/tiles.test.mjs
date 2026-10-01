import assert from 'node:assert/strict';
import test from 'node:test';
import { TILE_PIXELS, locateTilePixel, metresPerPixel } from './tiles.js';

test('the null island maps to the centre of the Web Mercator grid', () => {
  const at = locateTilePixel(0, 0, 1);
  assert.equal(at.tileX, 1);
  assert.equal(at.tileY, 1);
  assert.equal(at.pixelX, 0);
  assert.equal(at.pixelY, 0);
});

test('level zero is a single tile and longitude maps left to right', () => {
  assert.equal(locateTilePixel(0, -179.9, 0).pixelX, 0);
  assert.equal(locateTilePixel(0, 179.9, 0).pixelX, TILE_PIXELS - 1);
});

test('north is up: higher latitude is a lower pixel row', () => {
  const north = locateTilePixel(60, 10, 4);
  const south = locateTilePixel(10, 10, 4);
  assert.ok(north.tileY < south.tileY || north.pixelY < south.pixelY);
});

test('beyond the Mercator limit there is no tile to sample', () => {
  // The projection is undefined at the poles; returning a clamped tile would
  // hand back a reading for a place the overlay does not cover.
  assert.equal(locateTilePixel(89, 0), null);
  assert.equal(locateTilePixel(-88, 0), null);
  assert.equal(locateTilePixel(Number.NaN, 0), null);
  assert.equal(locateTilePixel(10, Number.POSITIVE_INFINITY), null);
});

test('indices stay inside the grid at every level', () => {
  for (const level of [0, 3, 7]) {
    const tiles = 2 ** level;
    for (const [lat, lon] of [[85, 180], [-85, -180], [45, 90]]) {
      const at = locateTilePixel(lat, lon, level);
      assert.ok(at.tileX >= 0 && at.tileX < tiles, `tileX ${at.tileX} level ${level}`);
      assert.ok(at.tileY >= 0 && at.tileY < tiles, `tileY ${at.tileY} level ${level}`);
      assert.ok(at.pixelX >= 0 && at.pixelX < TILE_PIXELS);
      assert.ok(at.pixelY >= 0 && at.pixelY < TILE_PIXELS);
    }
  }
});

test('ground resolution shrinks with latitude, so the readout can say how coarse it is', () => {
  const equator = metresPerPixel(0, 7);
  const sixty = metresPerPixel(60, 7);
  assert.ok(equator > sixty);
  // Level 7 with 256 px tiles is roughly 1.2 km at the equator.
  assert.ok(equator > 1000 && equator < 1500, String(equator));
});
