/**
 * @file Two-pass Barnes successive-correction objective analysis: scattered
 * current observations (HF radar radial totals, drifters, ship ADCP) → a
 * gridded velocity field with an explicit coverage mask.
 *
 * METHOD. Observations carry a position (x, y) in METRES on a local tangent
 * plane — this module never sees degrees; the caller projects. Each grid cell
 * accumulates a Gaussian-weighted mean of the observations around it:
 *
 *   pass 1:  w  = q · exp(−r²/L²)                     r = |x_cell − x_obs|
 *            f₁ = Σ w v / Σ w                          (Barnes 1964, 1973)
 *   pass 2:  L₂ = L·√γ,  ε = v − f₁(x_obs)
 *            f₂ = f₁ + Σ w₂ ε / Σ w₂                   (Koch et al. 1983)
 *
 * `q` is a per-observation quality multiplier in (0, 1] — for HF radar the
 * caller typically sets q = 1/(1 + hdop), so a poor geometric dilution of
 * precision down-weights rather than rejects. The kernel is truncated at
 * r > 3L; the discarded tail of the 2-D Gaussian is exactly exp(−9) = 1.234e−4
 * of its mass (∫₃ᴸ^∞ 2πr e^(−r²/L²)dr ÷ ∫₀^∞ …), i.e. 0.012%, which is far
 * below the observation noise floor (σ₀ ≈ 0.08 m/s) and buys a bounded
 * per-observation cost.
 *
 * SPECTRAL RESPONSE. For a continuous, uniform observation density the 2-D
 * transform of exp(−r²/L²) is πL²·exp(−k²L²/4); normalised to unity at k = 0
 * and evaluated at k = 2π/λ this gives the single-pass response
 *
 *   D₁(λ) = exp(−π²L²/λ²),   D₂(λ) = D₁ + D₁^γ (1 − D₁)
 *
 * because pass 2 analyses the residual (1 − D₁)f̂ with a kernel of scale √γ·L,
 * whose response is D₁^γ. With γ = 0.3 and L = 10 km: a λ = 20 km wave is cut
 * to D₁ = 0.085 by one pass and restored to D₂ = 0.521 by two; λ = 50 km goes
 * 0.674 → 0.964. That is the entire point of the second pass — it recovers
 * amplitude at the resolvable scales without shrinking L (which would let
 * noise through at the unresolvable ones). γ ∈ [0.2, 1.0] per Koch et al.;
 * γ = 0.3 is inherited from the reference project's `src/lib/ocean/domain.ts`.
 *
 * GRID CONVENTION — note for integrators, this deviates from the reference.
 * `xs` and `ys` are the SEPARABLE, strictly increasing 1-D axes of a
 * rectilinear grid: `xs` has one entry per column (length nx), `ys` one per row
 * (length ny), and every returned field is row-major with `k = iy·nx + ix`,
 * length nx·ny. The reference implementation instead passed two flattened
 * per-cell coordinate arrays of length nx·ny. Separable axes are required
 * here, for two reasons:
 *   (a) bilinear sampling of the pass-1 field (see IMPROVEMENT 1) is only
 *       defined on a structured grid;
 *   (b) the 3L cutoff becomes an index range per axis instead of a full scan
 *       of every cell, and the Gaussian factorises,
 *       exp(−r²/L²) = exp(−dx²/L²)·exp(−dy²/L²), so an observation costs
 *       nx + ny transcendental calls instead of nx·ny. On the 120×120 grid
 *       this replaces 14 400 `exp` calls per observation with 240. (The
 *       product of two exps differs from the exp of the sum by ≤ 2 ulp —
 *       nothing next to the O(1) modelling error in the kernel choice.)
 * Passing flattened per-cell arrays here is caught: they are not strictly
 * increasing, and the axis validation throws.
 *
 * IMPROVEMENTS OVER THE REFERENCE (`src/lib/ocean/barnes.ts`), deliberate:
 *   1. Pass 2 needs f₁(x_obs). The reference took the NEAREST grid cell, which
 *      quantises every residual by up to half a cell diagonal times the local
 *      gradient. On the 2 km HF-radar product that is 1 km × a 2.5e−5 s⁻¹ shear
 *      — the scale of a 0.5 m/s current turning over 20 km — i.e. 0.025 m/s of
 *      spurious correction, a third of the σ₀ = 0.08 m/s observation error, and
 *      it is injected as a *systematic* field, not noise that averages out.
 *      Here f₁ is bilinearly interpolated; nearest is used only where the
 *      stencil runs off the grid edge. The test suite measures the difference
 *      directly: on an exactly linear field, bilinear recovers it to 6.7e−16
 *      m/s while nearest-cell sampling is off by 4.5e−3 m/s.
 *   2. The reference's pass-2 loop ran the full cell sweep before discovering
 *      that f₁(x_obs) was NaN (observation outside the analysed region). That
 *      test is hoisted above the cell loop.
 *   3. Its nearest-cell lookup was itself an O(n_cells) linear scan inside the
 *      per-observation loop — O(n_obs·n_cells) just to find an index. Binary
 *      search on the axes makes it O(n_obs·log n).
 *   4. `barnesVector` shares ONE weight pass between u and v. The reference ran
 *      two independent scalar analyses; if a QC step left u finite and v not on
 *      the same observation, the two coverage masks disagreed and a cell could
 *      report a half-defined vector. Here an observation with either component
 *      non-finite is dropped whole, so u and v provably share a mask.
 *   5. The holdout RNG draws from the HIGH bits of the LCG state. Low-order
 *      bits of a power-of-two-modulus LCG have period 2^(k+1) for bit k
 *      (Knuth, TAOCP vol. 2 §3.2.1.1), and the reference's `state % (i + 1)`
 *      read exactly those.
 *
 * Cells whose integrated pass-1 weight is below `wMin` stay NaN. This module
 * never extrapolates into a data void and never invents a value on land — it
 * has no land mask at all; masking is the caller's job.
 *
 * ADMISSION. An observation enters the analysis only if its position, its
 * quality and every component it carries are finite, and its quality is
 * strictly positive; see {@link admissible}. This is not defensive
 * decoration — the Gaussian sweep is a running sum, so a single inadmissible
 * observation is not a locally wrong value but a globally destroyed one:
 *   - `x` or `y` NaN. Every distance test is `dx > cut` / `dx² + dy² > cutSq`,
 *     and every comparison against NaN is false, so neither the axis-window
 *     break nor the circular cutoff ever fires: the sweep writes NaN into the
 *     denominator of every cell it reaches. Measured on an 11×11 grid at
 *     L = 2 km, one NaN-x observation next to one good one cut the analysed
 *     cells from 25 to 5, silently.
 *   - `quality` +∞. `!(q > 0)` does not catch it; `w = ∞` makes `Σw = ∞` and
 *     `Σwv/Σw = ∞/∞ = NaN`, taking the same 11×11 fixture from 25 analysed
 *     cells to 0.
 * Both are realistic: they are what an unparsed CSV field, an out-of-range
 * projection or a divide-by-zero quality model produces upstream. They are
 * dropped, never repaired — this module never substitutes a value for missing
 * data, and a caller that wants to know how many observations survived reads
 * `used` from {@link barnesVector}.
 *
 * Sources:
 * - Barnes, S.L. (1964): A technique for maximizing details in numerical
 *   weather map analysis. J. Appl. Meteor. 3(4), 396–409.
 * - Barnes, S.L. (1973): Mesoscale objective map analysis using weighted
 *   time-series observations. NOAA Tech. Memo. ERL NSSL-62.
 * - Koch, S.E., M. DesJardins & P.J. Kocin (1983): An interactive Barnes
 *   objective map analysis scheme for use with satellite and conventional
 *   data. J. Climate Appl. Meteor. 22(9), 1487–1503 — the two-pass γ
 *   formulation and the response function D₂ = D₁ + D₁^γ(1 − D₁).
 * - Knuth, D.E.: The Art of Computer Programming vol. 2, §3.2.1.1 — LCG
 *   low-order bits; §3.4.2 — Fisher–Yates shuffle.
 *
 * @module server/ocean/barnes
 */

/**
 * @const {number} Minimum integrated pass-1 weight for a cell to be analysed.
 * Inherited verbatim from the reference project's `src/lib/ocean/domain.ts`
 * (`BARNES_WMIN`); with q ≈ 0.7 it corresponds to roughly one good observation
 * inside ~1.1 L of the cell. Re-export from a shared domain module if the
 * integration grows one.
 */
export const BARNES_WMIN = 0.12;

/**
 * @const {number} Pass-2 length-scale reduction: L₂ = L·√γ. 0.3 is inherited
 * from the reference project's `domain.ts` and sits inside the [0.2, 1.0] band
 * Koch, DesJardins & Kocin (1983) recommend.
 */
export const BARNES_GAMMA = 0.3;

/**
 * @const {number} Nominal HF-radar total-vector error, m/s, at unit integrated
 * weight; the analysis error estimate is σ = HFR_SIGMA0/√w. Inherited from the
 * reference project's `domain.ts` (`HFR_SIGMA0`).
 */
export const HFR_SIGMA0 = 0.08;

/** @const {number} Kernel truncation radius in units of L. exp(−9) of the mass is dropped. */
const CUTOFF_L = 3;

/**
 * Whether an observation carries a usable position and weight.
 *
 * Requires a finite `x` and `y` and a finite, strictly positive `quality`; also
 * refuses a null/undefined array element, so a sparse observation array does not
 * throw mid-sweep. It deliberately does NOT look at the value components —
 * `barnesScalar` and `barnesVector` carry different ones and each adds its own
 * finiteness test — and it does not clamp `quality` to (0, 1]: a caller using an
 * un-normalised inverse-variance weight is doing something legitimate, and only
 * the ratio of weights matters to Σwv/Σw.
 *
 * @param {{x: number, y: number, quality: number}|null|undefined} o - Candidate observation.
 * @returns {boolean} True if the observation may enter a Gaussian sweep.
 */
function admissible(o) {
  return !!o
    && Number.isFinite(o.x)
    && Number.isFinite(o.y)
    && Number.isFinite(o.quality)
    && o.quality > 0;
}

/**
 * Coerce an axis to Float64Array and assert it is a usable rectilinear axis.
 *
 * Refuses non-finite entries and any pair that is not strictly increasing —
 * which is also what catches a caller passing the reference project's
 * flattened per-cell coordinate arrays instead of separable axes.
 *
 * @param {Float64Array|number[]} axis - Candidate coordinate axis, metres.
 * @param {string} name - Parameter name, for the error message.
 * @returns {Float64Array} The axis as a Float64Array (copied if it was not one).
 */
function toAxis(axis, name) {
  if (!axis || typeof axis.length !== 'number' || axis.length < 1) {
    throw new TypeError(`${name} must be a non-empty array of coordinates in metres`);
  }
  const out = axis instanceof Float64Array ? axis : Float64Array.from(axis);
  for (let i = 0; i < out.length; i += 1) {
    if (!Number.isFinite(out[i])) throw new RangeError(`${name}[${i}] is not finite`);
    if (i > 0 && !(out[i] > out[i - 1])) {
      throw new RangeError(
        `${name} must be strictly increasing (${name}[${i - 1}]=${out[i - 1]} >= ${name}[${i}]=${out[i]}); `
        + 'barnes expects separable 1-D grid axes, not flattened per-cell coordinates',
      );
    }
  }
  return out;
}

/**
 * First index `i` with `axis[i] >= v`, by binary search.
 *
 * @param {Float64Array} axis - Strictly increasing coordinates.
 * @param {number} v - Query coordinate.
 * @returns {number} Index in [0, axis.length]; axis.length when v exceeds the axis.
 */
function lowerBound(axis, v) {
  let lo = 0;
  let hi = axis.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (axis[mid] < v) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/**
 * Index of the cell whose interval `[axis[i], axis[i+1]]` contains `v`.
 *
 * Clamps outside the axis, so a query beyond an edge degenerates to the edge
 * interval and the caller's fraction clamp turns bilinear into nearest there.
 *
 * @param {Float64Array} axis - Strictly increasing coordinates.
 * @param {number} v - Query coordinate.
 * @returns {number} Index in [0, max(0, axis.length - 2)].
 */
function cellIndex(axis, v) {
  const n = axis.length;
  if (n < 2) return 0;
  if (v <= axis[0]) return 0;
  if (v >= axis[n - 1]) return n - 2;
  return lowerBound(axis, v) - 1;
}

/**
 * Bilinearly sample a possibly-holed field at an arbitrary point.
 *
 * IMPROVEMENT 1 over the reference, which sampled the nearest cell. Corners
 * that are NaN (cells below `wMin`) are dropped and the remaining bilinear
 * weights renormalised; with all four corners finite this is exact bilinear
 * interpolation, and with exactly one finite corner it reduces to that corner —
 * i.e. it is never worse than nearest-finite. Outside the grid the fractional
 * coordinate is clamped, which makes the sample nearest along that axis. It is
 * discontinuous across a cell boundary where the void mask changes; that is
 * unavoidable at the edge of a data void and only affects observations sitting
 * in the void's fringe.
 *
 * Refuses a non-finite query point by returning NaN rather than clamping it to
 * an edge cell: clamping would answer a question the caller did not ask, and
 * `cellIndex` cannot order NaN, so it would fall through to index −1 and read
 * past the start of the field. (A Float64Array returns `undefined` out of
 * bounds, and `undefined === undefined` passes a `v === v` NaN test, so the
 * corner tests below use `Number.isFinite`, which drops an out-of-range or
 * infinite corner instead of poisoning the sum with it.)
 *
 * @param {Float64Array} field - Row-major values, length nx*ny, NaN in voids.
 * @param {Float64Array} xs - Column axis, metres, strictly increasing.
 * @param {Float64Array} ys - Row axis, metres, strictly increasing.
 * @param {number} x - Sample abscissa, metres.
 * @param {number} y - Sample ordinate, metres.
 * @returns {number} Interpolated value; NaN if the query point is not finite or
 *   every contributing corner is a void.
 */
function sampleBilinear(field, xs, ys, x, y) {
  if (!Number.isFinite(x) || !Number.isFinite(y)) return Number.NaN;
  const nx = xs.length;
  const ny = ys.length;
  const ix = cellIndex(xs, x);
  const iy = cellIndex(ys, y);
  const ix1 = nx > 1 ? ix + 1 : ix;
  const iy1 = ny > 1 ? iy + 1 : iy;
  let tx = nx > 1 ? (x - xs[ix]) / (xs[ix + 1] - xs[ix]) : 0;
  let ty = ny > 1 ? (y - ys[iy]) / (ys[iy + 1] - ys[iy]) : 0;
  // Clamping is the documented "nearest at the grid edge" fallback.
  if (!(tx > 0)) tx = 0;
  else if (tx > 1) tx = 1;
  if (!(ty > 0)) ty = 0;
  else if (ty > 1) ty = 1;

  const k00 = iy * nx + ix;
  const k10 = iy * nx + ix1;
  const k01 = iy1 * nx + ix;
  const k11 = iy1 * nx + ix1;
  const w00 = (1 - tx) * (1 - ty);
  const w10 = tx * (1 - ty);
  const w01 = (1 - tx) * ty;
  const w11 = tx * ty;

  let sum = 0;
  let wsum = 0;
  const v00 = field[k00];
  if (Number.isFinite(v00)) { sum += w00 * v00; wsum += w00; }
  const v10 = field[k10];
  if (Number.isFinite(v10)) { sum += w10 * v10; wsum += w10; }
  const v01 = field[k01];
  if (Number.isFinite(v01)) { sum += w01 * v01; wsum += w01; }
  const v11 = field[k11];
  if (Number.isFinite(v11)) { sum += w11 * v11; wsum += w11; }
  return wsum > 0 ? sum / wsum : Number.NaN;
}

/**
 * Validate the shared analysis parameters and return the derived constants.
 *
 * @param {number} L - Pass-1 length scale, metres. Must be finite and positive.
 * @param {number} wMin - Coverage threshold on the integrated pass-1 weight.
 * @param {number} gamma - Pass-2 scale factor, L₂ = L√γ. Must lie in (0, 1].
 * @returns {{L2: number, invL2: number, invL22: number, cutP1: number, cutP2: number}}
 *   Pass-2 length scale, both inverse squared scales, and both truncation radii.
 */
function analysisScales(L, wMin, gamma) {
  if (!Number.isFinite(L) || L <= 0) {
    throw new RangeError(`length scale L must be a positive finite number of metres, received ${L}`);
  }
  if (!Number.isFinite(wMin) || wMin < 0) {
    throw new RangeError(`wMin must be a finite non-negative weight, received ${wMin}`);
  }
  // gamma > 1 would make pass 2 broader than pass 1 — a second smoothing rather
  // than a correction, which inverts the method.
  if (!Number.isFinite(gamma) || gamma <= 0 || gamma > 1) {
    throw new RangeError(`gamma must lie in (0, 1], received ${gamma}`);
  }
  const L2 = L * Math.sqrt(gamma);
  return {
    L2,
    invL2: 1 / (L * L),
    invL22: 1 / (L2 * L2),
    cutP1: CUTOFF_L * L,
    cutP2: CUTOFF_L * L2,
  };
}

/**
 * One Gaussian accumulation sweep for a single observation.
 *
 * Adds `w·values[c]` into `nums[c]` and `w` into `den` for every grid cell
 * within the truncation radius, sharing one weight across however many
 * components are supplied. The x factors are precomputed once per observation
 * into caller-owned scratch, so the cell loop performs no `exp` and allocates
 * nothing.
 *
 * @param {Float64Array[]} nums - Numerator accumulators, one per component, row-major.
 * @param {number[]} values - Component values for this observation, same order as `nums`.
 * @param {Float64Array} den - Shared denominator accumulator, row-major.
 * @param {Float64Array} xs - Column axis, metres.
 * @param {Float64Array} ys - Row axis, metres.
 * @param {number} ox - Observation abscissa, metres.
 * @param {number} oy - Observation ordinate, metres.
 * @param {number} q - Quality multiplier, > 0.
 * @param {number} invLL - 1/L² for the sweep's length scale.
 * @param {number} cut - Truncation radius, metres.
 * @param {Float64Array} exScratch - Scratch of length nx for exp(−dx²/L²).
 * @param {Float64Array} dx2Scratch - Scratch of length nx for dx².
 * @param {Float64Array|null} gate - If given, cells where `gate[c]` is NaN are skipped.
 * @returns {boolean} True if the sweep deposited weight into at least one cell.
 *   False when the observation lies more than `cut` from the whole grid, or when
 *   every cell inside its kernel was gated away — either way it contributed
 *   nothing and must not be counted as used. Callers guarantee `ox`, `oy` and
 *   `q` are finite (see {@link admissible}); the distance tests here are
 *   comparisons, which NaN would silently pass.
 */
function accumulate(nums, values, den, xs, ys, ox, oy, q, invLL, cut, exScratch, dx2Scratch, gate) {
  const nx = xs.length;
  const ny = ys.length;
  const cutSq = cut * cut;
  const ix0 = lowerBound(xs, ox - cut);
  let ixEnd = ix0;
  while (ixEnd < nx) {
    const dx = xs[ixEnd] - ox;
    if (dx > cut) break;
    const d2 = dx * dx;
    dx2Scratch[ixEnd] = d2;
    exScratch[ixEnd] = Math.exp(-d2 * invLL);
    ixEnd += 1;
  }
  if (ixEnd === ix0) return false;

  const nComp = nums.length;
  const iy0 = lowerBound(ys, oy - cut);
  let touched = false;
  for (let iy = iy0; iy < ny; iy += 1) {
    const dy = ys[iy] - oy;
    if (dy > cut) break;
    const dy2 = dy * dy;
    const ey = q * Math.exp(-dy2 * invLL);
    const row = iy * nx;
    for (let ix = ix0; ix < ixEnd; ix += 1) {
      if (dx2Scratch[ix] + dy2 > cutSq) continue;
      const c = row + ix;
      if (gate !== null && gate[c] !== gate[c]) continue;
      const w = ey * exScratch[ix];
      for (let m = 0; m < nComp; m += 1) nums[m][c] += w * values[m];
      den[c] += w;
      touched = true;
    }
  }
  return touched;
}

/**
 * Two-pass Barnes analysis of a scalar field.
 *
 * Observations with a non-finite position, a non-positive or non-finite quality,
 * or a non-finite value are silently skipped — they carry no information, and
 * left in they do not merely bias a cell but destroy the whole analysis (see
 * ADMISSION in the `@file` block). A null element of `obs` is skipped too. An
 * empty observation set is not an error: it yields an all-NaN field with zero
 * weight everywhere. Cells whose integrated pass-1 weight is below `wMin` stay
 * NaN in both passes; the analysis never extrapolates into a data void.
 *
 * @param {{x: number, y: number, value: number, quality: number}[]} obs -
 *   Observations, positions in METRES on a local tangent plane; `quality` is an
 *   inverse-variance multiplier in (0, 1].
 * @param {Float64Array|number[]} xs - Strictly increasing column axis, metres (length nx).
 * @param {Float64Array|number[]} ys - Strictly increasing row axis, metres (length ny).
 * @param {number} L - Pass-1 length scale, metres.
 * @param {number} [wMin=BARNES_WMIN] - Minimum integrated pass-1 weight for coverage.
 * @param {number} [gamma=BARNES_GAMMA] - Pass-2 scale factor, L₂ = L√γ, in (0, 1].
 * @returns {{field: Float64Array, weight: Float64Array}} `field` is the two-pass
 *   analysis, row-major `k = iy*nx + ix`, NaN where uncovered; `weight` is the
 *   integrated pass-1 weight at every cell (reported even below `wMin`, so a
 *   caller can see how close a void came to being filled).
 * @throws {RangeError} If an axis is not strictly increasing and finite, if L is
 *   not positive, or if gamma is outside (0, 1].
 */
export function barnesScalar(obs, xs, ys, L, wMin = BARNES_WMIN, gamma = BARNES_GAMMA) {
  const ax = toAxis(xs, 'xs');
  const ay = toAxis(ys, 'ys');
  const { invL2, invL22, cutP1, cutP2 } = analysisScales(L, wMin, gamma);
  const nx = ax.length;
  const n = nx * ay.length;

  // `field` doubles as the pass-1 store: pass 2 only reads it (through the
  // bilinear sampler and the void gate) until every correction is accumulated.
  const field = new Float64Array(n).fill(Number.NaN);
  const weight = new Float64Array(n);
  const num = new Float64Array(n);
  const den = new Float64Array(n);
  const exScratch = new Float64Array(nx);
  const dx2Scratch = new Float64Array(nx);
  const nums = [num];
  const vals = [0];
  if (!obs || obs.length === 0) return { field, weight };

  for (let k = 0; k < obs.length; k += 1) {
    const o = obs[k];
    if (!admissible(o) || !Number.isFinite(o.value)) continue;
    vals[0] = o.value;
    accumulate(nums, vals, den, ax, ay, o.x, o.y, o.quality, invL2, cutP1, exScratch, dx2Scratch, null);
  }
  for (let c = 0; c < n; c += 1) {
    weight[c] = den[c];
    if (den[c] >= wMin) field[c] = num[c] / den[c];
  }

  num.fill(0);
  den.fill(0);
  for (let k = 0; k < obs.length; k += 1) {
    const o = obs[k];
    if (!admissible(o) || !Number.isFinite(o.value)) continue;
    const f1 = sampleBilinear(field, ax, ay, o.x, o.y);
    // IMPROVEMENT 2: hoisted above the cell sweep. An observation outside the
    // analysed region has no residual to distribute, so it must not cost a
    // sweep over the grid.
    if (!Number.isFinite(f1)) continue;
    vals[0] = o.value - f1;
    accumulate(nums, vals, den, ax, ay, o.x, o.y, o.quality, invL22, cutP2, exScratch, dx2Scratch, field);
  }
  for (let c = 0; c < n; c += 1) {
    if (den[c] > 0 && field[c] === field[c]) field[c] += num[c] / den[c];
  }
  return { field, weight };
}

/**
 * Two-pass Barnes analysis of a 2-D vector field, u and v sharing one weight pass.
 *
 * IMPROVEMENT 4: the Gaussian weights depend only on geometry, so computing
 * them once for both components is both cheaper than two scalar analyses
 * (measured 14.8 ms vs 24.4 ms — 39% — for 2000 observations on a 120×120 grid
 * at L = 8 km, Node 24, mean of 15 runs after 5 warm-ups) and the only way to
 * *guarantee* that u and v share a coverage mask. An
 * observation whose u or v is non-finite is dropped entirely rather than
 * contributing to one component's denominator but not the other's — after which
 * `Number.isFinite(u[k]) === Number.isFinite(v[k])` holds at every cell by
 * construction.
 *
 * @param {{x: number, y: number, u: number, v: number, quality: number}[]} obs -
 *   Observations, positions in METRES on a local tangent plane; u east, v north,
 *   m/s; `quality` an inverse-variance multiplier in (0, 1].
 * @param {Float64Array|number[]} xs - Strictly increasing column axis, metres (length nx).
 * @param {Float64Array|number[]} ys - Strictly increasing row axis, metres (length ny).
 * @param {number} L - Pass-1 length scale, metres.
 * @param {{wMin?: number, gamma?: number}} [opts] - Coverage threshold and pass-2 scale factor.
 * Observations with a non-finite position, a non-positive or non-finite quality,
 * or either component non-finite are skipped whole (see ADMISSION in the `@file`
 * block); a null element of `obs` is skipped too.
 *
 * @returns {{u: Float64Array, v: Float64Array, weight: Float64Array, used: number}}
 *   Row-major fields (`k = iy*nx + ix`) with a shared NaN mask, the integrated
 *   pass-1 weight, and `used` — the number of observations that actually
 *   deposited pass-1 weight into at least one grid cell. `used` therefore
 *   excludes both the inadmissible observations and the admissible ones lying
 *   more than 3L outside the grid, which is what makes it a usable denominator
 *   for "what fraction of my quality-controlled vectors informed this field".
 *   Pass-2 contributors are not counted separately: pass 2 only redistributes
 *   residuals over cells pass 1 already covered.
 * @throws {RangeError} If an axis is not strictly increasing and finite, if L is
 *   not positive, or if gamma is outside (0, 1].
 */
export function barnesVector(obs, xs, ys, L, opts = {}) {
  const wMin = opts.wMin === undefined ? BARNES_WMIN : opts.wMin;
  const gamma = opts.gamma === undefined ? BARNES_GAMMA : opts.gamma;
  const ax = toAxis(xs, 'xs');
  const ay = toAxis(ys, 'ys');
  const { invL2, invL22, cutP1, cutP2 } = analysisScales(L, wMin, gamma);
  const nx = ax.length;
  const n = nx * ay.length;

  const u = new Float64Array(n).fill(Number.NaN);
  const v = new Float64Array(n).fill(Number.NaN);
  const weight = new Float64Array(n);
  const numU = new Float64Array(n);
  const numV = new Float64Array(n);
  const den = new Float64Array(n);
  const exScratch = new Float64Array(nx);
  const dx2Scratch = new Float64Array(nx);
  const nums = [numU, numV];
  const vals = [0, 0];
  let used = 0;
  if (!obs || obs.length === 0) return { u, v, weight, used };

  for (let k = 0; k < obs.length; k += 1) {
    const o = obs[k];
    if (!admissible(o) || !Number.isFinite(o.u) || !Number.isFinite(o.v)) continue;
    vals[0] = o.u;
    vals[1] = o.v;
    // Count the sweep, not the loop iteration: an admissible observation more
    // than 3L outside the grid deposits nothing and did not inform the field.
    if (accumulate(nums, vals, den, ax, ay, o.x, o.y, o.quality, invL2, cutP1, exScratch, dx2Scratch, null)) {
      used += 1;
    }
  }
  for (let c = 0; c < n; c += 1) {
    weight[c] = den[c];
    if (den[c] >= wMin) {
      u[c] = numU[c] / den[c];
      v[c] = numV[c] / den[c];
    }
  }

  numU.fill(0);
  numV.fill(0);
  den.fill(0);
  for (let k = 0; k < obs.length; k += 1) {
    const o = obs[k];
    if (!admissible(o) || !Number.isFinite(o.u) || !Number.isFinite(o.v)) continue;
    // u and v share a NaN mask, and sampleBilinear renormalises over exactly the
    // finite corners, so both samples draw on the same corner set: one
    // finiteness test provably covers both.
    const u1 = sampleBilinear(u, ax, ay, o.x, o.y);
    if (!Number.isFinite(u1)) continue;
    vals[0] = o.u - u1;
    vals[1] = o.v - sampleBilinear(v, ax, ay, o.x, o.y);
    accumulate(nums, vals, den, ax, ay, o.x, o.y, o.quality, invL22, cutP2, exScratch, dx2Scratch, u);
  }
  for (let c = 0; c < n; c += 1) {
    if (den[c] > 0 && u[c] === u[c]) {
      u[c] += numU[c] / den[c];
      v[c] += numV[c] / den[c];
    }
  }
  return { u, v, weight, used };
}

/**
 * Deterministic 32-bit linear congruential generator (Numerical Recipes /
 * Knuth parameters: a = 1664525, c = 1013904223, m = 2³²).
 *
 * `Math.imul` keeps the multiply exact in 32 bits instead of relying on the
 * double product staying under 2⁵³ (it does — 2³²·1664525 ≈ 7.15e15 < 9.01e15 —
 * but only by a factor of 1.26, which is not a margin worth depending on).
 * The state is advanced four times before first use so that adjacent small
 * seeds do not produce correlated leading draws.
 *
 * @param {number} seed - Any finite number; truncated to uint32.
 * @returns {() => number} Uniform [0, 1) generator taking the high bits of the state.
 */
function makeLcg(seed) {
  let state = Math.trunc(Number.isFinite(seed) ? seed : 0) >>> 0;
  const step = () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state;
  };
  for (let i = 0; i < 4; i += 1) step();
  // IMPROVEMENT 5: dividing the whole state by 2³² puts the LCG's well-behaved
  // high-order bits in the leading digits; the reference took `state % (i + 1)`,
  // which reads the low bits whose period is only 2^(k+1) for bit k.
  return () => step() / 4294967296;
}

/**
 * Split observations into a training set and a holdout set, reproducibly.
 *
 * Uses a Fisher–Yates shuffle of the index range driven by the LCG above, so a
 * given `(obs.length, frac, seed)` always yields the same partition on any
 * platform — the shuffle depends on the array's length and order, never on the
 * observation values. Elements are returned by reference, not copied. Exactly
 * `floor(frac · n)` observations are held out; `frac` is clamped to [0, 1]. No
 * minimum training size is imposed here — that is a policy decision for the
 * caller, and an empty training set is a legitimate (if useless) request.
 *
 * @param {object[]} obs - Any observation array; contents are not inspected.
 * @param {number} frac - Holdout fraction, clamped to [0, 1].
 * @param {number} seed - LCG seed; any finite number.
 * @returns {{train: object[], holdout: object[]}} Disjoint partition of `obs`.
 */
export function holdoutSplit(obs, frac, seed) {
  const src = obs || [];
  const n = src.length;
  const f = Number.isFinite(frac) ? Math.min(1, Math.max(0, frac)) : 0;
  const order = new Int32Array(n);
  for (let i = 0; i < n; i += 1) order[i] = i;
  const rand = makeLcg(seed);
  for (let i = n - 1; i > 0; i -= 1) {
    const j = Math.floor(rand() * (i + 1));
    const tmp = order[i];
    order[i] = order[j];
    order[j] = tmp;
  }
  const nHold = Math.min(n, Math.floor(f * n));
  const holdout = new Array(nHold);
  const train = new Array(n - nHold);
  for (let i = 0; i < nHold; i += 1) holdout[i] = src[order[i]];
  for (let i = nHold; i < n; i += 1) train[i - nHold] = src[order[i]];
  return { train, holdout };
}

/**
 * Holdout cross-validation of a vector Barnes analysis.
 *
 * Splits `obs` with {@link holdoutSplit}, analyses the training set alone with
 * {@link barnesVector}, then bilinearly samples that analysis at each held-out
 * position and compares. Note what this does and does not measure: it is the
 * skill of an analysis built from (1 − frac) of the data, so it slightly
 * *under*states the skill of the full-data analysis the caller should ship, and
 * it says nothing about accuracy where no observation was withheld.
 *
 * Every returned statistic is defined over one population: the held-out
 * observations that are admissible (finite position, positive finite quality,
 * finite u and v — the same test the training sweep applies) AND at which the
 * training analysis is finite. Its size is `holdoutCount`. Held-out
 * observations falling in a data void are excluded from the error statistics
 * (they have no prediction to be wrong about) and show up instead as a
 * shortfall in `coverage`; inadmissible ones are excluded because scoring the
 * field against data the analysis refuses to use measures nothing.
 *
 * @param {{x: number, y: number, u: number, v: number, quality: number}[]} obs -
 *   Observations in METRES on a local tangent plane, u/v in m/s.
 * @param {Float64Array|number[]} xs - Strictly increasing column axis, metres.
 * @param {Float64Array|number[]} ys - Strictly increasing row axis, metres.
 * @param {number} L - Pass-1 length scale, metres.
 * @param {{wMin?: number, gamma?: number, holdoutFrac?: number, seed?: number, sigma0?: number}} [opts] -
 *   Analysis parameters plus the split (`holdoutFrac` default 0.12, `seed`
 *   default 7) and the error scale `sigma0` (default {@link HFR_SIGMA0}).
 * @returns {{holdoutCount: number, rmseMs: number|null, maeMs: number|null,
 *   biasU: number|null, biasV: number|null, coverage: number, meanSigmaMs: number|null}}
 *   `holdoutCount` — held-out observations scored (the population N below).
 *   `rmseMs` — √((1/N)Σ(Δu² + Δv²)), the RMS of the VECTOR error magnitude, so
 *   √2 times the per-component RMS for isotropic errors; Δ = analysis − observation, m/s.
 *   `maeMs` — (1/N)Σ√(Δu² + Δv²), m/s. `biasU`, `biasV` — (1/N)ΣΔu and (1/N)ΣΔv, m/s.
 *   `coverage` — fraction of ALL grid cells carrying a finite analysis; this
 *   module has no land mask, so land counts against it and a caller holding a
 *   mask should recompute over ocean cells only.
 *   `meanSigmaMs` — (1/N)Σ σ0/√w(x_obs), w the pass-1 weight sampled with the
 *   same masked bilinear stencil as the field, so w ≥ wMin wherever it is scored.
 *   The four error statistics are `null` when N = 0.
 */
export function validateAnalysis(obs, xs, ys, L, opts = {}) {
  const holdoutFrac = opts.holdoutFrac === undefined ? 0.12 : opts.holdoutFrac;
  const seed = opts.seed === undefined ? 7 : opts.seed;
  const sigma0 = opts.sigma0 === undefined ? HFR_SIGMA0 : opts.sigma0;
  const wMin = opts.wMin === undefined ? BARNES_WMIN : opts.wMin;
  const gamma = opts.gamma === undefined ? BARNES_GAMMA : opts.gamma;

  const ax = toAxis(xs, 'xs');
  const ay = toAxis(ys, 'ys');
  const { train, holdout } = holdoutSplit(obs, holdoutFrac, seed);
  const analysis = barnesVector(train, ax, ay, L, { wMin, gamma });

  const n = analysis.u.length;
  let covered = 0;
  // Gate the weight field with the field's own mask so the sampled weight is a
  // convex combination of values that all passed wMin, hence itself >= wMin > 0.
  const maskedWeight = new Float64Array(n);
  for (let c = 0; c < n; c += 1) {
    if (analysis.u[c] === analysis.u[c]) {
      covered += 1;
      maskedWeight[c] = analysis.weight[c];
    } else {
      maskedWeight[c] = Number.NaN;
    }
  }

  let se = 0;
  let ae = 0;
  let bu = 0;
  let bv = 0;
  let sig = 0;
  let scored = 0;
  for (let k = 0; k < holdout.length; k += 1) {
    const o = holdout[k];
    // Score only observations the analysis itself would have admitted. Scoring
    // one it would have rejected — a NaN position, a zero or infinite quality —
    // measures the field against data it deliberately refuses to trust, and
    // would make `holdoutCount` a different population from the training set.
    if (!admissible(o) || !Number.isFinite(o.u) || !Number.isFinite(o.v)) continue;
    const uh = sampleBilinear(analysis.u, ax, ay, o.x, o.y);
    if (!Number.isFinite(uh)) continue;
    // Every corner of the masked weight that the sampler can reach passed wMin,
    // and the sampler renormalises over exactly those corners, so w is a convex
    // combination of values >= wMin > 0 whenever uh is finite. The guard is
    // therefore unreachable; it is a `continue` rather than a skipped term so
    // that if the invariant is ever broken the statistics below keep ONE
    // population instead of silently dividing a short sum by a longer count.
    const w = sampleBilinear(maskedWeight, ax, ay, o.x, o.y);
    if (!(w > 0)) continue;
    const vh = sampleBilinear(analysis.v, ax, ay, o.x, o.y);
    const du = uh - o.u;
    const dv = vh - o.v;
    se += du * du + dv * dv;
    ae += Math.sqrt(du * du + dv * dv);
    bu += du;
    bv += dv;
    sig += sigma0 / Math.sqrt(w);
    scored += 1;
  }

  return {
    holdoutCount: scored,
    rmseMs: scored ? Math.sqrt(se / scored) : null,
    maeMs: scored ? ae / scored : null,
    biasU: scored ? bu / scored : null,
    biasV: scored ? bv / scored : null,
    coverage: n ? covered / n : 0,
    meanSigmaMs: scored ? sig / scored : null,
  };
}

/**
 * Convert an analysis field to a JSON-safe array with `null` for data voids.
 *
 * NaN is not representable in JSON; this is the wire form for the HTTP layer.
 *
 * @param {Float64Array} field - Analysis field, NaN where uncovered.
 * @returns {(number|null)[]} Same length, `null` wherever the value was not finite.
 */
export function toNullable(field) {
  const out = new Array(field.length);
  for (let i = 0; i < field.length; i += 1) {
    const v = field[i];
    out[i] = Number.isFinite(v) ? v : null;
  }
  return out;
}
