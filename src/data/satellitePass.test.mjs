// src/data/satellitePass.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { twoline2satrec } from 'satellite.js';
import { findNextSatellitePass, lookAnglesAt } from './satellitePass.js';

// Canonical archived ISS TLE (epoch 2008-09-20 ~12:25 UTC).
const L1 =
  '1 25544U 98067A   08264.51782528 -.00002182  00000-0 -11606-4 0  2927';
const L2 =
  '2 25544  51.6416 247.4627 0006703 130.5360 325.0288 15.72125391563537';
const AUSTIN = { latDeg: 30.2672, lonDeg: -97.7431 };
const FROM_MS = Date.UTC(2008, 8, 20, 12, 30, 0);

test('findNextSatellitePass resolves pass boundaries with sub-second precision', () => {
  const satrec = twoline2satrec(L1, L2);
  const pass = findNextSatellitePass({
    satrec,
    ...AUSTIN,
    fromMs: FROM_MS,
    minElevDeg: 10,
  });
  assert.ok(pass, 'expected a pass within 24h at Austin for ISS');
  assert.ok(pass.riseMs > FROM_MS);
  assert.ok(pass.riseMs < pass.maxElevMs && pass.maxElevMs < pass.setMs);
  assert.ok(pass.maxElevDeg >= 10);
  assert.ok(pass.riseAzDeg >= 0 && pass.riseAzDeg < 360);

  // Verify bisection accuracy at rise time:
  const beforeRise = lookAnglesAt(
    satrec,
    pass.riseMs - 1000,
    AUSTIN.latDeg,
    AUSTIN.lonDeg,
  );
  const atRise = lookAnglesAt(
    satrec,
    pass.riseMs,
    AUSTIN.latDeg,
    AUSTIN.lonDeg,
  );
  const afterRise = lookAnglesAt(
    satrec,
    pass.riseMs + 1000,
    AUSTIN.latDeg,
    AUSTIN.lonDeg,
  );
  assert.ok(
    beforeRise && beforeRise.elevDeg < 10.05,
    'elevation before riseMs must be below threshold',
  );
  assert.ok(
    atRise && Math.abs(atRise.elevDeg - 10) < 0.2,
    'elevation at riseMs must be within 0.2° of 10°',
  );
  assert.ok(
    afterRise && afterRise.elevDeg > 9.95,
    'elevation after riseMs must be rising above threshold',
  );

  // Verify bisection accuracy at set time:
  const beforeSet = lookAnglesAt(
    satrec,
    pass.setMs - 1000,
    AUSTIN.latDeg,
    AUSTIN.lonDeg,
  );
  const atSet = lookAnglesAt(satrec, pass.setMs, AUSTIN.latDeg, AUSTIN.lonDeg);
  const afterSet = lookAnglesAt(
    satrec,
    pass.setMs + 1000,
    AUSTIN.latDeg,
    AUSTIN.lonDeg,
  );
  assert.ok(
    beforeSet && beforeSet.elevDeg > 9.95,
    'elevation before setMs must be above threshold',
  );
  assert.ok(
    atSet && Math.abs(atSet.elevDeg - 10) < 0.2,
    'elevation at setMs must be within 0.2° of 10°',
  );
  assert.ok(
    afterSet && afterSet.elevDeg < 10.05,
    'elevation after setMs must be below threshold',
  );

  // Parabolic culmination accuracy: max elevation must be peak
  assert.ok(pass.maxElevDeg >= atRise.elevDeg);
  assert.ok(pass.maxElevDeg >= atSet.elevDeg);
});

test('findNextSatellitePass samples the peak at fineStepSec', () => {
  const satrec = twoline2satrec(L1, L2);
  const opts = { satrec, ...AUSTIN, fromMs: FROM_MS, minElevDeg: 10 };
  const fine = findNextSatellitePass({ ...opts, fineStepSec: 1 });
  const coarse = findNextSatellitePass({ ...opts, fineStepSec: 10 });
  assert.ok(fine && coarse);
  // The step is used: peak samples differ.
  assert.notEqual(fine.maxElevMs, coarse.maxElevMs);
  // Rise comes from bisection, so it does not depend on the step.
  assert.ok(Math.abs(fine.riseMs - coarse.riseMs) < 1000);
  // Parabolic refinement keeps 10s sampling close to the 1s peak.
  assert.ok(Math.abs(fine.maxElevMs - coarse.maxElevMs) < 1000);
  assert.ok(Math.abs(fine.maxElevDeg - coarse.maxElevDeg) < 0.01);
});
