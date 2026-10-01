import test from 'node:test';
import assert from 'node:assert/strict';
import {
  coefficientsFor,
  decimalYear,
  fieldSpherical,
  fieldCartesian,
  IGRF_EPOCH,
  IGRF_REFERENCE_RADIUS_KM,
  IGRF_VALID_UNTIL,
} from './field.js';
import fixture from './igrf-reference.fixture.json' with { type: 'json' };

test('matches an independent IGRF implementation across the globe and out to 3 Re', () => {
  // The fixture comes from the MIT-licensed Python `geopack` translation of
  // the IAGA synthesis — a different codebase by a different author. Agreeing
  // with ourselves proves nothing here; a spherical-harmonic field that is
  // wrong still looks like a field.
  const coefficients = coefficientsFor(fixture.decimalYear);
  let worst = 0;
  for (const point of fixture.points) {
    const { br, btheta, bphi } = fieldSpherical(
      coefficients,
      point.r * IGRF_REFERENCE_RADIUS_KM,
      ((90 - point.lat) * Math.PI) / 180,
      (point.lon * Math.PI) / 180,
    );
    const magnitude = Math.hypot(point.br, point.btheta, point.bphi);
    for (const [mine, reference] of [
      [br, point.br],
      [btheta, point.btheta],
      [bphi, point.bphi],
    ]) {
      worst = Math.max(worst, Math.abs(mine - reference) / magnitude);
    }
  }
  assert.ok(
    worst < 1e-5,
    `worst component error ${(worst * 100).toFixed(5)}% of |B| exceeds 0.001%`,
  );
});

test('Schmidt semi-normalisation is seeded at P(1,1) = sin, not scaled', () => {
  // The sectoral factor sqrt((2n-1)/2n) must not be applied at n = 1. Getting
  // this wrong leaves every sectoral term short by sqrt(2) and produced a
  // field that was self-consistent, smooth, and ~10% wrong at the equator.
  // Degree-1-only coefficients make the closed form checkable by hand.
  const dipole = { g: [], h: [] };
  for (let n = 0; n <= 13; n++) {
    dipole.g[n] = new Float64Array(14);
    dipole.h[n] = new Float64Array(14);
  }
  dipole.g[1][1] = 1000; // a purely equatorial dipole term
  const theta = Math.PI / 2;
  const { br } = fieldSpherical(dipole, IGRF_REFERENCE_RADIUS_KM, theta, 0);
  // Br = (n+1)(a/r)^(n+2) g11 cos(0) P11(90 deg) = 2 * 1 * 1000 * 1
  assert.ok(
    Math.abs(br - 2000) < 1e-9,
    `P(1,1) is mis-normalised: Br = ${br}, expected 2000`,
  );
});

test('secular variation moves the field and reports when it outruns the model', () => {
  const atEpoch = coefficientsFor(IGRF_EPOCH);
  const later = coefficientsFor(IGRF_EPOCH + 3);
  assert.notEqual(atEpoch.g[1][0], later.g[1][0], 'g(1,0) should drift');
  assert.equal(atEpoch.extrapolatedBeyondModel, false);
  assert.equal(coefficientsFor(IGRF_VALID_UNTIL).extrapolatedBeyondModel, false);
  assert.equal(
    coefficientsFor(IGRF_VALID_UNTIL + 0.5).extrapolatedBeyondModel,
    true,
    'past the published SV span the layer must be able to say so',
  );
});

test('cartesian field agrees with the spherical components it is built from', () => {
  const coefficients = coefficientsFor(2026.5);
  const r = 2 * IGRF_REFERENCE_RADIUS_KM;
  const theta = (55 * Math.PI) / 180;
  const phi = (-120 * Math.PI) / 180;
  const spherical = fieldSpherical(coefficients, r, theta, phi);
  const cartesian = fieldCartesian(coefficients, {
    x: r * Math.sin(theta) * Math.cos(phi),
    y: r * Math.sin(theta) * Math.sin(phi),
    z: r * Math.cos(theta),
  });
  assert.ok(
    Math.abs(
      Math.hypot(cartesian.x, cartesian.y, cartesian.z) -
        Math.hypot(spherical.br, spherical.btheta, spherical.bphi),
    ) < 1e-6,
    'magnitude must be frame-independent',
  );
});

test('the geocentre is refused rather than returning a silent infinity', () => {
  const coefficients = coefficientsFor(2026);
  assert.throws(
    () => fieldCartesian(coefficients, { x: 0, y: 0, z: 0 }),
    /geocentre/,
  );
});

test('decimalYear places a mid-year date sensibly', () => {
  const y = decimalYear(new Date(Date.UTC(2026, 6, 2, 12)));
  assert.ok(y > 2026.49 && y < 2026.51, `got ${y}`);
});
