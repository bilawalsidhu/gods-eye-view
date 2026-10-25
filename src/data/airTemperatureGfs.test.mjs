import test from 'node:test';
import assert from 'node:assert/strict';
import {
  fetchGfsAirTemperature,
  gfsMessageRange,
  parseGfsIdx,
} from '../../server/providers/wind/gfs.js';
import { resampleTemperatureGrid } from '../../server/providers/wind/grid.js';
import { encodeAirTemperatureGrid } from '../../server/providers/airTemperature.js';

const IDX = [
  '1:0:d=2026091506:TMP:850 mb:6 hour fcst:',
  '2:2:d=2026091506:TMP:surface:6 hour fcst:',
  '3:4:d=2026091506:TMP:2 m above ground:6 hour fcst:',
  '4:7:d=2026091506:RH:2 m above ground:6 hour fcst:',
].join('\n');
const field = (extra = {}) => ({
  ni: 4,
  nj: 3,
  lo1: 0,
  la1: 90,
  di: 90,
  dj: 90,
  units: 'K',
  values: new Float64Array(12).fill(293.15),
  ...extra,
});

test('fetches exactly the 2 m TMP range when no wind records exist', async () => {
  // Given
  const calls = [];
  const decoded = [];
  // When
  const value = await fetchGfsAirTemperature({
    now: () => Date.UTC(2026, 8, 15, 12),
    targetDx: 90,
    fetchImpl: async (url, options) => {
      calls.push({ url, options });
      return url.endsWith('.idx')
        ? new Response(IDX)
        : new Response(Uint8Array.of(7, 8, 9), { status: 206 });
    },
    decodeImpl: async (bytes) => {
      decoded.push([...bytes]);
      return field();
    },
  });
  // Then
  assert.equal(calls.length, 2);
  assert.equal(calls[1].options.headers.Range, 'bytes=4-6');
  assert.equal(calls[0].url, `${calls[1].url}.idx`);
  assert.match(
    calls[1].url,
    /gfs\.20260915\/06\/atmos\/gfs\.t06z\.pgrb2\.0p25\.f006$/,
  );
  assert.ok(calls.every(({ options }) => options.redirect === 'error'));
  assert.deepEqual(decoded, [[7, 8, 9]]);
  assert.deepEqual(value.cycle, {
    date: '20260915',
    hour: 6,
    forecastHour: 6,
    runIso: '2026-09-15T06:00:00.000Z',
    validIso: '2026-09-15T12:00:00.000Z',
  });
  assert.equal(value.level, '2 m above ground');
  assert.equal(value.units, '°C');
  assert.deepEqual([...value.grid.scalar], Array(12).fill(20));
  assert.equal(value.grid.u, undefined);
  assert.equal(value.grid.v, undefined);
});

test('rejects a missing or terminal TMP record instead of selecting another level', () => {
  // Given
  const lookup = { variable: 'TMP', level: '2 m above ground' };
  const inventories = [
    IDX.replace('TMP:2 m above ground', 'TMP:10 m above ground'),
    IDX.split('\n').slice(0, 3).join('\n'),
  ];
  // When / Then
  for (const inventory of inventories)
    assert.throws(
      () => gfsMessageRange(parseGfsIdx(inventory), lookup),
      /missing TMP/,
    );
});

test('interpolates Kelvin across the longitude seam and quantizes a Celsius roundtrip', () => {
  // Given
  const celsius = [
    -20.12, 0, 20.34, 40.56, -10.12, 10, 30.34, 50.56, 0, 20, 40, 60,
  ];
  const input = field({ values: celsius.map((value) => value + 273.15) });
  // When
  const grid = resampleTemperatureGrid({ field: input, targetDx: 45 });
  const bytes = encodeAirTemperatureGrid(grid);
  const read = (x, y) => bytes.readInt16LE((y * grid.nx + x) * 2) / 100;
  // Then
  assert.deepEqual(
    [grid.nx, grid.ny, grid.lo1, grid.la1, grid.dx, grid.dy],
    [8, 5, 0, 90, 45, 45],
  );
  assert.equal(bytes.length, 8 * 5 * 2);
  assert.equal(read(0, 0), -20.12);
  assert.equal(read(2, 0), 0);
  assert.equal(read(1, 0), -10.06);
  assert.equal(read(7, 0), 10.22);
  assert.equal(read(0, 1), -15.12);
  assert.equal(read(6, 4), 60);
  for (let i = 0; i < grid.scalar.length; i += 1)
    assert.ok(
      Math.abs(bytes.readInt16LE(i * 2) * 0.01 - grid.scalar[i]) <= 0.0051,
    );
});

test('rejects malformed scalar fields before resampling', () => {
  // Given
  const inputs = [
    field({ units: '°C' }),
    field({ values: [273] }),
    field({ ni: 0 }),
    field({ di: 0 }),
    field({ values: Array(12).fill(NaN) }),
  ];
  // When / Then
  for (const input of inputs)
    assert.throws(() =>
      resampleTemperatureGrid({ field: input, targetDx: 90 }),
    );
});

test('rejects non-finite or unrepresentable values instead of wrapping int16', () => {
  // Given
  const grid = { nx: 1, ny: 1, lo1: 0, la1: 90, dx: 1, dy: 1 };
  // When / Then
  for (const value of [NaN, Infinity, -Infinity, 328, -328])
    assert.throws(() =>
      encodeAirTemperatureGrid({ ...grid, scalar: Float32Array.of(value) }),
    );
});

test('fails acquisition when the required range is short or the decoder fails', async () => {
  // Given
  for (const failure of ['short', 'decode']) {
    const options = {
      now: () => Date.UTC(2026, 8, 15, 12),
      targetDx: 90,
      fetchImpl: async (url) =>
        url.endsWith('.idx')
          ? new Response(IDX)
          : new Response(new Uint8Array(failure === 'short' ? 2 : 3), {
              status: 206,
            }),
      decodeImpl: async () => {
        throw new Error('decoder failure');
      },
    };
    // When / Then
    await assert.rejects(
      fetchGfsAirTemperature(options),
      failure === 'short' ? /invalid range length/ : /decoder failure/,
    );
  }
});

test('honors cancellation after decoding before publishing a snapshot', async () => {
  // Given
  const controller = new AbortController();
  const options = {
    signal: controller.signal,
    fetchImpl: async (url) =>
      url.endsWith('.idx')
        ? new Response(IDX)
        : new Response(new Uint8Array(3), { status: 206 }),
    decodeImpl: async () => {
      controller.abort();
      return field();
    },
  };
  // When / Then
  await assert.rejects(fetchGfsAirTemperature(options), { name: 'AbortError' });
});
