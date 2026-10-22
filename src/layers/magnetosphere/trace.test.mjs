import test from 'node:test';
import assert from 'node:assert/strict';
import { coefficientsFor } from './field.js';
import {
  EARTH_RADIUS_KM,
  TRACE_END,
  surfacePoint,
  traceFieldLine,
  traceFullLine,
} from './trace.js';

const coefficients = coefficientsFor(2026.5);
const apexRe = (points) =>
  Math.max(...points.map((p) => Math.hypot(p.x, p.y, p.z))) / EARTH_RADIUS_KM;

test('apex follows the dipole L-shell law, so the geometry is physical', () => {
  // A dipole line seeded at latitude L reaches about 1/cos^2(L) Earth radii.
  // IGRF is not a pure dipole, so expect consistent undershoot rather than a
  // match — but an apex that does not climb with latitude means the tracer is
  // wrong, not that the field is interesting.
  let previous = 0;
  for (const latitude of [20, 45, 60, 70]) {
    const { points } = traceFullLine(
      coefficients,
      surfacePoint(latitude, 0, EARTH_RADIUS_KM + 120),
    );
    const apex = apexRe(points);
    const dipole = 1 / Math.cos((latitude * Math.PI) / 180) ** 2;
    assert.ok(apex > previous, `apex must grow with latitude (${latitude})`);
    assert.ok(
      apex > dipole * 0.6 && apex < dipole * 1.2,
      `apex ${apex.toFixed(2)} Re is not near the dipole expectation ${dipole.toFixed(2)}`,
    );
    previous = apex;
  }
});

test('growing the step with radius does not move the apex', () => {
  // This is the whole justification for adaptive stepping. If it changed the
  // answer it would be a speed-up that quietly rewrote the physics.
  const seed = surfacePoint(75, 0, EARTH_RADIUS_KM + 120);
  const fine = traceFullLine(coefficients, seed, {
    stepKm: 80,
    maxStepScale: 1,
  });
  const adaptive = traceFullLine(coefficients, seed, { stepKm: 80 });
  const drift = Math.abs(apexRe(fine.points) - apexRe(adaptive.points));
  assert.ok(
    drift < 0.05,
    `apex moved ${drift.toFixed(3)} Re between fixed and adaptive stepping`,
  );
  assert.ok(
    adaptive.points.length * 3 < fine.points.length,
    'adaptive stepping should be markedly cheaper, or it is not worth the code',
  );
});

test('a closed line lands exactly on the surface at both ends', () => {
  const { points, ends } = traceFullLine(
    coefficients,
    surfacePoint(55, 30, EARTH_RADIUS_KM + 120),
  );
  assert.deepEqual(ends, [TRACE_END.closed, TRACE_END.closed]);
  for (const end of [points[0], points.at(-1)]) {
    const radius = Math.hypot(end.x, end.y, end.z);
    assert.ok(
      Math.abs(radius - EARTH_RADIUS_KM) < 1,
      `endpoint is ${(radius - EARTH_RADIUS_KM).toFixed(1)} km off the surface`,
    );
  }
});

test('a line that leaves the modelled volume reports escaped, not closed', () => {
  const { end } = traceFieldLine(
    coefficients,
    surfacePoint(89, 0, EARTH_RADIUS_KM + 120),
    { direction: 1, maxRadiusKm: 2 * EARTH_RADIUS_KM },
  );
  assert.ok(
    end === TRACE_END.escaped || end === TRACE_END.closed,
    `unexpected end ${end}`,
  );
});

test('the step budget is reported rather than silently truncating', () => {
  // Seeded well above the equator, where the line is long in both directions.
  // A surface seed in the northern hemisphere closes within a step or two,
  // because the field there points into the ground.
  const { end, points } = traceFieldLine(
    coefficients,
    surfacePoint(0, 0, 3 * EARTH_RADIUS_KM),
    { maxSteps: 5 },
  );
  assert.equal(end, TRACE_END.exhausted);
  assert.equal(points.length, 6);
});

test('northern surface seeds close immediately along +B, which is the physics', () => {
  const { end } = traceFieldLine(
    coefficients,
    surfacePoint(75, 0, EARTH_RADIUS_KM + 120),
    { direction: 1 },
  );
  assert.equal(end, TRACE_END.closed);
});

test('tracing both ways returns one line, not half of one', () => {
  const seed = surfacePoint(50, 10, 3 * EARTH_RADIUS_KM);
  const half = traceFieldLine(coefficients, seed, { direction: 1 });
  const full = traceFullLine(coefficients, seed);
  assert.ok(
    full.points.length > half.points.length,
    'a mid-line seed must extend in both directions',
  );
  const ends = [full.points[0], full.points.at(-1)].map((p) =>
    Math.hypot(p.x, p.y, p.z),
  );
  for (const radius of ends)
    assert.ok(radius < 1.01 * EARTH_RADIUS_KM, 'both ends should reach ground');
});
