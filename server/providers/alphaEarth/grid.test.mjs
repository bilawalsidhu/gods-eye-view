import test from 'node:test';
import assert from 'node:assert/strict';

import {
  DEQUANTIZE,
  chooseLevel,
  cogWindow,
  computeChange,
  dequantize,
  lonLatToUtm,
  measureBox,
  outputGrid,
  sampleEmbeddings,
  utmZoneFromCrs,
  windowCostBytes,
} from './grid.js';
import {
  ALPHA_EARTH_BANDS,
  ALPHA_EARTH_GRID_NODATA,
} from './constants.js';

/** One 81.92 km COG in zone 10N whose south-west corner is (500000, 5079040). */
const COG = {
  key: 'annual/2024/10N/test.tiff',
  year: 2024,
  zone: 10,
  south: false,
  utmWest: 500_000,
  utmSouth: 5_079_040,
  utmEast: 581_920,
  utmNorth: 5_160_960,
};

function unitVector(axis, value = 127) {
  const v = new Int8Array(ALPHA_EARTH_BANDS);
  v[axis] = value;
  return v;
}

test('de-quantisation squares magnitude, keeps sign and maps NoData to NaN', () => {
  assert.equal(dequantize(0), 0);
  assert.ok(Math.abs(dequantize(127) - (127 / 127.5) ** 2) < 1e-6);
  assert.ok(Math.abs(dequantize(-64) + (64 / 127.5) ** 2) < 1e-6);
  assert.ok(Number.isNaN(dequantize(-128)));
  assert.equal(DEQUANTIZE.length, 256);
});

test('UTM zone comes only from WGS84 UTM EPSG codes', () => {
  assert.deepEqual(utmZoneFromCrs('EPSG:32610'), { zone: 10, south: false });
  assert.deepEqual(utmZoneFromCrs('EPSG:32760'), { zone: 60, south: true });
  assert.equal(utmZoneFromCrs('EPSG:4326'), null);
  assert.equal(utmZoneFromCrs('EPSG:32661'), null);
  assert.equal(utmZoneFromCrs(undefined), null);
});

test('UTM forward projection matches reference coordinates', () => {
  const [e0, n0] = lonLatToUtm(-123, 0, 10, false);
  assert.ok(Math.abs(e0 - 500_000) < 1e-6);
  assert.ok(Math.abs(n0) < 1e-6);
  // Empire State Building: 18T 585628 4511322 (published, ±1 m).
  const [e, n] = lonLatToUtm(-73.9857, 40.7484, 18, false);
  assert.ok(Math.abs(e - 585_628) < 3, `easting ${e}`);
  assert.ok(Math.abs(n - 4_511_322) < 3, `northing ${n}`);
  // Southern hemisphere adds the 10 000 km false northing.
  const [, ns] = lonLatToUtm(-123, -1, 10, true);
  assert.ok(ns < 10_000_000 && ns > 9_880_000);
});

test('boxes must be ordered and inside WGS84 bounds', () => {
  assert.equal(measureBox({ west: 1, south: 0, east: 0, north: 1 }), null);
  assert.equal(measureBox({ west: 0, south: 0, east: 181, north: 1 }), null);
  assert.equal(measureBox({ west: 0, south: 0, east: Number.NaN, north: 1 }), null);
  const size = measureBox({ west: 0, south: 0, east: 0.01, north: 0.01 });
  assert.ok(Math.abs(size.widthMeters - 1113.2) < 1);
});

test('COG windows count rows up from the south edge (bottom-up files)', () => {
  // A box hugging the COG's south-west corner lands in the first rows/cols.
  const southWest = { west: -122.999, south: 45.869, east: -122.99, north: 45.874 };
  const sw = cogWindow(COG, southWest, 0);
  assert.ok(sw.y0 < 100, `south box starts near row 0, got ${sw.y0}`);
  assert.ok(sw.x0 < 100);
  // The same box moved to the north edge lands in the last rows.
  const northWest = { west: -122.999, south: 46.6, east: -122.99, north: 46.605 };
  const nw = cogWindow(COG, northWest, 0);
  assert.ok(nw.y1 > 7_900, `north box ends near the top row, got ${nw.y1}`);
  // Boxes outside the COG have no window.
  assert.equal(cogWindow(COG, { west: -100, south: 45, east: -99.9, north: 45.1 }, 0), null);
});

test('overview windows shrink with level and cost whole band tiles', () => {
  const box = { west: -122.9, south: 46.0, east: -122.85, north: 46.04 };
  const l0 = cogWindow(COG, box, 0);
  const l2 = cogWindow(COG, box, 2);
  assert.ok(l2.x1 - l2.x0 <= Math.ceil((l0.x1 - l0.x0) / 4) + 2);
  assert.equal(l2.pixelMeters, 40);
  // A window inside one 1024 px tile costs exactly one tile per band.
  assert.equal(
    windowCostBytes({ x0: 0, y0: 0, x1: 10, y1: 10 }, 0),
    64 * 800 * 1024,
  );
  // Crossing a tile boundary on both axes costs four.
  assert.equal(
    windowCostBytes({ x0: 1000, y0: 1000, x1: 1100, y1: 1100 }, 0),
    4 * 64 * 800 * 1024,
  );
  // Level 4 images are 512 px, a quarter of a full tile.
  assert.equal(
    windowCostBytes({ x0: 0, y0: 0, x1: 512, y1: 512 }, 4),
    64 * 800 * 1024 * 0.25,
  );
});

test('level choice is the finest one inside the byte budget', () => {
  const box = { west: -122.9, south: 46.0, east: -122.85, north: 46.04 };
  const cogs = [COG, { ...COG, year: 2018 }];
  const generous = chooseLevel(box, cogs, 1e12);
  assert.equal(generous.level, 0);
  const tight = chooseLevel(box, cogs, 30 * 1024 * 1024);
  assert.ok(tight.level >= 4, `tight budget picks a coarse level, got ${tight.level}`);
  assert.ok(tight.estimatedBytes <= 30 * 1024 * 1024);
  const impossible = chooseLevel(box, cogs, 1);
  assert.equal(impossible.level, 7);
});

test('output grid is north-up and capped per side', () => {
  const box = { west: 0, south: 0, east: 0.01, north: 0.01 };
  const grid = outputGrid(box, 10);
  assert.ok(grid.width > 100 && grid.height > 100);
  assert.ok(grid.lat(0) > grid.lat(grid.height - 1));
  assert.ok(grid.lon(0) < grid.lon(grid.width - 1));
  const capped = outputGrid({ west: 0, south: 0, east: 1, north: 1 }, 10);
  assert.equal(capped.width, 1024);
  assert.equal(capped.height, 1024);
});

test('sampling places south rows of the window at the bottom of the grid', () => {
  const box = { west: -122.999, south: 45.869, east: -122.99, north: 45.874 };
  const window = cogWindow(COG, box, 4);
  const w = window.x1 - window.x0;
  const h = window.y1 - window.y0;
  const data = new Int8Array(w * h * ALPHA_EARTH_BANDS);
  // Window row 0 (southernmost) gets axis 0, every other row axis 1.
  for (let row = 0; row < h; row += 1) {
    for (let col = 0; col < w; col += 1) {
      data.set(unitVector(row === 0 ? 0 : 1), (row * w + col) * ALPHA_EARTH_BANDS);
    }
  }
  const grid = outputGrid(box, 160);
  const sampled = sampleEmbeddings(grid, [{ cog: COG, window, data }]);
  assert.ok(sampled.filled.every(Boolean));
  const bottom = (grid.height - 1) * grid.width * ALPHA_EARTH_BANDS;
  assert.equal(sampled.values[0 * ALPHA_EARTH_BANDS + 1], 127, 'top row is north');
  assert.ok(sampled.values[bottom] === 127 || sampled.values[bottom + 1] === 127);
});

test('sampling skips NoData and never overwrites an earlier COG', () => {
  const box = { west: -122.999, south: 45.869, east: -122.99, north: 45.874 };
  const window = cogWindow(COG, box, 4);
  const size = (window.x1 - window.x0) * (window.y1 - window.y0) * ALPHA_EARTH_BANDS;
  const noData = new Int8Array(size).fill(-128);
  const axis2 = new Int8Array(size);
  for (let i = 0; i < size; i += ALPHA_EARTH_BANDS) axis2[i + 2] = 127;
  const axis3 = new Int8Array(size);
  for (let i = 0; i < size; i += ALPHA_EARTH_BANDS) axis3[i + 3] = 127;
  const grid = outputGrid(box, 160);
  const empty = sampleEmbeddings(grid, [{ cog: COG, window, data: noData }]);
  assert.ok(empty.filled.every((v) => v === 0));
  const both = sampleEmbeddings(grid, [
    { cog: COG, window, data: axis2 },
    { cog: COG, window, data: axis3 },
  ]);
  assert.equal(both.values[2], 127);
  assert.equal(both.values[3], 0);
});

test('change is 1 − cosine, quantised, with NoData where either year is empty', () => {
  const make = (vectors) => {
    const values = new Int8Array(vectors.length * ALPHA_EARTH_BANDS);
    const filled = new Uint8Array(vectors.length);
    vectors.forEach((v, i) => {
      if (!v) return;
      values.set(v, i * ALPHA_EARTH_BANDS);
      filled[i] = 1;
    });
    return { values, filled };
  };
  const a = make([unitVector(0), unitVector(0), unitVector(0), null]);
  const b = make([unitVector(0), unitVector(1), unitVector(0, -127), unitVector(0)]);
  const { grid, stats } = computeChange(a, b, 0.5);
  assert.equal(grid[0], 0, 'identical vectors do not change');
  assert.equal(grid[1], 254, 'orthogonal vectors are fully changed');
  assert.equal(grid[2], 254, 'opposite vectors clamp to 1');
  assert.equal(grid[3], ALPHA_EARTH_GRID_NODATA);
  assert.equal(stats.validFraction, 0.75);
  assert.equal(stats.changedFraction, 0.667);
  assert.equal(stats.medianChange, 1);
});

test('change statistics are null when nothing overlaps', () => {
  const none = { values: new Int8Array(64), filled: new Uint8Array(1) };
  const { grid, stats } = computeChange(none, none, 0.3);
  assert.equal(grid[0], ALPHA_EARTH_GRID_NODATA);
  assert.equal(stats.meanChange, null);
  assert.equal(stats.validFraction, 0);
});
