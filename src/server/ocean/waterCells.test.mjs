import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  classifyWaterCells,
  classifyWaterCellsFromBundle,
  waterCoverage,
  blankLandCells,
} from './waterCells.js';
import { packMaskStates, MASK_WATER, MASK_LAND, MASK_COASTAL } from '../../data/landSeaMaskCodec.js';

// A tiny 8x4 mask (45 deg cells) keeps the fixture readable; maskStateAt maps
// lat/lon onto it exactly as it does the production 2880x1440 grid.
const W = 8;
const H = 4;

/** Build a mask whose cells are chosen by a (row, col) -> state callback. */
function mask(stateAt) {
  const states = new Uint8Array(W * H);
  for (let row = 0; row < H; row += 1) {
    for (let col = 0; col < W; col += 1) states[row * W + col] = stateAt(row, col);
  }
  return { width: W, height: H, data: packMaskStates(states, W, H) };
}

const ALL_WATER = mask(() => MASK_WATER);

test('classifyWaterCells marks every cell eligible over open water', () => {
  const grid = { lat0: -10, lon0: -10, dLat: 5, dLon: 5, nLat: 3, nLon: 3 };
  const water = classifyWaterCells(grid, ALL_WATER);
  assert.equal(water.eligibleCount, 9);
  assert.equal(water.landCount, 0);
  assert.ok(water.eligible.every((flag) => flag === 1));
});

test('classifyWaterCells excludes land and keeps coastal cells eligible', () => {
  // Row 2 of the mask covers lat [0, 45); make its western half land and the
  // cell at col 4 coastal. Coastal is partly wet and HF radar reports there.
  const m = mask((row, col) => {
    if (row !== 2) return MASK_WATER;
    if (col === 4) return MASK_COASTAL;
    return col < 4 ? MASK_LAND : MASK_WATER;
  });
  // Sample lat 10 (row 2) across longitudes spanning both halves.
  const grid = { lat0: 10, lon0: -180, dLat: 5, dLon: 45, nLat: 1, nLon: 8 };
  const water = classifyWaterCells(grid, m);
  // cols 0-3 are land, col 4 is coastal (eligible), cols 5-7 water.
  assert.deepEqual(Array.from(water.eligible), [0, 0, 0, 0, 1, 1, 1, 1]);
  assert.equal(water.eligibleCount, 4);
  assert.equal(water.landCount, 4);
});

test('classifyWaterCells wraps longitudes past +180 for an antimeridian box', () => {
  // lon0 = 170 with dLon = 10 walks 170, 180, 190. Column 0 of the mask is the
  // 45 deg band starting at -180, so both 180 (the same meridian as -180) and
  // 190 (which wraps to -170) belong to it. Only 170 stays in column 7.
  const m = mask((_row, col) => (col === 0 ? MASK_LAND : MASK_WATER));
  const grid = { lat0: 0, lon0: 170, dLat: 5, dLon: 10, nLat: 1, nLon: 3 };
  const water = classifyWaterCells(grid, m);
  assert.deepEqual(Array.from(water.eligible), [1, 0, 0]);
  // Without the wrap, lon 190 would index past the last column and read
  // whatever the codec returns for an out-of-range cell.
  assert.equal(water.landCount, 2);
});

test('waterCoverage measures finite cells against water cells, not all cells', () => {
  // Half the lattice is land; the analysis covers every water cell.
  const water = { eligible: Uint8Array.from([0, 0, 1, 1]), eligibleCount: 2 };
  const u = [null, null, 0.2, 0.3];
  const result = waterCoverage(u, water);
  assert.equal(result.coverage, 1);
  assert.equal(result.waterRelative, true);
  assert.equal(result.eligibleCount, 2);
  // Whole-lattice accounting would have called this 50% and demoted the tier.
  assert.equal(u.filter((value) => value != null).length / u.length, 0.5);
});

test('waterCoverage ignores data that sits on land', () => {
  // Barnes can extrapolate inland; those cells must not inflate coverage.
  const water = { eligible: Uint8Array.from([0, 0, 1, 0]), eligibleCount: 1 };
  assert.equal(waterCoverage([0.9, 0.9, 0.1, 0.9], water).coverage, 1);
  assert.equal(waterCoverage([0.9, 0.9, null, 0.9], water).coverage, 0);
});

test('waterCoverage falls back to whole-lattice coverage and says so', () => {
  const result = waterCoverage([1, null, 1, null], null);
  assert.equal(result.coverage, 0.5);
  assert.equal(result.waterRelative, false);
  // A zero-water classification is the same situation: nothing to divide by.
  const empty = waterCoverage([1, null], { eligible: Uint8Array.from([0, 0]), eligibleCount: 0 });
  assert.equal(empty.waterRelative, false);
});

test('blankLandCells nulls land data in both components and counts it', () => {
  const water = { eligible: Uint8Array.from([1, 0, 0, 1]) };
  const u = [0.1, 0.2, null, 0.4];
  const v = [-0.1, -0.2, null, -0.4];
  assert.equal(blankLandCells(u, v, water), 1);
  assert.deepEqual(u, [0.1, null, null, 0.4]);
  assert.deepEqual(v, [-0.1, null, null, -0.4]);
  // No classification means no blanking — never guess.
  const untouched = [1, 2];
  assert.equal(blankLandCells(untouched, [1, 2], null), 0);
  assert.deepEqual(untouched, [1, 2]);
});

test('classifyWaterCellsFromBundle returns null rather than guessing when the mask fails', async () => {
  const grid = { lat0: 0, lon0: 0, dLat: 1, dLon: 1, nLat: 2, nLon: 2 };
  assert.equal(await classifyWaterCellsFromBundle(grid, { loadMask: async () => { throw new Error('nope'); } }), null);
  assert.equal(await classifyWaterCellsFromBundle(grid, { loadMask: async () => null }), null);
  assert.equal(await classifyWaterCellsFromBundle(grid, { loadMask: async () => ({ width: 0, height: 0, data: null }) }), null);
});

test('classifyWaterCellsFromBundle classifies against the real bundled GSHHG mask', async () => {
  // Open Pacific ~1000 km west of California: all water. Land would mean the
  // mask asset, its codec, or the lat/lon convention regressed.
  const pacific = await classifyWaterCellsFromBundle(
    { lat0: 35, lon0: -140, dLat: 0.5, dLon: 0.5, nLat: 4, nLon: 4 },
  );
  assert.ok(pacific, 'bundled mask must load under node');
  assert.equal(pacific.landCount, 0);

  // Central Nevada: all land.
  const nevada = await classifyWaterCellsFromBundle(
    { lat0: 39, lon0: -117, dLat: 0.25, dLon: 0.25, nLat: 4, nLon: 4 },
  );
  assert.equal(nevada.eligibleCount, 0);

  // A Monterey Bay box straddles both — the case that motivated this module.
  const monterey = await classifyWaterCellsFromBundle(
    { lat0: 36.3, lon0: -122.5, dLat: 0.02, dLon: 0.02, nLat: 50, nLon: 50 },
  );
  assert.ok(monterey.eligibleCount > 0 && monterey.landCount > 0,
    `expected a mixed coastal box, got ${monterey.eligibleCount} water / ${monterey.landCount} land`);
});
