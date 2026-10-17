import test from 'node:test';
import assert from 'node:assert/strict';
import {
  WIND_FIELD_SPEC,
  OCEAN_FIELD_SPEC,
  createFieldSpec,
  fieldSpeedScale,
  fieldStepCap,
  fieldRampMax,
  rampColor,
  rampStopVectors,
} from './fieldSpec.js';

const wind = { nx: 360, ny: 181, lo1: 0, la1: 90, dx: 1, dy: 1 };

test('WIND_FIELD_SPEC pins the constants the wind renderer shipped with', () => {
  assert.equal(WIND_FIELD_SPEC.calmCutoffMs, 0.15);
  // Median 10 m GFS speed, 2026-10-16 12Z f010, 360x181 at targetDx 1,
  // through server/providers/wind/gfs.js + decode.js (65160 cells).
  assert.equal(WIND_FIELD_SPEC.targetMedianMs, 5.836);
  assert.equal(WIND_FIELD_SPEC.rampGamma, 1);
  assert.deepEqual(WIND_FIELD_SPEC.ramp, [
    '#ffffff',
    '#ffffff',
    '#ffffff',
    '#ffffff',
    '#ffffff',
  ]);
  assert.equal(fieldRampMax(WIND_FIELD_SPEC, wind), 30);
  assert.equal(fieldSpeedScale(WIND_FIELD_SPEC, wind), 1);
  assert.equal(fieldStepCap(wind), 0.75);
  assert.equal(Object.isFrozen(WIND_FIELD_SPEC), true);
});

test('OCEAN_FIELD_SPEC derives its ramp max from the manifest and keeps the old ramp', () => {
  assert.equal(OCEAN_FIELD_SPEC.calmCutoffMs, 0.02);
  assert.equal(OCEAN_FIELD_SPEC.rampGamma, 0.55);
  assert.deepEqual(OCEAN_FIELD_SPEC.ramp, [
    '#267c92',
    '#2e9ea8',
    '#60c496',
    '#bed664',
    '#ffc950',
  ]);
  assert.equal(
    fieldRampMax(OCEAN_FIELD_SPEC, { speed: { p95Ms: 0.553 } }),
    1.25 * 0.553,
  );
  assert.equal(fieldRampMax(OCEAN_FIELD_SPEC, { speed: { p95Ms: 0.01 } }), 0.2);
  assert.equal(fieldRampMax(OCEAN_FIELD_SPEC, {}), 0.2);
});

test('speed scale (E1) is targetMedian / fieldMedian and floors the median', () => {
  assert.equal(
    fieldSpeedScale(OCEAN_FIELD_SPEC, { speed: { medianMs: 0.128 } }),
    5.836 / 0.128,
  );
  assert.equal(
    fieldSpeedScale(OCEAN_FIELD_SPEC, { speed: { medianMs: 0 } }),
    5.836 / 1e-3,
  );
  assert.equal(fieldSpeedScale(OCEAN_FIELD_SPEC, { speed: { medianMs: NaN } }), 1);
  assert.equal(fieldSpeedScale(OCEAN_FIELD_SPEC, {}), 1);
  assert.equal(
    fieldSpeedScale(createFieldSpec({ targetMedianMs: 2 }), {
      speed: { medianMs: 4 },
    }),
    0.5,
  );
});

test('step cap is 0.75 deg for global grids and span/64 for regional ones', () => {
  assert.equal(fieldStepCap({ nx: 360, ny: 181, dx: 1, dy: 1 }), 0.75);
  assert.equal(fieldStepCap({ nx: 90, ny: 90, dx: 0.3, dy: 0.3 }), 27 / 64);
  assert.equal(
    fieldStepCap({ nx: 64, ny: 64, dx: 0.015625, dy: 0.015625 }),
    1 / 64,
  );
});

test('ramp mirror interpolates the five stops in order', () => {
  const stops = OCEAN_FIELD_SPEC.ramp;
  assert.deepEqual(rampColor(stops, 0), [38, 124, 146]);
  assert.deepEqual(rampColor(stops, 1), [255, 201, 80]);
  assert.deepEqual(rampColor(stops, 0.5), [96, 196, 150]);
  assert.deepEqual(rampColor(stops, 0.125), [42, 141, 157]);
  assert.deepEqual(rampColor(stops, -1), rampColor(stops, 0));
  assert.deepEqual(rampColor(stops, 2), rampColor(stops, 1));
  const vectors = rampStopVectors(WIND_FIELD_SPEC.ramp);
  assert.equal(vectors.length, 5);
  assert.deepEqual(vectors[0], [1, 1, 1]);
  assert.deepEqual(rampStopVectors(stops)[4], [1, 201 / 255, 80 / 255]);
});
