import test from 'node:test';
import assert from 'node:assert/strict';
import {
  HEAT_MIN_WEIGHT_MW,
  HEAT_PALETTE,
  heatColorAt,
  binFires,
  blurGaussian,
  buildHeatRaster,
  heatGridForSpotSize,
  normalizeHeatSpotSize,
  sliderPositionForSpotSize,
  spotSizeForSliderPosition,
} from './firmsHeatRaster.js';

const fire = (lat, lon, frp = 10) => ({ lat, lon, frp });

test('palette runs ember to white-hot and starts fully transparent', () => {
  assert.equal(HEAT_PALETTE[0].at, 0);
  assert.equal(HEAT_PALETTE.at(-1).at, 1);
  assert.deepEqual(heatColorAt(0), [0, 0, 0, 0]);
  assert.equal(heatColorAt(0.01)[3], 0, 'below the floor nothing is painted');
  const low = heatColorAt(0.15);
  const high = heatColorAt(1);
  assert.ok(low[0] > low[1] && low[1] > low[2], 'low heat is red');
  assert.ok(low[3] >= 0.5 * 255, 'low heat stays visible on any imagery');
  assert.ok(high[1] > low[1] && high[2] > low[2], 'the core is paler');
  assert.ok(high[3] > low[3], 'hotter is more opaque');
  for (let i = 1; i <= 100; i++) {
    const [r, , b] = heatColorAt(i / 100);
    assert.ok(r >= b, `no cold hue at ${i}%`);
  }
});

test('binFires puts a detection at a pixel centre wholly in that pixel', () => {
  // 4×2 grid: pixel centres at lon −135/−45/45/135, lat ±45.
  const grid = binFires([fire(45, -135, 1), fire(-45, 135, 1)], {
    width: 4,
    height: 2,
  });
  assert.equal(grid[0], 1, 'north-west pixel');
  assert.equal(grid[7], 1, 'south-east pixel');
  assert.equal(
    grid.reduce((a, b) => a + b, 0),
    2,
  );
});

test('binFires shares a detection between the pixels around it', () => {
  const between = binFires([fire(45, 0, 1)], { width: 4, height: 2 });
  assert.equal(between[1], 0.5, 'half to the pixel west of it');
  assert.equal(between[2], 0.5, 'half to the pixel east of it');
  const quarter = binFires([fire(45, -112.5, 1)], { width: 4, height: 2 });
  assert.equal(quarter[0], 0.75, 'closer centre takes more');
  assert.equal(quarter[1], 0.25);
  const wrapped = binFires([fire(45, 180, 1)], { width: 4, height: 2 });
  assert.equal(wrapped[3], 0.5, 'the antimeridian wraps');
  assert.equal(wrapped[0], 0.5);
  const polar = binFires([fire(90, -135, 1)], { width: 4, height: 2 });
  assert.equal(polar[0], 1, 'beyond the last row folds back onto it');
});

test('binFires weights each detection by its radiative power', () => {
  const grid = binFires(
    [fire(45, 45, 250), fire(45, 45, 0), fire(45, 45, Number.NaN)],
    { width: 4, height: 2 },
  );
  assert.equal(grid[2], 250 + 2 * HEAT_MIN_WEIGHT_MW);
});

test('filtering out weak fires keeps a strong fire hot', () => {
  const strong = fire(0.1, 0.1, 300);
  const weak = Array.from({ length: 40 }, () => fire(0.1, 0.1, 2));
  const reference = Array.from({ length: 10 }, () => fire(20.1, 20.1, 100));
  const options = { width: 360, height: 180, sigmaPx: 2 };
  const pixel = ((90 - 0.1) | 0) * 360 + ((0.1 + 180) | 0);
  const red = (r) => r.rgba[pixel * 4];
  const alpha = (r) => r.rgba[pixel * 4 + 3];
  const unfiltered = buildHeatRaster([strong, ...weak, ...reference], options);
  const filtered = buildHeatRaster([strong, ...reference], options);
  assert.ok(alpha(filtered) > 0);
  assert.ok(
    alpha(filtered) >= alpha(unfiltered) * 0.9,
    `alpha ${alpha(unfiltered)} -> ${alpha(filtered)}`,
  );
  assert.ok(
    red(filtered) >= red(unfiltered) * 0.9,
    `red ${red(unfiltered)} -> ${red(filtered)}`,
  );
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

test('a spot size scales the grid, not the blur', () => {
  const base = { width: 2048, height: 1024, sigmaPx: 1 };
  assert.deepEqual(heatGridForSpotSize(base, 100), base);
  assert.deepEqual(heatGridForSpotSize(base, 200), {
    width: 1024,
    height: 512,
    sigmaPx: 1,
  });
  assert.deepEqual(heatGridForSpotSize(base, 50), {
    width: 4096,
    height: 2048,
    sigmaPx: 1,
  });
  const odd = heatGridForSpotSize(base, 150);
  assert.equal(odd.width, odd.height * 2, 'the grid stays 2:1');
  assert.deepEqual(heatGridForSpotSize(base, 9999), base, 'invalid → default');
});

test('twice the spot size paints a lone fire twice as wide', () => {
  const base = { width: 2048, height: 1024, sigmaPx: 1 };
  const fires = [fire(0, 0, 5)];
  for (let i = 0; i < 40; i++) fires.push(fire(-10, 25 + i * 0.05, 300));
  const widthKm = (spotSize) => {
    const r = buildHeatRaster(fires, heatGridForSpotSize(base, spotSize));
    const y = Math.floor(r.height / 2);
    let painted = 0;
    for (let x = 0; x < r.width; x++) {
      const lon = ((x + 0.5) / r.width) * 360 - 180;
      if (Math.abs(lon) < 10 && r.rgba[(y * r.width + x) * 4 + 3] > 0) {
        painted += 1;
      }
    }
    return (painted * 40075) / r.width;
  };
  const ratio = widthKm(200) / widthKm(100);
  assert.ok(ratio > 1.7 && ratio < 2.3, `ratio ${ratio.toFixed(2)}`);
});

test('the spot-size slider is log2 with 1x a third along and 5 % steps', () => {
  assert.equal(sliderPositionForSpotSize(50), 0);
  assert.equal(sliderPositionForSpotSize(400), 1);
  assert.ok(Math.abs(sliderPositionForSpotSize(100) - 1 / 3) < 1e-9);
  assert.ok(Math.abs(sliderPositionForSpotSize(200) - 2 / 3) < 1e-9);
  assert.equal(spotSizeForSliderPosition(0), 50);
  assert.equal(spotSizeForSliderPosition(1), 400);
  assert.equal(spotSizeForSliderPosition(1 / 3), 100);
  assert.equal(spotSizeForSliderPosition(-1), 50);
  for (let i = 0; i <= 100; i++) {
    const percent = spotSizeForSliderPosition(i / 100);
    assert.equal(percent % 5, 0, `${percent} at ${i}%`);
    assert.equal(normalizeHeatSpotSize(percent), percent);
  }
  assert.equal(normalizeHeatSpotSize('150'), 150);
  assert.equal(normalizeHeatSpotSize(49), null);
  assert.equal(normalizeHeatSpotSize(''), null);
});
