import test from 'node:test';
import assert from 'node:assert/strict';
import {
  composeMercatorImage,
  mercatorBbox,
  mercatorTileRange,
  chooseMercatorZoom,
  latitudeToMercatorRow,
  mercatorRowToLatitude,
  mercatorSourceRow,
  RAINVIEWER_BOUNDS,
} from './mercatorMosaic.js';
import { acquireWeatherImage } from './infraredImage.js';
import { validateWeatherSnapshot } from './source.js';

const time = '2026-09-23T12:00:00.000Z';
const near = (a, b) => assert.ok(Math.abs(a - b) < 1e-8, `${a} ≈ ${b}`);
function canvas() {
  const value = { draws: [] };
  value.getContext = () => ({ drawImage: (...args) => value.draws.push(args) });
  return value;
}
const options = {
  product: 'radar-global',
  time,
  createCanvas: canvas,
  fetchImpl: async () => new Response(new Uint8Array([1])),
  decodeImage: async () => ({ width: 256, height: 256 }),
};

test('Mercator maths preserve XYZ edges, latitude direction and zoom budgets', () => {
  near(latitudeToMercatorRow(0), 0.5);
  near(latitudeToMercatorRow(60), 0.2903996408605086);
  near(latitudeToMercatorRow(-60), 0.7096003591394914);
  for (const lat of [-85, -60, 0, 60, 85])
    near(mercatorRowToLatitude(latitudeToMercatorRow(lat)), lat);
  assert.deepEqual(
    mercatorBbox({ ...RAINVIEWER_BOUNDS, north: 90, south: -90 }),
    RAINVIEWER_BOUNDS,
  );
  assert.deepEqual(mercatorTileRange(RAINVIEWER_BOUNDS, 1), {
    west: 0,
    east: 1,
    north: 0,
    south: 1,
    count: 4,
  });
  assert.deepEqual(
    mercatorTileRange({ west: -180, east: 0, north: 60, south: 0 }, 1),
    { west: 0, east: 0, north: 0, south: 0, count: 1 },
  );
  assert.equal(chooseMercatorZoom(RAINVIEWER_BOUNDS, { width: 2048 }), 2);
  assert.equal(chooseMercatorZoom(RAINVIEWER_BOUNDS, { width: 128 }), 0);
  const detail = { west: 10, east: 11, south: 40, north: 41 };
  assert.equal(chooseMercatorZoom(detail, { width: 4096 }), 7);
  assert.throws(() => mercatorBbox({ ...detail, east: -10 }));
});

test('2×2 fake tiles compose north-up and row strips reproject the equator and ±60°', async () => {
  const urls = [],
    images = [];
  const bbox = { west: -180, east: 180, north: 60.5, south: -60.5 };
  const { texture } = await composeMercatorImage({
    ...options,
    bbox,
    size: { width: 512, height: 121 },
    maxTiles: 4,
    fetchImpl: async (url) => {
      urls.push(url);
      return new Response('tile');
    },
    decodeImage: async () => {
      const image = {
        width: 256,
        height: 256,
        close() {
          this.closed = true;
        },
      };
      images.push(image);
      return image;
    },
  });
  assert.equal(urls.length, 4);
  assert.ok(
    urls.every(
      (url) =>
        url.startsWith('/api/weather/tile?product=radar-global&') &&
        url.includes('&z=1&'),
    ),
  );
  const mosaic = texture.draws[0][0];
  assert.equal(mosaic.width, 512);
  assert.equal(mosaic.height, 512);
  assert.deepEqual(
    mosaic.draws.map((draw) => draw.slice(1)).sort(),
    [
      [0, 0],
      [0, 256],
      [256, 0],
      [256, 256],
    ].sort(),
  );
  assert.equal(texture.draws.length, 121);
  for (const [row, latitude] of [
    [0, 60],
    [60, 0],
    [120, -60],
  ]) {
    near(
      mercatorSourceRow(row, 121, bbox, 1, 0),
      latitudeToMercatorRow(latitude) * 512,
    );
    const [, sx, sy, sw, sh, dx, dy, dw, dh] = texture.draws[row];
    near(sy, latitudeToMercatorRow(latitude) * 512 - 0.5);
    assert.deepEqual([sx, sw, sh, dx, dy, dw, dh], [0, 512, 1, 0, row, 512, 1]);
  }
  assert.ok(images.every((image) => image.closed));
});

test('mosaic limits concurrency, tolerates partial failure, releases decoded images and rejects total failure', async () => {
  let active = 0,
    peak = 0,
    calls = 0,
    closed = 0;
  const result = await composeMercatorImage({
    ...options,
    maxTiles: 4,
    concurrency: 2,
    fetchImpl: async () => {
      active++;
      peak = Math.max(peak, active);
      const n = ++calls;
      await new Promise((resolve) => setImmediate(resolve));
      active--;
      return n === 1 ? new Response('', { status: 503 }) : new Response('tile');
    },
    decodeImage: async () => ({
      width: 256,
      height: 256,
      close() {
        closed++;
      },
    }),
  });
  assert.equal(peak, 2);
  assert.equal(closed, 3);
  assert.equal(result.texture.draws[0][0].draws.length, 3);
  await assert.rejects(
    composeMercatorImage({
      ...options,
      fetchImpl: async () => new Response('', { status: 429 }),
      sleep: async () => {},
    }),
    /tiles unavailable/,
  );
  await assert.rejects(
    composeMercatorImage({
      ...options,
      signal: AbortSignal.abort(),
      fetchImpl: () => assert.fail('aborted'),
    }),
    { name: 'AbortError' },
  );
  const controller = new AbortController();
  closed = 0;
  await assert.rejects(
    composeMercatorImage({
      ...options,
      signal: controller.signal,
      concurrency: 1,
      decodeImage: async () => {
        controller.abort();
        return {
          width: 256,
          height: 256,
          close() {
            closed++;
          },
        };
      },
    }),
    { name: 'AbortError' },
  );
  assert.equal(closed, 1);
});

test('whole and detail RainViewer images use composition and strict source metadata', async () => {
  for (const bbox of [null, { west: 10, east: 16, south: 40, north: 43 }]) {
    const result = await acquireWeatherImage('radar-global', time, {
      ...options,
      bbox,
      size: { width: 2048, height: 1024 },
    });
    assert.equal(result.texture.width, 2048);
    assert.equal(result.texture.height, 1024);
  }
  const snapshot = {
    schemaVersion: 1,
    product: 'radar-global',
    bounds: RAINVIEWER_BOUNDS,
    times: [time],
    latest: time,
    tileSize: 256,
    maxLevel: 7,
    tilingScheme: 'web-mercator',
  };
  assert.equal(validateWeatherSnapshot(snapshot, 'radar-global'), snapshot);
  for (const patch of [
    { maxLevel: 6 },
    { maxLevel: 8 },
    { tilingScheme: 'geographic' },
    { bounds: { ...RAINVIEWER_BOUNDS, north: 86 } },
  ])
    assert.throws(() =>
      validateWeatherSnapshot({ ...snapshot, ...patch }, 'radar-global'),
    );
  assert.throws(() =>
    validateWeatherSnapshot({ ...snapshot, product: 'radar' }, 'radar'),
  );
});

test('a metered tile waits out Retry-After instead of leaving a hole', async () => {
  const seen = new Map();
  const waits = [];
  const result = await composeMercatorImage({
    ...options,
    bbox: { west: -180, south: -85.0511, east: 180, north: 85.0511 },
    size: { width: 512, height: 256 },
    maxTiles: 1,
    fetchImpl: async (url) => {
      const count = (seen.get(url) ?? 0) + 1;
      seen.set(url, count);
      return count === 1
        ? new Response('', { status: 429, headers: { 'Retry-After': '3' } })
        : new Response(new Uint8Array([1]));
    },
    sleep: async (ms) => {
      waits.push(ms);
    },
  });
  assert.deepEqual(waits, [3000]);
  assert.equal(result.texture.draws[0][0].draws.length, 1);
});
