import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  BARNES_GAMMA,
  BARNES_WMIN,
  barnesScalar,
  barnesVector,
  holdoutSplit,
  toNullable,
  validateAnalysis,
} from './barnes.js';

/** Uniform axis of `n` points spaced `h` metres apart, starting at `x0`. */
function axis(n, h, x0 = 0) {
  const a = new Float64Array(n);
  for (let i = 0; i < n; i += 1) a[i] = x0 + i * h;
  return a;
}

/** Scalar observations on a lattice, valued by `f(x, y)`; quality defaults to 1. */
function latticeObs(xsObs, ysObs, f, quality = 1) {
  const obs = [];
  for (let j = 0; j < ysObs.length; j += 1) {
    for (let i = 0; i < xsObs.length; i += 1) {
      obs.push({ x: xsObs[i], y: ysObs[j], value: f(xsObs[i], ysObs[j]), quality });
    }
  }
  return obs;
}

/**
 * Naive O(n_obs · n_cells) pass-1 analysis, written straight from the
 * definition. Cross-checks the separable/binary-search inner loops in
 * barnes.js, which are the only part of the implementation that is not
 * obviously the formula.
 */
function bruteForcePass1(obs, xs, ys, L, wMin = BARNES_WMIN) {
  const nx = xs.length;
  const ny = ys.length;
  const field = new Float64Array(nx * ny).fill(Number.NaN);
  const weight = new Float64Array(nx * ny);
  const cut2 = 9 * L * L;
  for (let iy = 0; iy < ny; iy += 1) {
    for (let ix = 0; ix < nx; ix += 1) {
      let num = 0;
      let den = 0;
      for (const o of obs) {
        const dx = xs[ix] - o.x;
        const dy = ys[iy] - o.y;
        const r2 = dx * dx + dy * dy;
        if (r2 > cut2) continue;
        const w = o.quality * Math.exp(-r2 / (L * L));
        num += w * o.value;
        den += w;
      }
      const k = iy * nx + ix;
      weight[k] = den;
      if (den >= wMin) field[k] = num / den;
    }
  }
  return { field, weight };
}

/**
 * Bilinear sample written independently of barnes.js: cell located by a linear
 * scan rather than a binary search, and the four corners combined in one
 * expression with no void renormalisation. Requires the query strictly inside
 * the grid and every corner finite — both guaranteed by the fixture below.
 */
function sampleNaive(field, xs, ys, x, y) {
  const nx = xs.length;
  let ix = 0;
  while (ix + 2 < nx && xs[ix + 1] <= x) ix += 1;
  let iy = 0;
  while (iy + 2 < ys.length && ys[iy + 1] <= y) iy += 1;
  const tx = (x - xs[ix]) / (xs[ix + 1] - xs[ix]);
  const ty = (y - ys[iy]) / (ys[iy + 1] - ys[iy]);
  return (1 - tx) * (1 - ty) * field[iy * nx + ix]
    + tx * (1 - ty) * field[iy * nx + ix + 1]
    + (1 - tx) * ty * field[(iy + 1) * nx + ix]
    + tx * ty * field[(iy + 1) * nx + ix + 1];
}

/**
 * Naive O(n_obs · n_cells) TWO-pass analysis, from the definition, sharing no
 * code path with barnes.js: no binary search, no separable exp(−dx²)·exp(−dy²)
 * factorisation, no scratch reuse, gather-per-cell instead of scatter-per-
 * observation, and the independent sampler above. Valid only where the grid is
 * fully covered — the module's void-corner renormalisation has no analogue here,
 * so the caller must assert full coverage.
 */
function bruteForceTwoPass(obs, xs, ys, L, wMin = BARNES_WMIN, gamma = BARNES_GAMMA) {
  const nx = xs.length;
  const ny = ys.length;
  const cut1sq = 9 * L * L;
  const L2 = L * Math.sqrt(gamma);
  const cut2sq = 9 * L2 * L2;

  const pass1 = new Float64Array(nx * ny).fill(Number.NaN);
  for (let iy = 0; iy < ny; iy += 1) {
    for (let ix = 0; ix < nx; ix += 1) {
      let num = 0;
      let den = 0;
      for (const o of obs) {
        const dx = xs[ix] - o.x;
        const dy = ys[iy] - o.y;
        const r2 = dx * dx + dy * dy;
        if (r2 > cut1sq) continue;
        const w = o.quality * Math.exp(-r2 / (L * L));
        num += w * o.value;
        den += w;
      }
      if (den >= wMin) pass1[iy * nx + ix] = num / den;
    }
  }

  const resid = obs.map((o) => o.value - sampleNaive(pass1, xs, ys, o.x, o.y));
  const out = Float64Array.from(pass1);
  for (let iy = 0; iy < ny; iy += 1) {
    for (let ix = 0; ix < nx; ix += 1) {
      const k = iy * nx + ix;
      if (!Number.isFinite(pass1[k])) continue;
      let num = 0;
      let den = 0;
      for (let j = 0; j < obs.length; j += 1) {
        if (!Number.isFinite(resid[j])) continue;
        const o = obs[j];
        const dx = xs[ix] - o.x;
        const dy = ys[iy] - o.y;
        const r2 = dx * dx + dy * dy;
        if (r2 > cut2sq) continue;
        const w = o.quality * Math.exp(-r2 / (L2 * L2));
        num += w * resid[j];
        den += w;
      }
      if (den > 0) out[k] = pass1[k] + num / den;
    }
  }
  return out;
}

/** Deterministic scattered observations strictly inside the grid, valued by `f`. */
function scatterObs(count, xMin, xMax, yMin, yMax, f) {
  const obs = [];
  for (let i = 0; i < count; i += 1) {
    // Coprime strides give a spread-out, fully deterministic scatter.
    const x = xMin + ((i * 7919) % (xMax - xMin));
    const y = yMin + ((i * 104729) % (yMax - yMin));
    obs.push({ x, y, value: f(x, y), quality: 0.35 + ((i * 37) % 61) / 100 });
  }
  return obs;
}

/** RMS of the analysis-minus-observation misfit at the observation positions. */
function rmsMisfitAtObs(field, obs, indexOf) {
  let s = 0;
  let n = 0;
  for (const o of obs) {
    const k = indexOf(o);
    if (!Number.isFinite(field[k])) continue;
    s += (field[k] - o.value) ** 2;
    n += 1;
  }
  return Math.sqrt(s / n);
}

test('constant field is recovered exactly wherever the analysis is covered', () => {
  const xs = axis(21, 1000);
  const ys = axis(21, 1000);
  const C = -0.37; // m/s
  const obs = latticeObs(axis(21, 1000), axis(21, 1000), () => C, 0.8);
  const { field, weight } = barnesScalar(obs, xs, ys, 2500);

  let covered = 0;
  for (let k = 0; k < field.length; k += 1) {
    if (!Number.isFinite(field[k])) continue;
    covered += 1;
    // Σ(w·C)/Σw is C only to within the rounding of two differently-ordered
    // sums, not bit-exactly; a few ulp of |C| is the whole error budget.
    assert.ok(
      Math.abs(field[k] - C) <= 1e-14 * Math.abs(C),
      `cell ${k} = ${field[k]}, expected ${C}`,
    );
    assert.ok(weight[k] >= BARNES_WMIN);
  }
  assert.equal(covered, field.length); // the lattice covers every cell
});

test('pass 1 matches a naive from-the-definition implementation', () => {
  const xs = axis(31, 1200);
  const ys = axis(27, 1200);
  const obs = latticeObs(axis(15, 2400, 600), axis(13, 2400, 600), (x, y) => Math.sin(x / 9000) + y / 4e5, 0.65);
  const L = 3000;

  const naive = bruteForcePass1(obs, xs, ys, L);
  const { weight } = barnesScalar(obs, xs, ys, L);
  for (let k = 0; k < weight.length; k += 1) {
    if (naive.weight[k] === 0) {
      assert.equal(weight[k], 0, `cell ${k} should be outside every kernel`);
      continue;
    }
    // barnes.js forms exp(−dx²/L²)·exp(−dy²/L²) where the naive version forms
    // exp(−r²/L²); those differ by ≤ 2 ulp per term, so ~1e-15 relative after
    // summation. 1e-12 is three decades of slack on that.
    assert.ok(
      Math.abs(weight[k] - naive.weight[k]) <= 1e-12 * naive.weight[k],
      `weight[${k}] = ${weight[k]} vs naive ${naive.weight[k]}`,
    );
  }
});

test('both passes match a naive from-the-definition two-pass implementation', () => {
  // The weight cross-check above pins the kernel geometry but never inspects an
  // analysed VALUE: a numerator bug (wrong component, wrong residual, pass-2
  // correction added to the wrong cell) leaves every weight correct. This
  // compares the full two-pass field against bruteForceTwoPass, which shares no
  // code path with the module.
  const nx = 15;
  const ny = 13;
  const h = 1000;
  const L = 3000;
  const xs = axis(nx, h);
  const ys = axis(ny, h);
  // Non-separable and non-linear, so a transposed index or a dropped pass shows
  // up as a value error rather than cancelling.
  const f = (x, y) => 0.3 * Math.sin(x / 4000) * Math.cos(y / 5500) + 1.7e-5 * x;
  const obs = scatterObs(60, 500, 13500, 500, 11500, f);

  const { field } = barnesScalar(obs, xs, ys, L);
  const naive = bruteForceTwoPass(obs, xs, ys, L);

  // bruteForceTwoPass has no void handling, so the comparison is only valid on
  // a fully covered grid. Assert that rather than assume it.
  for (let k = 0; k < field.length; k += 1) {
    assert.ok(Number.isFinite(naive[k]), `naive cell ${k} is a void; fixture must cover the grid`);
    assert.ok(Number.isFinite(field[k]), `module cell ${k} is a void; fixture must cover the grid`);
  }

  // The two sum in different orders (scatter-per-observation vs gather-per-cell)
  // and form the kernel differently (exp(−dx²/L²)·exp(−dy²/L²) vs exp(−r²/L²),
  // <= 2 ulp per term), so this is a round-off tolerance, not a modelling one.
  // Measured worst absolute deviation on this fixture: 1.665e-16 m/s, i.e. ~1 ulp
  // of the 0.465 m/s field range. The 1e-12 gate is ~4 decades above that and
  // ~11 decades below the effect it must catch: the pass-2 correction itself is
  // worth up to 1.116e-1 m/s here, so dropping the pass overshoots the gate by
  // 1.1e11x.
  let worst = 0;
  for (let k = 0; k < field.length; k += 1) {
    const d = Math.abs(field[k] - naive[k]);
    if (d > worst) worst = d;
  }
  assert.ok(worst < 1e-12, `worst |module − naive| = ${worst.toExponential(3)} m/s`);

  // And the fixture must be non-trivial: a constant field would make pass 2 a
  // no-op and hide exactly the bugs this test exists to catch.
  let min = Infinity;
  let max = -Infinity;
  for (let k = 0; k < field.length; k += 1) {
    if (field[k] < min) min = field[k];
    if (field[k] > max) max = field[k];
  }
  assert.ok(max - min > 0.1, `fixture must vary across the grid, got range ${max - min}`);
});

test('linear field is recovered to round-off from an off-grid observation lattice', () => {
  // Observations sit at cell CENTRES, half a cell off the analysis grid. That
  // lattice is still mirror-symmetric about every grid point, so Σw·(v − v_c)
  // = b·Σw·dx + c·Σw·dy vanishes pair-by-pair and pass 1 is exact; and because
  // bilinear interpolation reproduces a linear function exactly, pass 2 sees a
  // zero residual at every observation and adds nothing.
  //
  // This is the decisive test of IMPROVEMENT 1. Nearest-cell sampling of pass 1
  // (what the reference implementation did) puts all four corners of the
  // enclosing cell at equal distance from a cell-centre observation, so its
  // tie-break lands on the SW corner and every residual becomes the same
  // half-cell offset times the gradient, 500·2e-5 − 500·1.1e-5 = 4.5e-3 m/s.
  // Substituting the reference's sampler into this module and re-running this
  // fixture gives a worst interior error of exactly 4.500e-3 m/s, against
  // 6.7e-16 m/s measured for the bilinear version. The 1e-9 tolerance sits
  // ~6 decades below the former and ~6 decades above the latter — the
  // floating-point summation error over the π(3L)²/h² ≈ 113 kernel terms per
  // cell. (On a field with a non-uniform gradient the nearest-cell error does
  // not collapse to a uniform offset; it becomes structured noise of that size.)
  const h = 1000;
  const n = 61;
  const L = 2000;
  const xs = axis(n, h);
  const ys = axis(n, h);
  const linear = (x, y) => 0.42 + 2e-5 * x - 1.1e-5 * y; // m/s, gradient 0.02 / 0.011 m/s per cell
  const obs = latticeObs(axis(n - 1, h, h / 2), axis(n - 1, h, h / 2), linear, 0.9);
  const { field } = barnesScalar(obs, xs, ys, L);

  // Exactness needs every observation within 3L₂ of the cell to itself have an
  // exact pass-1 stencil, i.e. margin ≥ 3L + h + 3L√γ ≈ 10.3 km ⇒ 11 cells.
  const margin = 11;
  let worst = 0;
  for (let iy = margin; iy < n - margin; iy += 1) {
    for (let ix = margin; ix < n - margin; ix += 1) {
      const err = Math.abs(field[iy * n + ix] - linear(xs[ix], ys[iy]));
      if (err > worst) worst = err;
    }
  }
  assert.ok(worst < 1e-9, `worst interior error ${worst} m/s exceeds 1e-9`);
});

test('a data void stays NaN instead of being extrapolated', () => {
  const xs = axis(41, 1000);
  const ys = axis(41, 1000);
  const L = 2000;
  // Observations only in the south-west corner, all strongly positive.
  const obs = latticeObs(axis(5, 1000), axis(5, 1000), () => 1.5, 1);
  const { field, weight } = barnesScalar(obs, xs, ys, L);

  const far = 40 * 41 + 40; // north-east corner, ~54 km from the nearest observation
  assert.ok(Number.isNaN(field[far]), 'far corner must not be filled');
  assert.ok(weight[far] < BARNES_WMIN);
  // Nothing anywhere may exceed the observed range: Barnes is a convex
  // combination of observations in pass 1, and pass 2 only redistributes
  // residuals that are identically zero for a constant observation set.
  for (let k = 0; k < field.length; k += 1) {
    if (Number.isFinite(field[k])) assert.ok(Math.abs(field[k] - 1.5) < 1e-12);
  }
  // The void is large: most of the grid must be unanalysed.
  let finite = 0;
  for (let k = 0; k < field.length; k += 1) if (Number.isFinite(field[k])) finite += 1;
  assert.ok(finite > 0 && finite < 0.25 * field.length, `finite cells ${finite}/${field.length}`);
});

test('the wMin gate fires exactly at the integrated pass-1 weight', () => {
  // One observation of unit quality at the origin, so the integrated weight at
  // distance r is exactly exp(−r²/L²). With L = 1000 the gate at wMin = 0.12
  // sits at r = L·√(−ln 0.12) = 1456.1 m.
  const L = 1000;
  const xs = Float64Array.from([0, 1400, 1500, 3000, 3001]);
  const ys = Float64Array.from([0]);
  const obs = [{ x: 0, y: 0, value: 1, quality: 1 }];
  const { field, weight } = barnesScalar(obs, xs, ys, L, 0.12);

  assert.ok(Math.abs(weight[1] - Math.exp(-1.96)) <= 1e-12 * Math.exp(-1.96)); // 0.1409 > wMin
  assert.ok(Math.abs(weight[2] - Math.exp(-2.25)) <= 1e-12 * Math.exp(-2.25)); // 0.1054 < wMin
  assert.equal(field[0], 1); // single observation ⇒ w·v/w is bit-exact
  assert.ok(Number.isFinite(field[1]), 'r = 1400 m is inside the gate');
  assert.ok(Number.isNaN(field[2]), 'r = 1500 m is outside the gate');
  // The truncation is inclusive at exactly r = 3L and empty beyond it.
  assert.ok(Math.abs(weight[3] - Math.exp(-9)) <= 1e-12 * Math.exp(-9), 'r = 3L must still contribute');
  assert.equal(weight[4], 0, 'r = 3L + 1 m must be truncated away');
});

test('pass 2 tightens the analysis toward the observations, more so as gamma shrinks', () => {
  // A sinusoid at λ = 4L, where the single-pass response is
  // D₁ = exp(−π²L²/λ²) = exp(−π²/16) = 0.540 — so pass 1 must under-fit
  // visibly, and pass 2 must claw amplitude back.
  const h = 1000;
  const n = 61;
  const L = 2500;
  const lambda = 4 * L;
  const xs = axis(n, h);
  const ys = axis(n, h);
  const f = (x) => Math.sin((2 * Math.PI * x) / lambda);
  const obs = latticeObs(xs, ys, f, 1);
  const indexOf = (o) => Math.round(o.y / h) * n + Math.round(o.x / h);

  const p1 = bruteForcePass1(obs, xs, ys, L).field;
  const g03 = barnesScalar(obs, xs, ys, L, BARNES_WMIN, 0.3).field;
  const g09 = barnesScalar(obs, xs, ys, L, BARNES_WMIN, 0.9);
  const g01 = barnesScalar(obs, xs, ys, L, BARNES_WMIN, 0.1).field;

  const m1 = rmsMisfitAtObs(p1, obs, indexOf);
  const m03 = rmsMisfitAtObs(g03, obs, indexOf);
  const m09 = rmsMisfitAtObs(g09.field, obs, indexOf);
  const m01 = rmsMisfitAtObs(g01, obs, indexOf);

  // Measured on this fixture: 0.3250 (pass 1), then 0.1566 / 0.0703 / 0.0247
  // for γ = 0.9 / 0.3 / 0.1. The assertions below only pin the ordering and the
  // fact that pass 1 under-fits, so they survive a change of grid or lattice.
  assert.ok(m1 > 0.2, `pass 1 must visibly under-fit a λ=4L wave, got RMS misfit ${m1}`);
  assert.ok(m03 < m1, `pass 2 must tighten: ${m03} !< ${m1}`);
  assert.ok(m09 < m1, `pass 2 must tighten even at γ=0.9: ${m09} !< ${m1}`);
  // D₂ = D₁ + D₁^γ(1 − D₁) is monotonically decreasing in γ, so the misfit is
  // monotonically increasing in γ.
  assert.ok(m01 < m03, `γ=0.1 must fit tighter than γ=0.3: ${m01} !< ${m03}`);
  assert.ok(m03 < m09, `γ=0.3 must fit tighter than γ=0.9: ${m03} !< ${m09}`);
});

test('two-pass response matches the Koch et al. closed form in the domain interior', () => {
  // D₂(λ) = D₁ + D₁^γ(1 − D₁) with D₁ = exp(−π²L²/λ²) is derived for a
  // CONTINUOUS, UNIFORM, unbounded observation density. Here the density is a
  // 1 km lattice (λ = 10 km ⇒ 10 samples per wavelength) truncated at 3L and at
  // the domain edge, so the check is restricted to cells ≥ 3L from the
  // boundary. Measured deviation from the closed form on this fixture: 0.01%
  // (amplitude 0.9223 against D₂ = 0.9222, D₁ = 0.5396). The arithmetic is
  // deterministic, so the 1% tolerance is 100× the observed discretisation
  // error and cannot flake; it is wide enough only to absorb a change of
  // fixture, and tight enough to catch a wrong γ exponent or a dropped pass.
  const h = 1000;
  const n = 81;
  const L = 2500;
  const lambda = 4 * L;
  const gamma = BARNES_GAMMA;
  const xs = axis(n, h);
  const ys = axis(n, h);
  const obs = latticeObs(xs, ys, (x) => Math.sin((2 * Math.PI * x) / lambda), 1);
  const { field } = barnesScalar(obs, xs, ys, L, BARNES_WMIN, gamma);

  const d1 = Math.exp(-(Math.PI * Math.PI * L * L) / (lambda * lambda));
  const d2 = d1 + Math.pow(d1, gamma) * (1 - d1);

  // Least-squares amplitude of the analysed field against the input mode,
  // over interior cells only: A = Σ f·s / Σ s², s = sin(2πx/λ).
  const margin = 8; // 3L = 7.5 km ⇒ 8 cells
  let fs = 0;
  let ss = 0;
  for (let iy = margin; iy < n - margin; iy += 1) {
    for (let ix = margin; ix < n - margin; ix += 1) {
      const s = Math.sin((2 * Math.PI * xs[ix]) / lambda);
      fs += field[iy * n + ix] * s;
      ss += s * s;
    }
  }
  const amplitude = fs / ss;
  assert.ok(
    Math.abs(amplitude - d2) <= 0.01 * d2,
    `analysed amplitude ${amplitude.toFixed(4)} vs predicted D₂ ${d2.toFixed(4)}`,
  );
});

test('barnesVector gives u and v one shared coverage mask', () => {
  const xs = axis(31, 1000);
  const ys = axis(31, 1000);
  const L = 2000;
  const obs = [];
  // A ragged cluster, so the coverage mask has a non-trivial boundary.
  for (let i = 0; i < 40; i += 1) {
    const x = 4000 + (i % 8) * 900;
    const y = 6000 + Math.floor(i / 8) * 1100;
    obs.push({ x, y, u: 0.3 + 1e-5 * x, v: -0.2 + 1e-5 * y, quality: 0.7 });
  }
  const { u, v, weight, used } = barnesVector(obs, xs, ys, L);
  assert.equal(used, obs.length);

  let finite = 0;
  for (let k = 0; k < u.length; k += 1) {
    assert.equal(
      Number.isFinite(u[k]),
      Number.isFinite(v[k]),
      `cell ${k}: u=${u[k]} v=${v[k]} must be finite together`,
    );
    assert.equal(Number.isFinite(u[k]), weight[k] >= BARNES_WMIN);
    if (Number.isFinite(u[k])) finite += 1;
  }
  assert.ok(finite > 0 && finite < u.length, `expected a partial mask, got ${finite}/${u.length}`);
});

test('barnesVector drops a half-finite observation whole, keeping the mask shared', () => {
  const xs = axis(21, 1000);
  const ys = axis(21, 1000);
  const L = 2500;
  const good = [
    { x: 5000, y: 5000, u: 0.4, v: -0.1, quality: 1 },
    { x: 7000, y: 6000, u: 0.5, v: -0.2, quality: 0.6 },
  ];
  // A third observation far from the others with a NaN v: the reference's two
  // independent scalar analyses would have given its neighbourhood a finite u
  // and a NaN v.
  const ragged = [...good, { x: 15000, y: 15000, u: 0.9, v: Number.NaN, quality: 1 }];

  const a = barnesVector(good, xs, ys, L);
  const b = barnesVector(ragged, xs, ys, L);
  assert.equal(b.used, 2, 'the half-finite observation must not be counted as used');
  assert.deepEqual(Array.from(b.weight), Array.from(a.weight));
  assert.deepEqual(Array.from(b.u), Array.from(a.u));
  for (let k = 0; k < b.u.length; k += 1) {
    assert.equal(Number.isFinite(b.u[k]), Number.isFinite(b.v[k]));
  }
});

test('barnesVector agrees bit-for-bit with two barnesScalar runs on complete data', () => {
  const xs = axis(25, 1500);
  const ys = axis(19, 1500);
  const L = 3500;
  const obs = [];
  for (let i = 0; i < 60; i += 1) {
    const x = 2000 + ((i * 7919) % 30000);
    const y = 1500 + ((i * 6271) % 24000);
    obs.push({ x, y, u: Math.sin(i), v: Math.cos(i), quality: 0.4 + (i % 5) / 10 });
  }
  const vec = barnesVector(obs, xs, ys, L);
  const su = barnesScalar(obs.map((o) => ({ x: o.x, y: o.y, value: o.u, quality: o.quality })), xs, ys, L);
  const sv = barnesScalar(obs.map((o) => ({ x: o.x, y: o.y, value: o.v, quality: o.quality })), xs, ys, L);
  // The shared weight pass performs the identical arithmetic in the identical
  // order per component, so this is exact equality, not a tolerance.
  assert.deepEqual(Array.from(vec.u), Array.from(su.field));
  assert.deepEqual(Array.from(vec.v), Array.from(sv.field));
  assert.deepEqual(Array.from(vec.weight), Array.from(su.weight));
});

test('holdoutSplit is deterministic in (obs, frac, seed) and partitions exactly', () => {
  const obs = Array.from({ length: 200 }, (_, i) => ({ id: i }));
  const a = holdoutSplit(obs, 0.12, 7);
  const b = holdoutSplit(obs, 0.12, 7);
  assert.deepEqual(a.holdout.map((o) => o.id), b.holdout.map((o) => o.id));
  assert.deepEqual(a.train.map((o) => o.id), b.train.map((o) => o.id));

  assert.equal(a.holdout.length, 24); // floor(0.12 · 200)
  assert.equal(a.train.length, 176);
  const seen = new Set([...a.holdout, ...a.train].map((o) => o.id));
  assert.equal(seen.size, 200, 'train ∪ holdout must be the whole set, without repeats');

  // Different seeds must give a different partition. With C(200,24) ≈ 10³¹
  // possible holdouts a collision is not a real risk, but this asserts a
  // property of these two specific seeds, not a probabilistic guarantee.
  const c = holdoutSplit(obs, 0.12, 8);
  assert.notDeepEqual(a.holdout.map((o) => o.id), c.holdout.map((o) => o.id));

  // Degenerate fractions are clamped, not thrown at.
  assert.equal(holdoutSplit(obs, 0, 7).holdout.length, 0);
  assert.equal(holdoutSplit(obs, 1, 7).train.length, 0);
  assert.equal(holdoutSplit(obs, 5, 7).holdout.length, 200);
  assert.equal(holdoutSplit([], 0.2, 3).holdout.length, 0);
});

test('validateAnalysis scores a smooth field with small error and a reproducible split', () => {
  const h = 1200;
  const n = 41;
  const xs = axis(n, h);
  const ys = axis(n, h);
  const L = 4000;
  const obs = [];
  for (let j = 0; j < 30; j += 1) {
    for (let i = 0; i < 30; i += 1) {
      const x = 1500 + i * 1500;
      const y = 1500 + j * 1500;
      obs.push({ x, y, u: 0.4 * Math.sin(x / 12000), v: 0.4 * Math.cos(y / 12000), quality: 0.8 });
    }
  }
  const m = validateAnalysis(obs, xs, ys, L, { holdoutFrac: 0.2, seed: 11 });
  const again = validateAnalysis(obs, xs, ys, L, { holdoutFrac: 0.2, seed: 11 });
  assert.deepEqual(again, m);

  assert.equal(m.holdoutCount, 180); // floor(0.2 · 900); every held-out point is covered
  assert.ok(m.coverage > 0.9 && m.coverage <= 1, `coverage ${m.coverage}`);
  // The field varies by ≤ 0.4·(1500/12000) = 0.05 m/s between neighbouring
  // observations, so a Barnes analysis at L = 4000 m must reproduce a withheld
  // vector far inside that. Measured on this fixture: rmseMs 0.00587,
  // maeMs 0.00365, biasU 7.6e-4, biasV −4.6e-4, meanSigmaMs 0.0234. The
  // ceilings below are ~3× those, loose enough to survive a re-seeded split.
  assert.ok(m.rmseMs < 0.02, `holdout RMSE ${m.rmseMs} m/s`);
  assert.ok(m.maeMs < m.rmseMs, 'MAE of a non-degenerate error set is below its RMS');
  assert.ok(Math.abs(m.biasU) < 0.005 && Math.abs(m.biasV) < 0.005, `bias ${m.biasU}, ${m.biasV}`);
  // σ = σ₀/√w with w ≫ 1 under a dense lattice, so the reported error is well
  // below the 0.08 m/s single-vector scale.
  assert.ok(m.meanSigmaMs > 0 && m.meanSigmaMs < 0.08, `mean sigma ${m.meanSigmaMs}`);
});

test('validateAnalysis reports nulls when nothing is held out', () => {
  const xs = axis(11, 1000);
  const ys = axis(11, 1000);
  const obs = [{ x: 5000, y: 5000, u: 0.1, v: 0.2, quality: 1 }];
  const m = validateAnalysis(obs, xs, ys, 2000, { holdoutFrac: 0 });
  assert.equal(m.holdoutCount, 0);
  assert.equal(m.rmseMs, null);
  assert.equal(m.maeMs, null);
  assert.equal(m.biasU, null);
  assert.equal(m.biasV, null);
  assert.equal(m.meanSigmaMs, null);
  assert.ok(m.coverage > 0 && m.coverage < 1);
});

test('empty and unusable observation sets yield an all-NaN field, not an error', () => {
  const xs = axis(9, 1000);
  const ys = axis(9, 1000);
  for (const obs of [
    [],
    [{ x: 1000, y: 1000, value: Number.NaN, quality: 1 }],
    [{ x: 1000, y: 1000, value: 0.5, quality: 0 }],
    [{ x: 1000, y: 1000, value: 0.5, quality: Number.NaN }],
  ]) {
    const { field, weight } = barnesScalar(obs, xs, ys, 2000);
    for (let k = 0; k < field.length; k += 1) {
      assert.ok(Number.isNaN(field[k]));
      assert.equal(weight[k], 0);
    }
  }
});

test('an inadmissible observation is dropped without touching the rest of the analysis', () => {
  // REGRESSION. Every distance test in the sweep is a comparison, and every
  // comparison against NaN is false, so a NaN position defeats both the axis
  // window and the circular cutoff and writes NaN into the denominator of every
  // cell the sweep reaches — the field does not degrade locally, it disappears.
  // An infinite quality is the same failure by another route: Σw = ∞ makes
  // Σwv/Σw = NaN. Measured before the fix on this fixture: NaN x left 5 of 25
  // analysed cells, and quality = +∞ left 0 of 25.
  const xs = axis(11, 1000);
  const ys = axis(11, 1000);
  const L = 2000;
  const clean = [
    { x: 5000, y: 5000, value: 1.5, quality: 1 },
    { x: 6000, y: 4000, value: 1.2, quality: 0.6 },
  ];
  const junk = [
    { x: Number.NaN, y: 0, value: 0.1, quality: 1 },
    { x: 0, y: Number.NaN, value: 0.1, quality: 1 },
    { x: Number.POSITIVE_INFINITY, y: 0, value: 0.1, quality: 1 },
    { x: 0, y: Number.NEGATIVE_INFINITY, value: 0.1, quality: 1 },
    { x: 5000, y: 5000, value: 0.1, quality: Number.POSITIVE_INFINITY },
    { x: 5000, y: 5000, value: 0.1, quality: Number.NaN },
    { x: 5000, y: 5000, value: 0.1, quality: 0 },
    { x: 5000, y: 5000, value: 0.1, quality: -1 },
    { x: 5000, y: 5000, value: Number.NaN, quality: 1 },
    { x: 5000, y: 5000, value: Number.POSITIVE_INFINITY, quality: 1 },
    null,
    undefined,
  ];

  const good = barnesScalar(clean, xs, ys, L);
  let analysed = 0;
  for (let k = 0; k < good.field.length; k += 1) if (Number.isFinite(good.field[k])) analysed += 1;
  assert.ok(analysed > 0, 'the clean fixture must analyse something to be a control');

  // Interleaved, so a bad observation runs both before and after a good one.
  const mixed = [];
  for (let i = 0; i < junk.length; i += 1) {
    mixed.push(junk[i]);
    if (i < clean.length) mixed.push(clean[i]);
  }
  const withJunk = barnesScalar(mixed, xs, ys, L);
  // Bit-identical, not merely close: a dropped observation must leave no trace
  // in either the field or the integrated weight.
  assert.deepEqual(Array.from(withJunk.field), Array.from(good.field));
  assert.deepEqual(Array.from(withJunk.weight), Array.from(good.weight));

  // Same for the vector path, which has its own admission test.
  const cleanV = clean.map((o) => ({ x: o.x, y: o.y, u: o.value, v: -o.value, quality: o.quality }));
  const junkV = junk.map((o) => (o ? { x: o.x, y: o.y, u: o.value, v: -o.value, quality: o.quality } : o));
  const goodV = barnesVector(cleanV, xs, ys, L);
  const mixedV = barnesVector([...junkV, ...cleanV], xs, ys, L);
  assert.equal(mixedV.used, goodV.used);
  assert.deepEqual(Array.from(mixedV.u), Array.from(goodV.u));
  assert.deepEqual(Array.from(mixedV.v), Array.from(goodV.v));
  assert.deepEqual(Array.from(mixedV.weight), Array.from(goodV.weight));
});

test('used counts observations that deposited weight, not those that passed admission', () => {
  const xs = axis(11, 1000);
  const ys = axis(11, 1000);
  const L = 2000; // 3L = 6 km truncation
  const inside = { x: 5000, y: 5000, u: 0.3, v: -0.2, quality: 1 };
  // Admissible, finite, well-formed — and 500 km away, so its kernel never
  // reaches a single cell. It informed nothing and must not be counted.
  const faraway = { x: 500000, y: 500000, u: 9, v: 9, quality: 1 };
  // Outside the grid but within 3L of its edge: this one DOES contribute.
  const fringe = { x: -3000, y: 2000, u: 0.1, v: 0.1, quality: 1 };

  assert.equal(barnesVector([inside], xs, ys, L).used, 1);
  assert.equal(barnesVector([inside, faraway], xs, ys, L).used, 1);
  assert.equal(barnesVector([faraway], xs, ys, L).used, 0);
  assert.equal(barnesVector([inside, fringe], xs, ys, L).used, 2);

  // The far observation must also leave the field bit-identical.
  const a = barnesVector([inside], xs, ys, L);
  const b = barnesVector([inside, faraway], xs, ys, L);
  assert.deepEqual(Array.from(b.u), Array.from(a.u));
  assert.deepEqual(Array.from(b.weight), Array.from(a.weight));
});

test('validateAnalysis refuses to score held-out observations the analysis would reject', () => {
  // A held-out vector with quality 0 is QC-rejected: it never enters training,
  // so scoring the field against it measures the field against data the module
  // deliberately refuses to trust. Here the rejects carry a 100 m/s velocity, so
  // if even one were scored the RMSE would jump by orders of magnitude.
  const n = 41;
  const h = 1200;
  const xs = axis(n, h);
  const ys = axis(n, h);
  const L = 4000;
  const obs = [];
  for (let j = 0; j < 24; j += 1) {
    for (let i = 0; i < 24; i += 1) {
      const x = 1500 + i * 1800;
      const y = 1500 + j * 1800;
      obs.push({ x, y, u: 0.4 * Math.sin(x / 12000), v: 0.4 * Math.cos(y / 12000), quality: 0.8 });
    }
  }
  const clean = obs.length;
  for (let i = 0; i < 120; i += 1) {
    obs.push({ x: 2000 + (i % 20) * 2000, y: 2000 + Math.floor(i / 20) * 2000, u: 100, v: -100, quality: 0 });
  }

  const m = validateAnalysis(obs, xs, ys, L, { holdoutFrac: 0.3, seed: 5 });

  // The split is deterministic in (n, frac, seed), so the expected population is
  // computable exactly rather than bounded: it is the admissible share of the
  // holdout the same call made internally.
  const { holdout } = holdoutSplit(obs, 0.3, 5);
  const admissible = holdout.filter((o) => o.quality > 0).length;
  assert.equal(holdout.length, Math.floor(0.3 * obs.length));
  assert.ok(admissible < holdout.length, 'the fixture must actually hold out some rejects');
  assert.equal(m.holdoutCount, admissible, 'only admissible held-out observations may be scored');

  // Scoring even one 100 m/s reject would put the RMSE above 5 m/s.
  assert.ok(m.rmseMs < 0.05, `holdout RMSE ${m.rmseMs} m/s — a QC reject leaked into the score`);
  assert.ok(Math.abs(m.biasU) < 0.01 && Math.abs(m.biasV) < 0.01, `bias ${m.biasU}, ${m.biasV}`);
  // The rejects never entered training either, so coverage comes from the clean
  // lattice alone.
  assert.ok(m.coverage > 0.9, `coverage ${m.coverage}`);
  assert.equal(obs.length - clean, 120);
});

test('degenerate single-row, single-column and single-cell grids analyse without throwing', () => {
  const L = 2000;
  const obs = [
    { x: 2000, y: 2000, value: 0.8, quality: 1 },
    { x: 3000, y: 3000, value: 0.8, quality: 1 },
  ];

  // nx = 1: exercises the sampleBilinear branch where the x stencil collapses.
  const col = barnesScalar(obs, Float64Array.from([2000]), axis(6, 1000), L);
  assert.equal(col.field.length, 6);
  for (let k = 0; k < col.field.length; k += 1) {
    if (Number.isFinite(col.field[k])) assert.ok(Math.abs(col.field[k] - 0.8) < 1e-12);
  }
  assert.ok(col.field.some((x) => Number.isFinite(x)), 'the column must be analysed somewhere');

  // ny = 1.
  const row = barnesScalar(obs, axis(6, 1000), Float64Array.from([2000]), L);
  assert.equal(row.field.length, 6);
  assert.ok(row.field.some((x) => Number.isFinite(x)));

  // 1x1: both stencils collapse at once.
  const one = barnesVector(
    [{ x: 2000, y: 2000, u: 0.5, v: -0.25, quality: 1 }],
    Float64Array.from([2000]),
    Float64Array.from([2000]),
    L,
  );
  assert.equal(one.u.length, 1);
  assert.equal(one.used, 1);
  assert.ok(Math.abs(one.u[0] - 0.5) < 1e-15 && Math.abs(one.v[0] + 0.25) < 1e-15);
  assert.equal(one.weight[0], 1);
});

test('plain number[] axes are accepted and give bit-identical results to Float64Array', () => {
  // The JSDoc advertises Float64Array|number[]; nothing else in the suite passes
  // a plain array, so the Float64Array.from copy path was untested.
  const L = 2500;
  const xsArr = [0, 1000, 2000, 3000, 4000, 5000];
  const ysArr = [0, 1500, 3000, 4500];
  const obs = [
    { x: 1200, y: 900, u: 0.4, v: -0.1, quality: 0.7 },
    { x: 3600, y: 2600, u: -0.2, v: 0.35, quality: 1 },
  ];
  const typed = barnesVector(obs, Float64Array.from(xsArr), Float64Array.from(ysArr), L);
  const plain = barnesVector(obs, xsArr, ysArr, L);
  assert.deepEqual(Array.from(plain.u), Array.from(typed.u));
  assert.deepEqual(Array.from(plain.v), Array.from(typed.v));
  assert.deepEqual(Array.from(plain.weight), Array.from(typed.weight));
  assert.equal(plain.used, typed.used);
  // And a plain array is validated the same way.
  assert.throws(() => barnesScalar(obs, [0, 1000, 500], ysArr, L), /strictly increasing/);
});

test('malformed axes and parameters are refused, including flattened per-cell coordinates', () => {
  const xs = axis(5, 1000);
  const ys = axis(4, 1000);
  const obs = [{ x: 0, y: 0, value: 1, quality: 1 }];

  // The reference implementation's calling convention: one coordinate per
  // cell, so the x array repeats each row. That must fail loudly rather than
  // be silently misread as an axis.
  const flatX = Float64Array.from([0, 1000, 2000, 0, 1000, 2000]);
  const flatY = Float64Array.from([0, 0, 0, 1000, 1000, 1000]);
  assert.throws(() => barnesScalar(obs, flatX, flatY, 2000), /strictly increasing/);

  assert.throws(() => barnesScalar(obs, Float64Array.from([0, Number.NaN]), ys, 2000), /not finite/);
  assert.throws(() => barnesScalar(obs, new Float64Array(0), ys, 2000), /non-empty/);
  assert.throws(() => barnesScalar(obs, xs, ys, 0), /positive finite/);
  assert.throws(() => barnesScalar(obs, xs, ys, -1), /positive finite/);
  assert.throws(() => barnesScalar(obs, xs, ys, 2000, -0.1), /non-negative/);
  assert.throws(() => barnesScalar(obs, xs, ys, 2000, 0.1, 0), /\(0, 1\]/);
  assert.throws(() => barnesScalar(obs, xs, ys, 2000, 0.1, 1.5), /\(0, 1\]/);
  assert.throws(() => barnesVector([], xs, ys, 2000, { gamma: 2 }), /\(0, 1\]/);
});

test('toNullable replaces voids with null and keeps finite values identical', () => {
  const f = Float64Array.from([0.5, Number.NaN, -1.25, Number.POSITIVE_INFINITY]);
  assert.deepEqual(toNullable(f), [0.5, null, -1.25, null]);
});

test('a full-size workload finishes well inside the per-request budget', () => {
  // The production shape stated by the ocean service: ~2000 quality-controlled
  // HF-radar vectors onto a 120×120 analysis grid. This is a smoke test against
  // an accidental O(n_obs·n_cells) regression — the reference's per-observation
  // full-grid sweep plus its full-grid nearest-cell scan would be 2·2.88e7
  // inner iterations and 2.88e7 `exp` calls here — not a benchmark. Measured
  // 22 ms on the development box (Node 24, WSL2 / Ryzen 9800X3D); the 3000 ms
  // bound is 136× that, so a loaded or throttled CI box cannot flake it.
  const n = 120;
  const h = 1000;
  const xs = axis(n, h);
  const ys = axis(n, h);
  const L = 8000;
  const obs = [];
  for (let i = 0; i < 2000; i += 1) {
    const x = ((i * 7919) % 119000) + 500;
    const y = ((i * 104729) % 119000) + 500;
    obs.push({ x, y, u: 0.5 * Math.sin(x / 20000), v: 0.5 * Math.cos(y / 20000), quality: 0.75 });
  }

  const t0 = process.hrtime.bigint();
  const { u, v, weight } = barnesVector(obs, xs, ys, L);
  const ms = Number(process.hrtime.bigint() - t0) / 1e6;

  let covered = 0;
  for (let k = 0; k < u.length; k += 1) {
    if (Number.isFinite(u[k])) covered += 1;
    assert.equal(Number.isFinite(u[k]), Number.isFinite(v[k]));
    assert.ok(weight[k] >= 0);
  }
  assert.ok(covered > 0.95 * u.length, `expected near-full coverage, got ${covered}/${u.length}`);
  assert.ok(ms < 3000, `120×120 grid with 2000 observations took ${ms.toFixed(1)} ms`);
});
