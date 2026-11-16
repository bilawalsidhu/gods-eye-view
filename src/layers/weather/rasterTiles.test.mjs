import test from 'node:test';
import assert from 'node:assert/strict';
import { drawMosaicTile, createFrameTileFetch } from './rasterTiles.js';
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

const time = '2026-09-15T20:00:00.000Z';
// A tile canvas double that records what is drawn on it and encodes to bytes
// naming its draws.
function tileCanvas() {
  const canvas = { width: 0, height: 0, drawn: [], encoded: 0 };
  canvas.getContext = () => ({
    drawImage: (source, ...args) => canvas.drawn.push([source, ...args]),
    putImageData: (source, ...args) => canvas.drawn.push([source, ...args]),
  });
  canvas.convertToBlob = async ({ type }) => {
    canvas.encoded++;
    assert.equal(type, 'image/png');
    return new Blob([`tile:${canvas.drawn.length}`]);
  };
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
const text = (bytes) => new TextDecoder().decode(bytes);
function frameFetch(getTile, options = {}) {
  const canvases = [];
  const fetchTile = createFrameTileFetch({
    frameSource: { getTile },
    product: 'radar',
    time,
    createCanvas: () => {
      const canvas = tileCanvas();
      canvases.push(canvas);
      return canvas;
    },
    ...options,
  });
  const ask = (x, y, level, signal = new AbortController().signal) =>
    fetchTile({ tile: { x, y, level }, url: 'unused', signal });
  return { ask, canvases };
}

test('a frame tile fetch draws each supplied tile into its own canvas, releases it, and answers PNG bytes', async () => {
  const requests = [];
  const supplied = tilePixels();
  const { ask, canvases } = frameFetch(async (request) => {
    requests.push(request);
    return supplied;
  });
  const answer = await ask(3, 1, 2);
  assert.equal(answer.contentType, 'image/png');
  assert.equal(text(answer.bytes), 'tile:1');
  assert.equal(canvases.length, 1);
  assert.equal(canvases[0].width, 256);
  assert.deepEqual(canvases[0].drawn, [[supplied, 0, 0]]);
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

test('a null tile is one shared transparent tile, drawn rather than missing', async () => {
  const { ask, canvases } = frameFetch(async () => null);
  const first = await ask(0, 0, 0);
  const second = await ask(1, 0, 0);
  assert.equal(text(first.bytes), 'tile:0', 'nothing is drawn on it');
  assert.equal(text(second.bytes), 'tile:0');
  assert.notEqual(first.bytes, second.bytes, 'each answer has its own bytes');
  assert.equal(canvases.length, 1, 'made and encoded once');
  assert.equal(canvases[0].encoded, 1);
});

test('an empty tile that failed to encode is encoded again next time', async () => {
  const { ask, canvases } = frameFetch(async () => null, {
    createCanvas: () => {
      const canvas = tileCanvas();
      if (!canvases.length)
        canvas.convertToBlob = async () =>
          Promise.reject(new Error('no encoder'));
      canvases.push(canvas);
      return canvas;
    },
  });
  await assert.rejects(ask(0, 0, 0), /no encoder/);
  const next = await ask(1, 0, 0);
  assert.equal(text(next.bytes), 'tile:0');
  assert.equal(canvases.length, 2);
});

test('a failed tile rejects, which the renderer reports as a tile error', async () => {
  const { ask } = frameFetch(async () => {
    throw new Error('frame unavailable');
  });
  await assert.rejects(ask(0, 0, 0), /frame unavailable/);
  const wrong = tilePixels(512);
  const sized = frameFetch(async () => wrong);
  await assert.rejects(sized.ask(0, 0, 0), /Invalid weather tile dimensions/);
  assert.equal(wrong.closes, 1, 'a refused tile is still released');
});

test('aborting the frame or the tile cancels it at the source and releases late pixels', async () => {
  const controller = new AbortController();
  const gate = deferredTile();
  let seen;
  const { ask } = frameFetch(
    ({ signal }) => {
      seen = signal;
      return gate.promise;
    },
    { signal: controller.signal },
  );
  const pending = ask(0, 0, 0);
  assert.equal(seen.aborted, false);
  controller.abort();
  assert.equal(seen.aborted, true, 'the abort reaches the frame source');
  const late = tilePixels();
  gate.resolve(late);
  await assert.rejects(pending, { name: 'AbortError' });
  assert.equal(late.closes, 1);
  await assert.rejects(
    ask(1, 0, 0),
    { name: 'AbortError' },
    'a closed frame asks the source for nothing more',
  );
  // The renderer's own abort of one tile reaches the source too.
  const own = frameFetch(({ signal }) => {
    seen = signal;
    return new Promise(() => {});
  });
  const tile = new AbortController();
  void own.ask(0, 0, 0, tile.signal).catch(() => {});
  tile.abort();
  assert.equal(seen.aborted, true);
});
