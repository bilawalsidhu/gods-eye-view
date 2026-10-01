import test from 'node:test';
import assert from 'node:assert/strict';
import {
  MAX_BOUNDARY_ANGLE_RAD,
  clipToBoundary,
  fieldLineSeeds,
  magnetopauseWireframe,
  sunAlignedBasis,
} from './geometry.js';
import { shueParameters } from './magnetopause.js';
import { EARTH_RADIUS_KM } from './trace.js';

const dot = (a, b) => a.x * b.x + a.y * b.y + a.z * b.z;

test('the Sun-aligned basis is orthonormal for any Sun direction, including the axes', () => {
  // The seed axis is chosen by smallest component precisely so a Sun sitting
  // on an axis does not produce a zero cross product and a silent NaN basis.
  for (const sun of [
    { x: 1, y: 0, z: 0 },
    { x: 0, y: 1, z: 0 },
    { x: 0, y: 0, z: 1 },
    { x: 0.571, y: -0.819, z: -0.056 },
    { x: -3, y: 4, z: 12 },
  ]) {
    const basis = sunAlignedBasis(sun);
    assert.ok(basis, `no basis for ${JSON.stringify(sun)}`);
    for (const axis of [basis.x, basis.y, basis.z])
      assert.ok(Math.abs(Math.hypot(axis.x, axis.y, axis.z) - 1) < 1e-12);
    for (const [a, b] of [
      [basis.x, basis.y],
      [basis.y, basis.z],
      [basis.z, basis.x],
    ])
      assert.ok(Math.abs(dot(a, b)) < 1e-12, 'axes must be perpendicular');
  }
  assert.equal(sunAlignedBasis({ x: 0, y: 0, z: 0 }), null);
});

test('the subsolar point sits at the standoff distance, along the Sun line', () => {
  const parameters = shueParameters(2, -5);
  const sun = { x: 0.6, y: -0.8, z: 0 };
  const { meridians } = magnetopauseWireframe(parameters, sun);
  const nose = meridians[0][0];
  const radiusRe = Math.hypot(nose.x, nose.y, nose.z) / EARTH_RADIUS_KM;
  assert.ok(
    Math.abs(radiusRe - parameters.r0) < 1e-6,
    `nose at ${radiusRe} Re, expected ${parameters.r0}`,
  );
  // and it must point AT the Sun, not merely be the right distance away
  const unit = sunAlignedBasis(sun).x;
  const alignment =
    dot(nose, unit) / Math.hypot(nose.x, nose.y, nose.z);
  assert.ok(alignment > 0.999999, `nose is off the Sun line (${alignment})`);
});

test('the boundary flares away from the Sun rather than closing', () => {
  const parameters = shueParameters(2, -5);
  const { meridians } = magnetopauseWireframe(parameters, { x: 1, y: 0, z: 0 });
  const line = meridians[0];
  const radii = line.map((p) => Math.hypot(p.x, p.y, p.z));
  for (let i = 1; i < radii.length; i++)
    assert.ok(radii[i] > radii[i - 1], 'radius must grow down the tail');
  assert.ok(MAX_BOUNDARY_ANGLE_RAD < Math.PI, 'the tail must not be closed off');
});

test('seeds cover both hemispheres and start above the surface', () => {
  const seeds = fieldLineSeeds(6);
  assert.ok(seeds.some((s) => s.latitude > 0));
  assert.ok(
    seeds.some((s) => s.latitude < 0),
    'the southern oval is real and usually forgotten',
  );
  for (const seed of seeds) {
    const r = Math.hypot(seed.position.x, seed.position.y, seed.position.z);
    assert.ok(r > EARTH_RADIUS_KM, 'seeds must start above ground');
  }
  assert.equal(new Set(seeds.map((s) => s.longitude)).size, 6);
});

test('a line crossing the boundary is clipped, and one inside is untouched', () => {
  const parameters = shueParameters(2, -5);
  const sun = { x: 1, y: 0, z: 0 };
  const nose = parameters.r0 * EARTH_RADIUS_KM;
  const crossing = [
    { x: nose * 0.5, y: 0, z: 0 },
    { x: nose * 0.9, y: 0, z: 0 },
    { x: nose * 1.4, y: 0, z: 0 },
    { x: nose * 2.0, y: 0, z: 0 },
  ];
  const clipped = clipToBoundary(crossing, parameters, sun);
  assert.equal(clipped.clipped, true);
  assert.ok(clipped.points.length < crossing.length);

  const inside = crossing.slice(0, 2);
  assert.equal(clipToBoundary(inside, parameters, sun).clipped, false);
});
