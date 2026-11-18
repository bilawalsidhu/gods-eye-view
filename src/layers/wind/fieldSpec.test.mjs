import test from 'node:test';
import assert from 'node:assert/strict';
import {
  WIND_FIELD_SPEC,
  OCEAN_FIELD_SPEC,
  createFieldSpec,
  fieldSpeedScale,
  fieldStepCap,
  isGlobeField,
  fieldSeedBudget,
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
  assert.equal(WIND_FIELD_SPEC.globeSeedScale, 1);
  assert.equal(WIND_FIELD_SPEC.boxLineCoverage, null);
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
  assert.equal(OCEAN_FIELD_SPEC.globeSeedScale, 2);
  assert.equal(OCEAN_FIELD_SPEC.boxLineCoverage, 77);
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
  assert.equal(
    fieldSpeedScale(OCEAN_FIELD_SPEC, { speed: { medianMs: NaN } }),
    1,
  );
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

test('a field is the globe when it has no bbox or its bbox wraps every longitude', () => {
  assert.equal(isGlobeField({ bbox: null }), true);
  assert.equal(isGlobeField({}), true);
  assert.equal(
    isGlobeField({
      bbox: { latMin: -90, latMax: 90, lonMin: -180, lonMax: 180 },
    }),
    true,
  );
  assert.equal(
    isGlobeField({ bbox: { latMin: -60, latMax: 60, lonMin: 0, lonMax: 360 } }),
    true,
  );
  assert.equal(
    isGlobeField({
      bbox: { latMin: 30, latMax: 39, lonMin: -75, lonMax: -66 },
    }),
    false,
  );
  assert.equal(
    isGlobeField({
      bbox: { latMin: 30, latMax: 39, lonMin: 170, lonMax: -170 },
    }),
    false,
  );
});

test('seed budget: globe scales the base budget, boxes hold a line coverage', () => {
  const globe = {
    nx: 360,
    ny: 181,
    dx: 1,
    dy: 1,
    bbox: { latMin: -90, latMax: 90, lonMin: -180, lonMax: 180 },
    speed: { validCells: 39810, totalCells: 65160 },
  };
  assert.equal(fieldSeedBudget(WIND_FIELD_SPEC, globe, 7200), 7200);
  assert.equal(fieldSeedBudget(OCEAN_FIELD_SPEC, globe, 7200), 14400);
  // A 24 deg box on a 0.25 deg grid: the step cap (span/64 = 0.375) does not
  // bind, so the median path is 32 x 0.0946 deg long and the budget is
  // coverage x span / length / validRatio.
  const box = {
    nx: 96,
    ny: 80,
    dx: 0.25,
    dy: 0.25,
    bbox: { latMin: 25, latMax: 45, lonMin: -82, lonMax: -58 },
    speed: { validCells: 5000, totalCells: 7680 },
  };
  const spec = createFieldSpec({ boxLineCoverage: 77 });
  const pathDeg = 32 * ((5.836 * 1800) / 111195);
  const expected = Math.round((77 * 24) / pathDeg / (5000 / 7680));
  assert.equal(fieldSeedBudget(spec, box, 7200), expected);
  assert.ok(expected > 900 && expected < 1000, String(expected));
  // Every cell valid: no survival correction.
  assert.equal(
    fieldSeedBudget(
      spec,
      { ...box, speed: { validCells: 10, totalCells: 10 } },
      7200,
    ),
    Math.round((77 * 24) / pathDeg),
  );
  // A coastal box where span/64 binds the step: shorter paths, more seeds.
  const coast = {
    nx: 81,
    ny: 101,
    dx: 0.01875,
    dy: 0.015,
    bbox: { latMin: 36, latMax: 37.5, lonMin: -123, lonMax: -121.5 },
    speed: { validCells: 5095, totalCells: 8181 },
  };
  const coastPath =
    32 * Math.min(0.75, Math.max(81 * 0.01875, 100 * 0.015) / 64);
  assert.equal(
    fieldSeedBudget(spec, coast, 7200),
    Math.round((77 * 1.5) / coastPath / (5095 / 8181)),
  );
  // Clamps: never below 100 seeds, never above the base budget; a spec
  // without a coverage keeps the base budget for boxes.
  assert.equal(
    fieldSeedBudget(createFieldSpec({ boxLineCoverage: 0.01 }), box, 7200),
    100,
  );
  assert.equal(
    fieldSeedBudget(createFieldSpec({ boxLineCoverage: 1e6 }), box, 7200),
    7200,
  );
  assert.equal(fieldSeedBudget(WIND_FIELD_SPEC, box, 7200), 7200);
  // Antimeridian boxes measure their span the short way round.
  const seam = {
    ...box,
    bbox: { latMin: 25, latMax: 45, lonMin: 170, lonMax: -166 },
  };
  assert.equal(
    fieldSeedBudget(spec, seam, 7200),
    fieldSeedBudget(spec, box, 7200),
  );
});
