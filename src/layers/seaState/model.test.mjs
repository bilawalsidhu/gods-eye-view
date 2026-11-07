import assert from 'node:assert/strict';
import test from 'node:test';
import {
  SEA_STATE_BANDS,
  createSeaStateRaster,
  decodeSeaStateGrid,
  parseSeaStateManifest,
  sampleSeaState,
  seaStateBand,
} from './model.js';

test('heights fall in the WMO code table 3700 bands, an exact boundary belonging to the lower band', () => {
  const code = (metres) => seaStateBand(metres)?.code ?? null;
  assert.deepEqual(
    [0, 0.09, 0.1, 0.11, 0.5, 1.25, 1.26, 2.5, 4, 4.01, 6, 9, 14, 14.01].map(
      code,
    ),
    [1, 1, 1, 2, 2, 3, 4, 4, 5, 6, 6, 7, 8, 9],
  );
  assert.equal(code(NaN), null);
  assert.equal(code(-0.1), null);
  assert.deepEqual(
    SEA_STATE_BANDS.map(({ min }) => min),
    [0, 0.1, 0.5, 1.25, 2.5, 4, 6, 9, 14],
  );
});

function manifest(overrides = {}) {
  return {
    schemaVersion: 1,
    source: 'ecmwf-ifs',
    field: { kind: 'significant-wave-height', units: 'm' },
    cycle: {
      date: '20261023',
      hour: 18,
      forecastHour: 12,
      runIso: '2026-10-23T18:00:00.000Z',
      validIso: '2026-10-24T06:00:00.000Z',
    },
    grid: { nx: 4, ny: 3, lo1: 0, la1: 90, dx: 90, dy: 90 },
    oceanCells: 10,
    maxValue: 8.6,
    ageMs: 120_000,
    stale: false,
    gridUrl: '/api/sea-state/grid/ifs-20261023-18-f12-0.5.bin',
    ...overrides,
  };
}

test('a well-formed manifest is read; anything the layer relies on being wrong refuses it', () => {
  const parsed = parseSeaStateManifest(manifest());
  assert.equal(parsed.validIso, '2026-10-24T06:00:00.000Z');
  assert.equal(parsed.maxValue, 8.6);
  assert.equal(parsed.stale, false);
  for (const bad of [
    { schemaVersion: 2 },
    { field: { kind: 'significant-wave-height', units: 'ft' } },
    { grid: { nx: 4, ny: 3, lo1: 0, la1: 90, dx: 0, dy: 90 } },
    { grid: { nx: 2000, ny: 2000, lo1: 0, la1: 90, dx: 1, dy: 1 } },
    { gridUrl: 'https://elsewhere.example/grid.bin' },
    { cycle: { runIso: 'soon', validIso: 'later' } },
    { ageMs: -1 },
  ])
    assert.equal(
      parseSeaStateManifest(manifest(bad)),
      null,
      JSON.stringify(bad),
    );
  assert.equal(parseSeaStateManifest(null), null);
});

test('the grid decodes only at its advertised size, little-endian, with NaN preserved', () => {
  const grid = { nx: 2, ny: 2 };
  const buffer = new ArrayBuffer(16);
  const view = new DataView(buffer);
  [1.5, NaN, 3, 4].forEach((value, i) => view.setFloat32(i * 4, value, true));
  const values = decodeSeaStateGrid(buffer, grid);
  assert.equal(values[0], 1.5);
  assert.ok(Number.isNaN(values[1]));
  assert.equal(decodeSeaStateGrid(new ArrayBuffer(12), grid), null);
  assert.equal(decodeSeaStateGrid(new Uint8Array(16), grid), null);
});

/** 4 × 3 at 90°: rows 90°N, the equator, 90°S; columns 0, 90, 180, 270°E. */
const field = {
  grid: { nx: 4, ny: 3, lo1: 0, la1: 90, dx: 90, dy: 90 },
  values: Float32Array.from([1, 1, 1, 1, 2, NaN, 6, 2, 1, 1, 1, 1]),
};

test('sampling blends only sea corners, wraps the antimeridian, and is null on land', () => {
  assert.equal(sampleSeaState(field, 0, 0), 2);
  assert.equal(sampleSeaState(field, 45, 0), 2, 'land drops out of the blend');
  assert.equal(sampleSeaState(field, 90, 0), null);
  assert.equal(sampleSeaState(field, -180, 0), 6);
  assert.equal(sampleSeaState(field, 180, 0), 6);
  assert.equal(
    sampleSeaState(field, -45, 0),
    2,
    'west longitudes wrap to 315°E',
  );
  assert.equal(sampleSeaState(field, NaN, 0), null);
  assert.equal(sampleSeaState(null, 0, 0), null);
});

test('the raster colours sea by band, leaves land and calm water clear, and is null when empty', () => {
  const raster = createSeaStateRaster(field, 8, 4);
  assert.equal(raster.width, 8);
  const pixel = (x, y) =>
    Array.from(raster.rgba.slice((y * 8 + x) * 4, (y * 8 + x) * 4 + 4));
  // Pixel (4, 1) is centred on 22.5°E, 22.5°N: three sea corners (1, 1 and
  // 2 m; the fourth is land) blend to about 1.69 m, a moderate sea.
  const moderate = SEA_STATE_BANDS.find(({ code }) => code === 4);
  assert.deepEqual(pixel(4, 1).slice(0, 3), [0x4b, 0xb8, 0xa9]);
  assert.equal(pixel(4, 1)[3], Math.round(255 * moderate.alpha));
  const calm = { ...field, values: new Float32Array(12).fill(0.05) };
  assert.equal(createSeaStateRaster(calm, 8, 4), null);
  const land = { ...field, values: new Float32Array(12).fill(NaN) };
  assert.equal(createSeaStateRaster(land, 8, 4), null);
  assert.equal(createSeaStateRaster(field, 1, 4), null);
});
