import test from 'node:test';
import assert from 'node:assert/strict';
import {
  MAX_BOUNDARY_ANGLE_RAD,
  SEED_LATITUDES,
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

test('seeds cover the band where the solar wind takes over from the internal field', () => {
  // Between ~5 and ~8 Re is where storms visibly stretch closed lines into the
  // tail; without seeds there the layer only shows the outermost shell moving.
  for (const latitude of [65, 70, -65, -70]) {
    assert.ok(SEED_LATITUDES.includes(latitude), `missing ${latitude}`);
  }
  assert.equal(fieldLineSeeds(8).length, SEED_LATITUDES.length * 8);
});

test('a line crossing the boundary is clipped, and one inside is untouched', () => {
  const parameters = shueParameters(2, -5);
  const sun = { x: 1, y: 0, z: 0 };
  const nose = parameters.r0 * EARTH_RADIUS_KM;
  const crossing = [
    { x: EARTH_RADIUS_KM * 1.02, y: 0, z: 0 },
    { x: nose * 0.5, y: 0, z: 0 },
    { x: nose * 0.9, y: 0, z: 0 },
    { x: nose * 1.4, y: 0, z: 0 },
    { x: nose * 2.0, y: 0, z: 0 },
  ];
  const clipped = clipToBoundary(crossing, parameters, sun);
  assert.equal(clipped.clipped, true);
  assert.equal(clipped.segments.length, 1);
  const [run] = clipped.segments;
  assert.equal(run.length, 4, 'three inside points plus the crossing');
  assert.ok(
    Math.abs(run.at(-1).x - nose) < 1,
    'the kept run ends on the boundary, not a step short of it',
  );

  const inside = crossing.slice(0, 3);
  assert.deepEqual(clipToBoundary(inside, parameters, sun), {
    segments: [inside],
    clipped: false,
  });
});

test('a line whose far end lies outside keeps its Earth-attached part, not a stub', () => {
  // traceFullLine joins the backward half reversed onto the forward half, so
  // a line that escaped backward STARTS outside the boundary. Clipping from
  // the front used to keep two points out there and drop the filament.
  const parameters = shueParameters(2, -5);
  const sun = { x: 1, y: 0, z: 0 };
  const nose = parameters.r0 * EARTH_RADIUS_KM;
  const line = [
    { x: nose * 3, y: 0, z: 0 },
    { x: nose * 2, y: 0, z: 0 },
    { x: nose * 0.8, y: 0, z: 0 },
    { x: nose * 0.4, y: 0, z: 0 },
    { x: EARTH_RADIUS_KM * 1.02, y: 0, z: 0 },
  ];
  const { segments, clipped } = clipToBoundary(line, parameters, sun);
  assert.equal(clipped, true);
  assert.equal(segments.length, 1);
  assert.ok(Math.abs(segments[0][0].x - nose) < 1, 'starts on the boundary');
  assert.deepEqual(segments[0].slice(1), line.slice(2));
});

test('a stretch back inside the boundary but cut off from Earth is dropped', () => {
  // Far down the flank a line can leave the boundary and dip back in. Drawn
  // alone, that piece is the filament fragment floating out by the Moon.
  const parameters = shueParameters(2, -5);
  const sun = { x: 1, y: 0, z: 0 };
  const nose = parameters.r0 * EARTH_RADIUS_KM;
  const far = 30 * EARTH_RADIUS_KM;
  const line = [
    { x: -far, y: 0, z: 0 }, // tail, inside: past the drawn boundary angle
    { x: -far * 0.9, y: far, z: 0 }, // flank, outside
    { x: EARTH_RADIUS_KM * 1.5, y: nose * 0.5, z: 0 },
    { x: EARTH_RADIUS_KM * 1.02, y: 0, z: 0 },
  ];
  const { segments } = clipToBoundary(line, parameters, sun);
  assert.equal(segments.length, 1);
  assert.ok(
    segments[0].every((p) => Math.hypot(p.x, p.y, p.z) < far),
    'the detached tail point is not drawn',
  );
});
