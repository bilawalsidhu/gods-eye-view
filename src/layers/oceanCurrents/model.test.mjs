import assert from 'node:assert/strict';
import test from 'node:test';
import {
  CURRENT_SPEED_STOPS,
  createCurrentSpeedRaster,
  currentSpeedColor,
  decodeOceanCurrentsGrid,
  parseOceanCurrentsManifest,
  sampleOceanCurrent,
} from './model.js';

test('speed blends between the stops and is clear at or below the first', () => {
  for (const speed of [NaN, -0.1, 0, 0.1])
    assert.equal(currentSpeedColor(speed), null);
  const alpha = (speed) => currentSpeedColor(speed)[3];
  assert.equal(alpha(0.25), Math.round(255 * CURRENT_SPEED_STOPS[1].alpha));
  assert.deepEqual(currentSpeedColor(1).slice(0, 3), [0xe1, 0xcf, 0x4f]);
  const mid = currentSpeedColor(0.75);
  assert.deepEqual(mid, [
    Math.round((0x3f + 0xe1) / 2),
    Math.round((0xbf + 0xcf) / 2),
    Math.round((0xa8 + 0x4f) / 2),
    Math.round(255 * 0.55),
  ]);
  assert.ok(alpha(0.11) < alpha(0.24), 'opacity rises with speed');
  assert.deepEqual(
    currentSpeedColor(3),
    currentSpeedColor(1.5),
    'held past the last stop',
  );
});

function manifest(overrides = {}) {
  return {
    schemaVersion: 1,
    source: 'ecmwf-ifs',
    field: {
      kind: 'surface-sea-water-velocity',
      units: 'm/s',
      components: ['u', 'v'],
    },
    cycle: {
      runIso: '2026-10-24T00:00:00.000Z',
      validIso: '2026-10-24T12:00:00.000Z',
    },
    grid: { nx: 4, ny: 3, lo1: 0, la1: 90, dx: 90, dy: 90 },
    oceanCells: 10,
    maxSpeed: 2.05,
    ageMs: 0,
    stale: false,
    gridUrl: '/api/ocean-currents/grid/ifs-20261024-0-f12-0.5.bin',
    ...overrides,
  };
}

test('a well-formed manifest is read; anything the layer relies on being wrong refuses it', () => {
  const parsed = parseOceanCurrentsManifest(manifest());
  assert.equal(parsed.maxSpeed, 2.05);
  assert.equal(parsed.validIso, '2026-10-24T12:00:00.000Z');
  for (const bad of [
    { schemaVersion: 2 },
    {
      field: {
        kind: 'surface-sea-water-velocity',
        units: 'kn',
        components: ['u', 'v'],
      },
    },
    {
      field: {
        kind: 'surface-sea-water-velocity',
        units: 'm/s',
        components: ['v', 'u'],
      },
    },
    {
      field: {
        kind: 'significant-wave-height',
        units: 'm/s',
        components: ['u', 'v'],
      },
    },
    { grid: { nx: 2000, ny: 2000, lo1: 0, la1: 90, dx: 1, dy: 1 } },
    { gridUrl: '/api/sea-state/grid/x.bin' },
    { cycle: { runIso: 'soon', validIso: 'later' } },
  ])
    assert.equal(
      parseOceanCurrentsManifest(manifest(bad)),
      null,
      JSON.stringify(bad),
    );
});

test('the grid decodes u then v only at twice the advertised size', () => {
  const grid = { nx: 2, ny: 1 };
  const buffer = new ArrayBuffer(16);
  const view = new DataView(buffer);
  [1, NaN, -2, 3].forEach((value, i) => view.setFloat32(i * 4, value, true));
  const { u, v } = decodeOceanCurrentsGrid(buffer, grid);
  assert.equal(u[0], 1);
  assert.ok(Number.isNaN(u[1]));
  assert.deepEqual(Array.from(v), [-2, 3]);
  assert.equal(decodeOceanCurrentsGrid(new ArrayBuffer(8), grid), null);
});

/** 4 × 3 at 90°: rows 90°N, the equator, 90°S; columns 0, 90, 180, 270°E. */
const field = {
  grid: { nx: 4, ny: 3, lo1: 0, la1: 90, dx: 90, dy: 90 },
  u: Float32Array.from([0, 0, 0, 0, 0, NaN, -1, 1.2, 0, 0, 0, 0]),
  v: Float32Array.from([0, 0, 0, 0, 1, NaN, 0, 1.6, 0, 0, 0, 0]),
};

test('a sample gives speed and the direction the water flows towards, and null on land', () => {
  const north = sampleOceanCurrent(field, 0, 0);
  assert.equal(north.speed, 1);
  assert.equal(north.towards, 0);
  assert.equal(sampleOceanCurrent(field, 180, 0).towards, 270, 'westward');
  const east = sampleOceanCurrent(field, 270, 0);
  assert.ok(Math.abs(east.speed - 2) < 1e-6);
  assert.ok(Math.abs(east.towards - 36.87) < 0.01);
  assert.equal(sampleOceanCurrent(field, 90, 0), null);
});

test('the raster colours fast water, leaves slow water and land clear, and is null when empty', () => {
  const raster = createCurrentSpeedRaster(field, 8, 4);
  const alpha = (x, y) => raster.rgba[(y * 8 + x) * 4 + 3];
  // Pixel (6, 1) is centred on 112.5°E, 22.5°N: between the equator's land
  // cell at 90°E and its westward cell at 180°, under two still polar cells.
  const speed = sampleOceanCurrent(field, 112.5, 22.5).speed;
  const color = currentSpeedColor(speed);
  assert.ok(color[3] > 0, `${speed} m/s is drawn`);
  assert.equal(alpha(6, 1), color[3]);
  const still = {
    ...field,
    u: new Float32Array(12).fill(0.05),
    v: new Float32Array(12),
  };
  assert.equal(createCurrentSpeedRaster(still, 8, 4), null);
});
