import test from 'node:test';
import assert from 'node:assert/strict';
import { t96 } from './t96.js';
import fixture from './t96-reference.fixture.json' with { type: 'json' };

/**
 * Field of the geodipole, repeated here rather than exported from t96.js.
 *
 * Several tests below assert that T96 returns exactly minus this outside the
 * magnetopause. Importing the model's own copy would make that trivially true,
 * so this is written out from the published formula instead. The radius uses
 * Math.sqrt rather than Math.hypot deliberately: hypot is the better-conditioned
 * of the two and disagrees in the last bit, which is enough to turn an exact
 * cancellation into an approximate one.
 *
 * @param {number} ps Dipole tilt in radians.
 * @param {number} x GSM x in Re.
 * @param {number} y GSM y in Re.
 * @param {number} z GSM z in Re.
 * @returns {{x: number, y: number, z: number}} Field in nT.
 */
function geodipole(ps, x, y, z) {
  const sps = Math.sin(ps);
  const cps = Math.cos(ps);
  const q = 30574 / Math.sqrt(x * x + y * y + z * z) ** 5;
  return {
    x: q * ((y * y + z * z - 2 * x * x) * sps - 3 * z * x * cps),
    y: -3 * y * q * (x * sps + z * cps),
    z: q * ((x * x + y * y - 2 * z * z) * cps - 3 * z * x * sps),
  };
}

test('matches the Python original across solar wind states, tilts and positions', () => {
  // T96 is thirty routines of dense empirical arithmetic with no closed form to
  // check against. A transcription slip anywhere still produces a smooth field
  // that looks like a magnetosphere, so the only useful check is the original.
  // The full sweep this fixture was sampled from is 61,488 points over seven
  // solar wind states and six tilts; it agreed to 9.7e-11 nT absolute and
  // 1.4e-11 relative, with half the points bit-identical.
  let worst = 0;
  let worstAt = null;
  for (const [state, ps, x, y, z, bx, by, bz] of fixture.rows) {
    const b = t96(fixture.states[state], ps, x, y, z);
    const magnitude = Math.max(Math.hypot(bx, by, bz), 1e-9);
    for (const [mine, reference] of [
      [b.x, bx],
      [b.y, by],
      [b.z, bz],
    ]) {
      const error = Math.abs(mine - reference) / magnitude;
      if (error > worst) {
        worst = error;
        worstAt = { state, ps, x, y, z };
      }
    }
  }
  assert.ok(
    worst < 1e-9,
    `worst component error ${(worst * 100).toExponential(3)}% of |B| at ${JSON.stringify(worstAt)}`,
  );
});

test('the fixture exercises every branch of every dispatch', () => {
  // Three magnetopause cases, four region 1 zones and five region 2 branches.
  // Not every combination is geometrically reachable, but each individual
  // branch must appear, or the fixture is silently testing one code path.
  const seen = new Set(fixture.branches.flatMap((label) => label.split('|')));
  for (const branch of [
    'inside',
    'boundary-layer',
    'outside',
    'r1-high-lat',
    'r1-sheet',
    'r1-north-psbl',
    'r1-south-psbl',
    'r2-outer',
    'r2-outer-sheet',
    'r2-sheet',
    'r2-inner-sheet',
    'r2-inner',
  ]) {
    assert.ok(seen.has(branch), `fixture never reaches ${branch}`);
  }
});

test('outside the magnetopause the external field exactly cancels the dipole', () => {
  // This is the whole point of having an explicit boundary: past it there is no
  // magnetosphere, so adding IGRF back must leave only the draped IMF. With no
  // IMF at all the sum has to be identically zero, not merely small.
  const noImf = { pdyn: 2, dst: 0, byimf: 0, bzimf: 0 };
  for (const [x, y, z] of [
    [30, 0, 0],
    [0, 80, 0],
    [0, 0, 90],
    [15, 40, 20],
    [-20, 60, -30],
  ]) {
    const b = t96(noImf, 0.3, x, y, z);
    const d = geodipole(0.3, x, y, z);
    assert.equal(b.x + d.x, 0, `bx at ${x},${y},${z}`);
    assert.equal(b.y + d.y, 0, `by at ${x},${y},${z}`);
    assert.equal(b.z + d.z, 0, `bz at ${x},${y},${z}`);
  }
});

test('the subsolar standoff follows the documented pressure scaling', () => {
  // T96 compresses the magnetosphere by evaluating at a scaled position, with
  // the scale going as pdyn to the 0.14. The standoff distance must therefore
  // go as pdyn to the minus 0.14 - and because the boundary is defined on the
  // scaled coordinate, that holds to round-off rather than approximately.
  const standoff = (pdyn) => {
    const outside = (x) => {
      const b = t96({ pdyn, dst: 0, byimf: 0, bzimf: 0 }, 0, x, 0, 0);
      const d = geodipole(0, x, 0, 0);
      return b.x + d.x === 0 && b.y + d.y === 0 && b.z + d.z === 0;
    };
    let lo = 5;
    let hi = 25;
    for (let i = 0; i < 60; i += 1) {
      const mid = (lo + hi) / 2;
      if (outside(mid)) hi = mid;
      else lo = mid;
    }
    return hi;
  };

  const pressures = [0.5, 1, 2, 4, 8, 16];
  const distances = pressures.map(standoff);
  // Nominal pressure should put the boundary somewhere believable.
  assert.ok(
    distances[2] > 10 && distances[2] < 13,
    `standoff at 2 nPa is ${distances[2]} Re`,
  );
  for (let i = 1; i < pressures.length; i += 1) {
    assert.ok(
      distances[i] < distances[i - 1],
      `pressure must compress: ${pressures[i]} nPa gave ${distances[i]} Re`,
    );
    const observed = distances[i] / distances[i - 1];
    const predicted = (pressures[i] / pressures[i - 1]) ** -0.14;
    assert.ok(
      Math.abs(observed - predicted) < 1e-6,
      `ratio ${observed} against pdyn^-0.14 prediction ${predicted}`,
    );
  }
});

test('southward IMF erodes the dayside field', () => {
  // The interconnection field is what makes T96 worth having over T89: a
  // southward IMF reconnects through the boundary and cancels dayside bz. At
  // 8 Re on the Sun-Earth line the effect is large and monotonic.
  let previous = Infinity;
  for (const bzimf of [10, 5, 0, -5, -10, -20]) {
    const { z } = t96({ pdyn: 2, dst: 0, byimf: 0, bzimf }, 0, 8, 0, 0);
    assert.ok(
      z < previous,
      `bz must fall as the IMF turns south: ${bzimf} nT gave ${z}`,
    );
    previous = z;
  }
  // Strongly southward IMF should drive it negative outright.
  assert.ok(t96({ pdyn: 2, dst: 0, byimf: 0, bzimf: -20 }, 0, 8, 0, 0).z < 0);
});

test('Dst deepens the ring current depression in proportion', () => {
  // The ring current amplitude is linear in the depression estimate
  // 0.8 dst - 13 sqrt(pdyn), so halving Dst must very nearly halve the extra
  // depression it causes.
  const at = (dst) => t96({ pdyn: 2, dst, byimf: 0, bzimf: 0 }, 0, 4, 0, 0).z;
  const quiet = at(0);
  const moderate = at(-50) - quiet;
  const severe = at(-100) - quiet;
  assert.ok(moderate < 0 && severe < moderate, 'depression must deepen');
  assert.ok(
    Math.abs(severe / moderate - 2) < 0.01,
    `doubling Dst changed the depression by ${severe / moderate}x, expected 2x`,
  );
});

test('reflecting the equator flips the field as a pseudovector', () => {
  // Sending z to -z and the tilt to -ps is a mirror reflection, under which a
  // magnetic field transforms as (bx, by, bz) -> (-bx, -by, bz). The model has
  // no north-south asymmetry of its own once the IMF By is zero, so this must
  // hold to round-off. Index and sign slips in the Birkeland and tail modules
  // break it long before they break anything visible.
  const input = { pdyn: 3, dst: -30, byimf: 0, bzimf: -5 };
  for (const [x, y, z, ps] of [
    [-10, 3, 2, 0.4],
    [6, -4, 3, 0.25],
    [-25, 8, -6, 0.5],
    [4, 0, 1, 0.6],
  ]) {
    const direct = t96(input, ps, x, y, z);
    const mirrored = t96(input, -ps, x, y, -z);
    const scale = Math.max(Math.hypot(direct.x, direct.y, direct.z), 1);
    assert.ok(
      Math.abs(mirrored.x + direct.x) / scale < 1e-12,
      `bx did not flip at ${x},${y},${z}`,
    );
    assert.ok(
      Math.abs(mirrored.y + direct.y) / scale < 1e-12,
      `by did not flip at ${x},${y},${z}`,
    );
    assert.ok(
      Math.abs(mirrored.z - direct.z) / scale < 1e-12,
      `bz did not survive at ${x},${y},${z}`,
    );
  }
});

test('the transverse field vanishes on the Sun-Earth line at zero tilt', () => {
  // With no tilt, no IMF By and y = z = 0 the geometry is symmetric about the
  // x axis, so by must vanish and bx must be zero to round-off.
  //
  // Northward IMF gives a clock angle of exactly zero, and by comes out exactly
  // zero with it. Southward IMF gives a clock angle of pi, and sin(pi) is
  // 1.2e-16 rather than 0 in a double, so a round-off-scale by leaks through the
  // rotation out of the IMF-aligned frame. That is floating point, not physics,
  // and the two cases are asserted separately rather than papered over with one
  // loose tolerance.
  for (const x of [-20, -10, -3, 4, 8]) {
    const northward = t96({ pdyn: 2, dst: -20, byimf: 0, bzimf: 3 }, 0, x, 0, 0);
    assert.equal(northward.y, 0, `by at x = ${x} with northward IMF`);
    assert.ok(Math.abs(northward.x) < 1e-6, `bx = ${northward.x} at x = ${x}`);

    const southward = t96({ pdyn: 2, dst: -20, byimf: 0, bzimf: -3 }, 0, x, 0, 0);
    assert.ok(
      Math.abs(southward.y) < 1e-14,
      `by = ${southward.y} at x = ${x} with southward IMF`,
    );
    assert.ok(Math.abs(southward.x) < 1e-6, `bx = ${southward.x} at x = ${x}`);
  }
});

test('IMF By leaks through the boundary with the right sign', () => {
  // The interconnection field is the only term that can produce by on the
  // Sun-Earth line, and it must be odd in the IMF By and strictly weaker than
  // it - a fraction of the IMF penetrates, not a multiple.
  for (const byimf of [5, 10]) {
    const positive = t96({ pdyn: 2, dst: 0, byimf, bzimf: 0 }, 0, 8, 0, 0).y;
    const negative = t96({ pdyn: 2, dst: 0, byimf: -byimf, bzimf: 0 }, 0, 8, 0, 0).y;
    assert.equal(positive, -negative);
    assert.ok(positive > 0, `by should follow the IMF sign, got ${positive}`);
    assert.ok(
      positive < byimf,
      `penetrated by ${positive} exceeds the IMF ${byimf}`,
    );
  }
});

test('returns finite values everywhere a field line could be traced', () => {
  // The model has several branches that divide by a radius or a cylindrical
  // distance. Anything that returns NaN silently poisons a whole field line
  // rather than failing where it happened.
  const input = { pdyn: 4, dst: -60, byimf: 4, bzimf: -8 };
  for (const ps of [-0.6, 0, 0.6]) {
    for (const r of [2.1, 4, 6.6, 11, 20, 40, 65]) {
      for (const theta of [0.01, 0.4, 1.0, Math.PI / 2, 2.1, 2.7, 3.13]) {
        for (const phi of [0, 0.7, 1.5708, 2.4, Math.PI, 4.1, 4.712, 5.6]) {
          const x = r * Math.sin(theta) * Math.cos(phi);
          const y = r * Math.sin(theta) * Math.sin(phi);
          const z = r * Math.cos(theta);
          const b = t96(input, ps, x, y, z);
          assert.ok(
            Number.isFinite(b.x) && Number.isFinite(b.y) && Number.isFinite(b.z),
            `non-finite at r=${r} theta=${theta} phi=${phi} ps=${ps}`,
          );
        }
      }
    }
  }
});
