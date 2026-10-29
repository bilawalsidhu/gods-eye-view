import test from 'node:test';
import assert from 'node:assert/strict';
import {
  HEAT_PALETTE,
  heatColorAt,
  binFires,
  blurGaussian,
  buildHeatRaster,
} from './firmsHeatRaster.js';

const fire = (lat, lon, frp = 10) => ({ lat, lon, frp });

test('palette runs cold to hot and starts fully transparent', () => {
  assert.equal(HEAT_PALETTE[0].at, 0);
  assert.equal(HEAT_PALETTE.at(-1).at, 1);
  assert.deepEqual(heatColorAt(0), [0, 0, 0, 0]);
  assert.equal(heatColorAt(0.01)[3], 0, 'below the floor nothing is painted');
  const low = heatColorAt(0.15);
  const high = heatColorAt(1);
  assert.ok(low[2] > low[0], 'low heat is blue');
  assert.ok(high[0] > high[2], 'the core is red');
  assert.ok(high[3] > low[3], 'hotter is more opaque');
});

test('binFires drops each detection into its equirectangular pixel', () => {
  const grid = binFires([fire(89.9, -179.9, 0), fire(-89.9, 179.9, 0)], {
    width: 4,
    height: 2,
  });
  assert.equal(grid[0], 1, 'north-west corner');
  assert.equal(grid[7], 1, 'south-east corner');
  assert.equal(
    grid.reduce((a, b) => a + b, 0),
    2,
  );
});

test('binFires weights strong fires slightly more', () => {
  const grid = binFires([fire(0.1, 0.1, 999)], { width: 4, height: 2 });
  assert.ok(grid[2] > 3 && grid[2] < 5, String(grid[2]));
});

test('blurGaussian keeps mass and wraps across the antimeridian', () => {
  const w = 16;
  const h = 8;
  const grid = new Float32Array(w * h);
  grid[3 * w + 0] = 1;
  const out = blurGaussian(grid, w, h, 1.5);
  const sum = out.reduce((a, b) => a + b, 0);
  assert.ok(Math.abs(sum - 1) < 1e-3, `mass ${sum}`);
  assert.ok(out[3 * w + (w - 1)] > 0, 'spills to the east edge');
});

test('buildHeatRaster is transparent where there are no fires', () => {
  const r = buildHeatRaster([fire(40, -120), fire(40.1, -120.1)], {
    width: 360,
    height: 180,
    sigmaPx: 2,
  });
  assert.equal(r.rgba.length, 360 * 180 * 4);
  const alphaAt = (lat, lon) => {
    const x = Math.floor(((lon + 180) / 360) * 360);
    const y = Math.floor(((90 - lat) / 180) * 180);
    return r.rgba[(y * 360 + x) * 4 + 3];
  };
  assert.ok(alphaAt(40, -120) > 0, 'blob over the fires');
  assert.equal(alphaAt(-30, 60), 0, 'empty far away');
});

test('buildHeatRaster with no fires is fully transparent', () => {
  const r = buildHeatRaster([], { width: 8, height: 4, sigmaPx: 1 });
  assert.ok(r.rgba.every((v) => v === 0));
});
