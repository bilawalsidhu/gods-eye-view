import test from 'node:test';
import assert from 'node:assert/strict';
import * as Cesium from 'cesium';
import { createRasterTileProvider } from './rasterTiles.js';
import { createFieldRaster } from '../wind/fields.js';

// A small canvas double exposes the uploaded raster and exact drawImage crop.
// Verify crop coordinates and source-cell selection independently of canvas smoothing.
function createCanvas() {
  const canvas = { width: 0, height: 0 };
  const context = {
    createImageData: (width, height) => ({
      data: new Uint8ClampedArray(width * height * 4),
    }),
    putImageData(pixels) {
      canvas.rgba = pixels.data;
    },
    drawImage(source, ...args) {
      canvas.source = source;
      canvas.crop = args;
    },
    getImageData(x, y) {
      const [sx, sy, sw, sh, dx, dy, dw, dh] = canvas.crop;
      const col = Math.floor(sx + ((x - dx + 0.5) * sw) / dw);
      const row = Math.floor(sy + ((y - dy + 0.5) * sh) / dh);
      const offset = (row * canvas.source.width + col) * 4;
      return { data: canvas.source.rgba.slice(offset, offset + 4) };
    },
  };
  canvas.getContext = () => context;
  return canvas;
}

test('real Cesium geographic provider crops level 0/1 tiles from a decoded canvas with preserved pixels', async () => {
  const raster = createFieldRaster(
    {
      nx: 8,
      ny: 3,
      lo1: -180,
      la1: 90,
      dx: 45,
      dy: 90,
      u: Float32Array.from([
        0, 0, 10, 10, 20, 20, 30, 30, 0, 0, 10, 10, 20, 20, 30, 30, 30, 30, 20,
        20, 10, 10, 0, 0,
      ]),
      v: new Float32Array(24),
    },
    'speed',
    720,
    362,
  );
  const credit = new Cesium.Credit('NOAA GFS');
  const texture = {
    width: raster.width,
    height: raster.height,
    rgba: raster.rgba,
  };
  const provider = createRasterTileProvider({
    cesium: Cesium,
    texture,
    credit,
    createCanvas,
  });
  assert.ok(provider.tilingScheme instanceof Cesium.GeographicTilingScheme);
  assert.equal(provider.rectangle, Cesium.Rectangle.MAX_VALUE);
  assert.equal(provider.minimumLevel, 0);
  assert.equal(provider.maximumLevel, 2);
  assert.equal(provider.tileWidth, 256);
  assert.equal(provider.tileHeight, 256);
  assert.equal(provider.ready, true);
  assert.equal(provider.hasAlphaChannel, true);
  assert.equal(provider.credit, credit);
  assert.ok(provider.errorEvent instanceof Cesium.Event);
  assert.equal(provider.tileDiscardPolicy, undefined);
  assert.equal(provider.getTileCredits(0, 0, 0), undefined);
  assert.equal(provider.pickFeatures(0, 0, 0, 0, 0), undefined);
  for (const [x, y, level, crop, cell] of [
    [0, 0, 0, [0, 0, 360, 362, 0, 0, 256, 256], [90, 91]],
    [1, 0, 0, [360, 0, 360, 362, 0, 0, 256, 256], [450, 91]],
    [0, 0, 1, [0, 0, 180, 181, 0, 0, 256, 256], [45, 45]],
    [3, 1, 1, [540, 181, 180, 181, 0, 0, 256, 256], [585, 226]],
  ]) {
    const pending = provider.requestImage(x, y, level);
    assert.ok(pending instanceof Promise, 'ImageryLayer consumes a promise');
    const tile = await pending;
    assert.equal(tile.width, 256);
    assert.equal(tile.height, 256);
    assert.equal(tile.getContext('2d').imageSmoothingEnabled, true);
    assert.deepEqual(tile.crop, crop);
    const offset = (cell[1] * 720 + cell[0]) * 4;
    assert.deepEqual(
      tile.getContext('2d').getImageData(64, 64).data,
      raster.rgba.slice(offset, offset + 4),
    );
  }
});

test('bounded decoded mosaic crops both roots and higher levels without resampling its extent', async () => {
  const texture = { width: 2048, height: 1024 };
  const rectangle = Cesium.Rectangle.fromDegrees(-180, -60, 180, 60);
  const scheme = new Cesium.GeographicTilingScheme({
    rectangle,
    numberOfLevelZeroTilesX: 2,
    numberOfLevelZeroTilesY: 1,
  });
  const credit = new Cesium.Credit('NOAA');
  const provider = createRasterTileProvider({
    cesium: Cesium,
    texture,
    rectangle,
    tilingScheme: scheme,
    maximumLevel: 3,
    credit,
    createCanvas,
  });
  assert.equal(provider.rectangle, rectangle);
  assert.equal(provider.maximumLevel, 3);
  assert.equal(provider.credit, credit);
  assert.equal(provider.hasAlphaChannel, true);
  for (const [x, y, level, crop] of [
    [0, 0, 0, [0, 0, 1024, 1024, 0, 0, 256, 256]],
    [1, 0, 0, [1024, 0, 1024, 1024, 0, 0, 256, 256]],
    [7, 3, 2, [1792, 768, 256, 256, 0, 0, 256, 256]],
  ]) {
    const pending = provider.requestImage(x, y, level);
    assert.ok(pending instanceof Promise);
    const tile = await pending;
    assert.equal(tile.source, texture);
    assert.deepEqual(tile.crop, crop);
  }
});

test('512-pixel crops preserve source extent at root and clamped draping levels', async () => {
  const texture = { width: 2048, height: 1024 };
  const provider = createRasterTileProvider({
    cesium: Cesium,
    texture,
    createCanvas,
    tileSize: 512,
    maximumLevel: 3,
  });
  assert.equal(provider.tileWidth, 512);
  assert.equal(provider.tileHeight, 512);
  for (const [x, y, level, crop] of [
    [0, 0, 0, [0, 0, 1024, 1024, 0, 0, 512, 512]],
    [3, 1, 1, [1536, 512, 512, 512, 0, 0, 512, 512]],
    [7, 3, 2, [1792, 768, 256, 256, 0, 0, 512, 512]],
  ]) {
    const tile = await provider.requestImage(x, y, level);
    assert.equal(tile.width, 512);
    assert.equal(tile.height, 512);
    assert.equal(tile.source, texture);
    assert.deepEqual(tile.crop, crop);
  }
});
