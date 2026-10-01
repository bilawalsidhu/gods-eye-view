import test from 'node:test';
import assert from 'node:assert/strict';
import { T89_COEFFICIENTS, t89, t89BandForKp } from './t89.js';
import fixture from './t89-reference.fixture.json' with { type: 'json' };

test('matches the Python original across bands, tilts and positions', () => {
  // 420 points from the MIT-licensed geopack translation. This is a
  // transliteration of dense empirical arithmetic: a transcription slip
  // anywhere in 230 lines still produces a smooth field that looks like a
  // magnetosphere, so the only useful check is against the original.
  let worst = 0;
  for (const p of fixture.points) {
    const b = t89(p.band, p.ps, p.x, p.y, p.z);
    const magnitude = Math.max(Math.hypot(p.bx, p.by, p.bz), 1e-9);
    for (const [mine, reference] of [
      [b.x, p.bx],
      [b.y, p.by],
      [b.z, p.bz],
    ])
      worst = Math.max(worst, Math.abs(mine - reference) / magnitude);
  }
  assert.ok(
    worst < 1e-6,
    `worst component error ${(worst * 100).toExponential(3)}% of |B|`,
  );
});

test('the coefficient table has seven complete bands', () => {
  assert.equal(T89_COEFFICIENTS.length, 7);
  for (const row of T89_COEFFICIENTS) {
    assert.equal(row.length, 30);
    assert.ok(row.every(Number.isFinite), 'no holes in the published table');
  }
  // Bands must differ, or the column-major unpacking silently aliased them.
  assert.notDeepEqual([...T89_COEFFICIENTS[0]], [...T89_COEFFICIENTS[6]]);
});

test('symmetry holds on the Sun-Earth line at zero tilt', () => {
  // With no dipole tilt and y = z = 0 the geometry is axisymmetric, so the
  // transverse components must vanish exactly. A sign or index slip in the
  // tail or ring-current terms breaks this before it breaks anything visible.
  for (const x of [-20, -10, -3, 2, 6]) {
    const b = t89(4, 0, x, 0, 0);
    assert.ok(Math.abs(b.x) < 1e-9, `bx=${b.x} at x=${x}`);
    assert.ok(Math.abs(b.y) < 1e-9, `by=${b.y} at x=${x}`);
  }
});

test('disturbance bands map from Kp the way the model documents', () => {
  assert.equal(t89BandForKp(0), 1);
  assert.equal(t89BandForKp(0.33), 1);
  assert.equal(t89BandForKp(1), 2);
  assert.equal(t89BandForKp(2.7), 3);
  assert.equal(t89BandForKp(5.9), 6);
  assert.equal(t89BandForKp(6), 7);
  assert.equal(t89BandForKp(9), 7);
  // A missing Kp must mean "quiet", not "NaN propagated into the field".
  assert.equal(t89BandForKp(Number.NaN), 1);
  assert.equal(t89BandForKp(undefined), 1);
});

test('the field varies monotonically with disturbance band', () => {
  // Checked against the Python original rather than assumed: at 15 Re down
  // the tail, bz runs -7.95 nT at band 1 to -1.13 nT at band 7. It is
  // monotonic, but toward zero — the northward tail field is progressively
  // cancelled as the cross-tail current strengthens, which is what stretches
  // the lines. An earlier version of this test asserted |bz| GROWS with the
  // band; the port disagreed, and the port was right.
  let previous = -Infinity;
  for (let band = 1; band <= 7; band++) {
    const { z } = t89(band, 0, -15, 0, 0);
    assert.ok(
      z > previous,
      `bz must rise with band: band ${band} gave ${z}, previous ${previous}`,
    );
    previous = z;
  }
});

test('out-of-range bands are clamped rather than reading past the table', () => {
  assert.deepEqual(t89(0, 0, -5, 0, 0), t89(1, 0, -5, 0, 0));
  assert.deepEqual(t89(99, 0, -5, 0, 0), t89(7, 0, -5, 0, 0));
});
