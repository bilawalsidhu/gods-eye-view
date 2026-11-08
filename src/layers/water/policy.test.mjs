import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_PARAMS,
  EXTENT_HALF_LAT_DEG,
  EXTENT_HALF_LON_DEG,
  HIDDEN_CAMERA_TOO_HIGH,
  HIDDEN_NO_VIEW,
  MAX_CAMERA_HEIGHT_M,
  PARAM_LIMITS,
  REBUILD_DISTANCE_KM,
  WAVE_CELL_DEG,
  WAVE_REPEAT,
  distanceKm,
  hiddenReason,
  needsRebuild,
  normalizeWaterParams,
  offsetParamsForSlider,
  offsetSliderPosition,
  snapExtent,
  surfaceHeightM,
} from './policy.js';

test('the wave texture repeats a whole number of cells across the rectangle', () => {
  assert.equal(Number.isInteger(WAVE_REPEAT.s), true);
  assert.equal(Number.isInteger(WAVE_REPEAT.t), true);
  assert.ok(
    Math.abs(WAVE_REPEAT.s * WAVE_CELL_DEG - 2 * EXTENT_HALF_LON_DEG) < 1e-9,
  );
  assert.ok(
    Math.abs(WAVE_REPEAT.t * WAVE_CELL_DEG - 2 * EXTENT_HALF_LAT_DEG) < 1e-9,
  );
});

test('snapExtent centres a grid-aligned rectangle on the view', () => {
  const extent = snapExtent(37.8, -122.45);
  assert.ok(extent);
  assert.ok(extent.west <= -122.45 - EXTENT_HALF_LON_DEG);
  assert.ok(extent.west > -122.45 - EXTENT_HALF_LON_DEG - WAVE_CELL_DEG);
  assert.ok(Math.abs(extent.east - extent.west - 2 * EXTENT_HALF_LON_DEG) < 1e-9);
  assert.ok(Math.abs(extent.north - extent.south - 2 * EXTENT_HALF_LAT_DEG) < 1e-9);
  // Edges sit on the cell grid, so a rebuild keeps the pattern in place.
  const cells = extent.west / WAVE_CELL_DEG;
  assert.ok(Math.abs(cells - Math.round(cells)) < 1e-6);
});

test('two rectangles around nearby centres share the same texture grid', () => {
  const a = snapExtent(37.8, -122.45);
  const b = snapExtent(37.81, -122.3);
  const cellsApart = (b.west - a.west) / WAVE_CELL_DEG;
  assert.ok(Math.abs(cellsApart - Math.round(cellsApart)) < 1e-6);
});

test('snapExtent clips at the antimeridian and the poles, and refuses bad input', () => {
  const east = snapExtent(0, 179.9);
  assert.equal(east.east, 180);
  assert.ok(east.west < 180);
  const polar = snapExtent(84.9, 10);
  assert.equal(polar.north, 85);
  assert.equal(snapExtent(Number.NaN, 10), null);
  assert.equal(snapExtent(10, undefined), null);
});

test('surfaceHeightM is geoid undulation plus the offset, with safe fallbacks', () => {
  assert.equal(surfaceHeightM(-32.4, 1.2), -31.2);
  assert.equal(surfaceHeightM(Number.NaN, 2), 2);
  assert.equal(surfaceHeightM(-32.4, undefined), -32.4 + DEFAULT_PARAMS.offsetM);
});

test('normalizeWaterParams clamps and ignores unknown or non-finite values', () => {
  const next = normalizeWaterParams(
    { offsetM: 99, opacity: 'abc', waveScale: 0.5, bogus: 1 },
    DEFAULT_PARAMS,
  );
  assert.equal(next.offsetM, PARAM_LIMITS.offsetM[1]);
  assert.equal(next.opacity, DEFAULT_PARAMS.opacity);
  assert.equal(next.waveScale, 0.5);
  assert.equal(Object.hasOwn(next, 'bogus'), false);
  assert.deepEqual(normalizeWaterParams(undefined), { ...DEFAULT_PARAMS });
  assert.equal(normalizeWaterParams({ offsetM: -3 }).offsetM, 0);
});

test('needsRebuild triggers only past the rebuild distance', () => {
  const center = { lat: 37.8, lon: -122.45 };
  assert.equal(needsRebuild(null, center), true);
  assert.equal(needsRebuild(center, { lat: 37.81, lon: -122.44 }), false);
  const far = { lat: 37.8 + (REBUILD_DISTANCE_KM + 1) / 111, lon: -122.45 };
  assert.equal(needsRebuild(center, far), true);
  assert.ok(Math.abs(distanceKm(center, far) - (REBUILD_DISTANCE_KM + 1)) < 0.2);
});

test('hiddenReason hides the surface from orbit and without a view', () => {
  assert.equal(hiddenReason(500), null);
  assert.equal(hiddenReason(MAX_CAMERA_HEIGHT_M), null);
  assert.equal(hiddenReason(MAX_CAMERA_HEIGHT_M + 1), HIDDEN_CAMERA_TOO_HIGH);
  assert.equal(hiddenReason(undefined), HIDDEN_NO_VIEW);
});

test('the offset slider maps tenths of a metre both ways', () => {
  assert.equal(offsetSliderPosition(1.2), 12);
  assert.equal(offsetSliderPosition(99), PARAM_LIMITS.offsetM[1] * 10);
  assert.deepEqual(offsetParamsForSlider('7'), { offsetM: 0.7 });
});
