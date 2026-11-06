import test from 'node:test';
import assert from 'node:assert/strict';
import { coefficientsFor, decimalYear } from './field.js';
import {
  dipoleAxis,
  dipoleTilt,
  externalFieldFor,
  fromGsm,
  geomagneticNorthPole,
  gsmBasis,
  toGsm,
} from './gsm.js';
import { EARTH_RADIUS_KM } from './trace.js';
import { t89 } from './t89.js';

// Sun directions taken from the Python geopack reference at these instants,
// alongside the dipole tilt it computed for each.
const REFERENCE = [
  ['2026-10-01T15:45:00Z', 0.0961262991353856, [0.516355925, -0.854364637, -0.058631276]],
  ['2026-03-21T00:00:00Z', -0.03954336366437841, [-0.999487851, -0.031888072, 0.002680779]],
  ['2026-06-21T12:00:00Z', 0.44964487535557585, [0.917479841, 0.007286028, 0.397715545]],
  ['2026-12-21T06:00:00Z', -0.5602146244161963, [0.008279983, 0.917481883, -0.397691383]],
];

test('the dipole axis puts the geomagnetic north pole where it is published', () => {
  // Near 80.8N, 72.7W for IGRF-14. This also pins the sign of the moment
  // vector: drop the leading minus and the pole lands at its antipode, which
  // flips the entire magnetosphere front-to-back without looking wrong.
  const pole = geomagneticNorthPole(coefficientsFor(2026.75));
  assert.ok(Math.abs(pole.latitudeDeg - 80.8) < 0.5, `lat ${pole.latitudeDeg}`);
  assert.ok(Math.abs(pole.longitudeDeg + 72.7) < 1.0, `lon ${pole.longitudeDeg}`);
  const axis = dipoleAxis(coefficientsFor(2026.75));
  assert.ok(axis.z > 0.9, 'the axis must point north');
});

test('dipole tilt matches the reference implementation through the year', () => {
  let worst = 0;
  for (const [iso, reference, sun] of REFERENCE) {
    const coefficients = coefficientsFor(decimalYear(new Date(iso)));
    const mine = dipoleTilt(coefficients, { x: sun[0], y: sun[1], z: sun[2] });
    worst = Math.max(worst, Math.abs(mine - reference));
  }
  // A thousandth of a degree. The residual is IGRF-13 vs -14, not geometry.
  assert.ok(worst < 1e-5, `worst tilt error ${worst} rad`);
});

test('tilt swings the way the seasons do', () => {
  const at = (iso, sun) =>
    dipoleTilt(coefficientsFor(decimalYear(new Date(iso))), {
      x: sun[0],
      y: sun[1],
      z: sun[2],
    });
  const june = at(REFERENCE[2][0], REFERENCE[2][2]);
  const december = at(REFERENCE[3][0], REFERENCE[3][2]);
  assert.ok(june > 0.3, 'northern summer leans the north pole sunward');
  assert.ok(december < -0.3, 'and away in northern winter');
});

test('the GSM frame is orthonormal and puts the dipole in the x-z plane', () => {
  const coefficients = coefficientsFor(2026.75);
  for (const [, , sun] of REFERENCE) {
    const basis = gsmBasis(coefficients, { x: sun[0], y: sun[1], z: sun[2] });
    const d = (a, b) => a.x * b.x + a.y * b.y + a.z * b.z;
    for (const axis of [basis.x, basis.y, basis.z])
      assert.ok(Math.abs(Math.hypot(axis.x, axis.y, axis.z) - 1) < 1e-12);
    for (const [a, b] of [[basis.x, basis.y], [basis.y, basis.z], [basis.z, basis.x]])
      assert.ok(Math.abs(d(a, b)) < 1e-12, 'axes must be perpendicular');
    // The defining property: the dipole has no GSM y-component.
    const dipoleInGsm = toGsm(basis, dipoleAxis(coefficients));
    assert.ok(Math.abs(dipoleInGsm.y) < 1e-12, `dipole y = ${dipoleInGsm.y}`);
    assert.ok(dipoleInGsm.z > 0, 'and a positive z by construction');
  }
});

test('GSM round-trips an arbitrary vector', () => {
  const basis = gsmBasis(coefficientsFor(2026.75), { x: 0.5, y: -0.8, z: -0.06 });
  const v = { x: 1234.5, y: -678.9, z: 42 };
  const back = fromGsm(basis, toGsm(basis, v));
  for (const k of ['x', 'y', 'z'])
    assert.ok(Math.abs(back[k] - v[k]) < 1e-9, `${k} drifted`);
});

test('the external field is refused beyond the model validity, not extrapolated', () => {
  const coefficients = coefficientsFor(2026.75);
  const external = externalFieldFor({
    coefficients,
    sunDirection: { x: 1, y: 0, z: 0 },
    parameters: 4,
    evaluate: t89,
    earthRadiusKm: EARTH_RADIUS_KM,
  });
  assert.ok(external({ x: -10 * EARTH_RADIUS_KM, y: 0, z: 0 }), 'inside is modelled');
  assert.equal(
    external({ x: -90 * EARTH_RADIUS_KM, y: 0, z: 0 }),
    null,
    'T89 is stated valid to 70 Re; past that it must decline to answer',
  );
  assert.equal(external({ x: 0, y: 0, z: 0 }), null);
});
