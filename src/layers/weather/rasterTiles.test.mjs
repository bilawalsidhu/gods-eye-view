import test from 'node:test';
import assert from 'node:assert/strict';
import * as Cesium from 'cesium';
import {
  createRasterTileProvider,
  createFrameTileProvider,
} from './rasterTiles.js';
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

const time = '2026-09-15T20:00:00.000Z';
function tileCanvas() {
  const canvas = { width: 0, height: 0, drawn: [] };
  canvas.getContext = () => ({
    drawImage: (source, ...args) => canvas.drawn.push([source, ...args]),
    putImageData: (source, ...args) => canvas.drawn.push([source, ...args]),
  });
  return canvas;
}
const tilePixels = (size = 256) => ({
  width: size,
  height: size,
  closes: 0,
  close() {
    this.closes++;
  },
});
const deferredTile = () => {
  let resolve, reject;
  const promise = new Promise((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
};
function frameProvider(getTile, options = {}) {
  return createFrameTileProvider({
    cesium: Cesium,
    frameSource: { getTile },
    product: 'radar',
    time,
    tilingScheme: new Cesium.GeographicTilingScheme(),
    rectangle: Cesium.Rectangle.fromDegrees(-130, 20, -60, 55),
    maximumLevel: 6,
    credit: new Cesium.Credit('NOAA'),
    createCanvas: tileCanvas,
    ...options,
  });
}

test('a frame tile provider draws each supplied tile into its own canvas and releases it', async () => {
  const requests = [];
  const supplied = tilePixels();
  const provider = frameProvider(async (request) => {
    requests.push(request);
    return supplied;
  });
  assert.equal(provider.tileWidth, 256);
  assert.equal(provider.maximumLevel, 6);
  assert.equal(provider.hasAlphaChannel, true);
  const tile = await provider.requestImage(3, 1, 2);
  assert.equal(tile.width, 256);
  assert.equal(tile.height, 256);
  assert.deepEqual(tile.drawn, [[supplied, 0, 0]]);
  assert.equal(supplied.closes, 1);
  assert.equal(requests.length, 1);
  const { signal, ...rest } = requests[0];
  assert.deepEqual(rest, {
    product: 'radar',
    time,
    z: 2,
    x: 3,
    y: 1,
    size: 256,
  });
  assert.ok(signal instanceof AbortSignal);
});

test('a null tile is one shared transparent canvas', async () => {
  const provider = frameProvider(async () => null);
  const first = await provider.requestImage(0, 0, 0);
  const second = await provider.requestImage(1, 0, 0);
  assert.equal(first, second);
  assert.equal(first.width, 256);
  assert.deepEqual(first.drawn, [], 'nothing is drawn on it');
});

test('beyond the concurrency limit a tile is deferred to Cesium', async () => {
  const gates = [];
  const provider = frameProvider(
    () => {
      const gate = deferredTile();
      gates.push(gate);
      return gate.promise;
    },
    { maxConcurrent: 2 },
  );
  const first = provider.requestImage(0, 0, 1);
  const second = provider.requestImage(1, 0, 1);
  assert.equal(provider.requestImage(2, 0, 1), undefined);
  gates[0].resolve(null);
  await first;
  const third = provider.requestImage(2, 0, 1);
  assert.ok(third instanceof Promise, 'a finished tile frees its slot');
  gates[1].resolve(null);
  gates[2].resolve(null);
  await Promise.all([second, third]);
});

test('a failed tile rejects, which Cesium reports through errorEvent', async () => {
  const provider = frameProvider(async () => {
    throw new Error('frame unavailable');
  });
  await assert.rejects(provider.requestImage(0, 0, 0), /frame unavailable/);
  const wrong = tilePixels(512);
  const sized = frameProvider(async () => wrong);
  await assert.rejects(
    sized.requestImage(0, 0, 0),
    /Invalid weather tile dimensions/,
  );
  assert.equal(wrong.closes, 1, 'a refused tile is still released');
  const layer = new Cesium.ImageryLayer(provider);
  const reported = [];
  provider.errorEvent.addEventListener((error) => {
    reported.push(error);
    error.retry = false;
  });
  const imagery = { x: 0, y: 0, level: 0, request: undefined };
  layer._requestImagery(imagery);
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(reported.length, 1);
  assert.match(reported[0].error.message, /frame unavailable/);
  assert.equal(imagery.state, Cesium.ImageryState.FAILED);
  layer.destroy();
});

test('aborting the provider signal cancels tiles in flight and releases late pixels', async () => {
  const controller = new AbortController();
  const gate = deferredTile();
  let seen;
  const provider = frameProvider(
    ({ signal }) => {
      seen = signal;
      return gate.promise;
    },
    { signal: controller.signal },
  );
  const request = new Cesium.Request();
  const pending = provider.requestImage(0, 0, 0, request);
  assert.equal(seen.aborted, false);
  controller.abort();
  assert.equal(seen.aborted, true, 'the abort reaches the frame source');
  const late = tilePixels();
  gate.resolve(late);
  await assert.rejects(pending, { name: 'AbortError' });
  assert.equal(late.closes, 1);
  assert.equal(
    request.state,
    Cesium.RequestState.CANCELLED,
    'Cesium unloads a cancelled tile instead of failing it',
  );
  await assert.rejects(
    provider.requestImage(1, 0, 0),
    { name: 'AbortError' },
    'a closed frame asks the source for nothing more',
  );
});
