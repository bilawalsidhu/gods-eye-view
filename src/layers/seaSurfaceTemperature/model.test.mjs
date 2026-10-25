import assert from 'node:assert/strict';
import test from 'node:test';
import {
  SST_STOPS,
  createSeaSurfaceTemperatureRaster,
  decodeSeaSurfaceTemperatureGrid,
  parseSeaSurfaceTemperatureManifest,
  sampleSeaSurfaceTemperature,
  seaSurfaceTemperatureColor,
} from './model.js';

test('temperature blends between the stops, is held past the ends and is null with no value', () => {
  assert.equal(seaSurfaceTemperatureColor(NaN), null);
  assert.equal(seaSurfaceTemperatureColor(undefined), null);
  assert.deepEqual(seaSurfaceTemperatureColor(22), [0xe8, 0xd4, 0x54, 191]);
  // Halfway from 18 °C (#8ad49a) to 22 °C (#e8d454).
  assert.deepEqual(seaSurfaceTemperatureColor(20), [
    Math.round((0x8a + 0xe8) / 2),
    0xd4,
    Math.round((0x9a + 0x54) / 2),
    191,
  ]);
  assert.deepEqual(
    seaSurfaceTemperatureColor(-5),
    seaSurfaceTemperatureColor(-2),
  );
  assert.deepEqual(
    seaSurfaceTemperatureColor(40),
    seaSurfaceTemperatureColor(32),
  );
  assert.deepEqual(
    SST_STOPS.map(({ min }) => min),
    [-2, 3, 8, 13, 18, 22, 26, 29, 32],
  );
});

function manifest(overrides = {}) {
  return {
    schemaVersion: 1,
    source: 'noaa-crw-coraltemp',
    field: { kind: 'sea-surface-temperature', units: 'degC' },
    cycle: { date: '20261022', validIso: '2026-10-22T12:00:00.000Z' },
    grid: { nx: 4, ny: 3, lo1: 0, la1: 90, dx: 90, dy: 90 },
    oceanCells: 10,
    minValue: -1.8,
    maxValue: 33.48,
    ageMs: 0,
    stale: true,
    gridUrl: '/api/sea-surface-temperature/grid/crw-20261022-0.5.bin',
    ...overrides,
  };
}

test('a well-formed manifest is read; anything the layer relies on being wrong refuses it', () => {
  const parsed = parseSeaSurfaceTemperatureManifest(manifest());
  assert.equal(parsed.validIso, '2026-10-22T12:00:00.000Z');
  assert.equal(parsed.minValue, -1.8);
  assert.equal(parsed.maxValue, 33.48);
  assert.equal(parsed.stale, true);
  assert.equal(
    parseSeaSurfaceTemperatureManifest(manifest({ maxValue: 'hot' })).maxValue,
    null,
  );
  for (const bad of [
    { schemaVersion: 2 },
    { field: { kind: 'sea-surface-temperature', units: 'degF' } },
    { field: { kind: 'significant-wave-height', units: 'degC' } },
    { grid: { nx: 4, ny: 3, lo1: 0, la1: 90, dx: 0, dy: 90 } },
    { grid: { nx: 2000, ny: 2000, lo1: 0, la1: 90, dx: 1, dy: 1 } },
    { gridUrl: '/api/sea-state/grid/x.bin' },
    { cycle: { validIso: 'yesterday' } },
    { ageMs: -1 },
  ])
    assert.equal(
      parseSeaSurfaceTemperatureManifest(manifest(bad)),
      null,
      JSON.stringify(bad),
    );
});

test('the grid decodes only at exactly the advertised size', () => {
  const grid = { nx: 2, ny: 1 };
  const buffer = new ArrayBuffer(8);
  new DataView(buffer).setFloat32(0, 21.5, true);
  new DataView(buffer).setFloat32(4, NaN, true);
  const values = decodeSeaSurfaceTemperatureGrid(buffer, grid);
  assert.equal(values[0], 21.5);
  assert.ok(Number.isNaN(values[1]));
  assert.equal(
    decodeSeaSurfaceTemperatureGrid(new ArrayBuffer(12), grid),
    null,
  );
});

/** 4 × 3 at 90°: rows 90°N, the equator, 90°S; columns 0, 90, 180, 270°E. */
const field = {
  grid: { nx: 4, ny: 3, lo1: 0, la1: 90, dx: 90, dy: 90 },
  values: Float32Array.from([
    -1.8,
    -1.8,
    -1.8,
    -1.8,
    28,
    NaN,
    12,
    20,
    2,
    2,
    2,
    2,
  ]),
};

test('a sample blends only sea corners and is null on land', () => {
  assert.equal(sampleSeaSurfaceTemperature(field, 0, 0), 28);
  assert.equal(sampleSeaSurfaceTemperature(field, 90, 0), null);
  assert.equal(sampleSeaSurfaceTemperature(field, 225, 0), 16);
});

test('the raster colours every sea pixel, leaves land clear, and is null when all land', () => {
  const raster = createSeaSurfaceTemperatureRaster(field, 8, 4);
  const pixel = (x, y) =>
    Array.from(raster.rgba.slice((y * 8 + x) * 4, (y * 8 + x) * 4 + 4));
  // Pixel (0, 0) is centred on 157.5°W, 67.5°N, over cold polar water.
  assert.deepEqual(
    pixel(0, 0),
    seaSurfaceTemperatureColor(
      sampleSeaSurfaceTemperature(field, -157.5, 67.5),
    ),
  );
  const land = { ...field, values: new Float32Array(12).fill(NaN) };
  assert.equal(createSeaSurfaceTemperatureRaster(land, 8, 4), null);
  // North of the 45°N row only its two land corners carry weight: clear.
  const island = {
    grid: { nx: 2, ny: 2, lo1: 0, la1: 45, dx: 180, dy: 90 },
    values: Float32Array.from([NaN, NaN, NaN, 10]),
  };
  const islandRaster = createSeaSurfaceTemperatureRaster(island, 4, 2);
  assert.ok(islandRaster.rgba.some((value, i) => i % 4 === 3 && value === 0));
});
