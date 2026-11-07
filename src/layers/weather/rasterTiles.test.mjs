import test from 'node:test';
import assert from 'node:assert/strict';
import { drawMosaicTile } from './rasterTiles.js';
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

/** A tile canvas of `size`, drawn by `drawMosaicTile`. */
function drawTile(texture, bounds, tile, size = 256) {
  const canvas = createCanvas();
  canvas.width = canvas.height = size;
  drawMosaicTile(texture, bounds, tile, canvas);
  return canvas;
}

const WORLD = { west: -180, south: -90, east: 180, north: 90 };

test('a world mosaic crops level 0/1 geographic tiles with preserved pixels', () => {
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
  const texture = {
    width: raster.width,
    height: raster.height,
    rgba: raster.rgba,
  };
  for (const [x, y, level, crop, cell] of [
    [0, 0, 0, [0, 0, 360, 362, 0, 0, 256, 256], [90, 91]],
    [1, 0, 0, [360, 0, 360, 362, 0, 0, 256, 256], [450, 91]],
    [0, 0, 1, [0, 0, 180, 181, 0, 0, 256, 256], [45, 45]],
    [3, 1, 1, [540, 181, 180, 181, 0, 0, 256, 256], [585, 226]],
  ]) {
    const tile = drawTile(texture, WORLD, { x, y, level });
    assert.equal(tile.getContext('2d').imageSmoothingEnabled, true);
    assert.deepEqual(tile.crop, crop);
    const offset = (cell[1] * 720 + cell[0]) * 4;
    assert.deepEqual(
      tile.getContext('2d').getImageData(64, 64).data,
      raster.rgba.slice(offset, offset + 4),
    );
  }
});

test('a bounded mosaic maps each tile by degrees; outside it stays clear', () => {
  const texture = { width: 2048, height: 1024 };
  const bounds = { west: -180, south: -60, east: 180, north: 60 };
  for (const [x, y, level, crop] of [
    // 180° square tiles reach past the mosaic's 60° edges.
    [0, 0, 0, [0, -256, 1024, 1536, 0, 0, 256, 256]],
    [1, 0, 0, [1024, -256, 1024, 1536, 0, 0, 256, 256]],
    [7, 1, 2, [1792, 128, 256, 384, 0, 0, 256, 256]],
  ]) {
    const tile = drawTile(texture, bounds, { x, y, level });
    assert.equal(tile.source, texture);
    assert.deepEqual(tile.crop, crop);
  }
});

test('512-pixel tiles preserve the source extent at every level', () => {
  const texture = { width: 2048, height: 1024 };
  for (const [x, y, level, crop] of [
    [0, 0, 0, [0, 0, 1024, 1024, 0, 0, 512, 512]],
    [3, 1, 1, [1536, 512, 512, 512, 0, 0, 512, 512]],
    [7, 3, 2, [1792, 768, 256, 256, 0, 0, 512, 512]],
  ]) {
    const tile = drawTile(texture, WORLD, { x, y, level }, 512);
    assert.equal(tile.source, texture);
    assert.deepEqual(tile.crop, crop);
  }
});
