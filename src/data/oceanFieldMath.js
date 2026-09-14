/**
 * @file Pure math behind the animated ocean-current field (nullschool-style
 * streaklines draped on the globe). No Cesium, no DOM, no canvas, no network —
 * importable from Node 24 and the browser alike, so every rule below is
 * testable without a renderer.
 *
 * FIELD PAYLOAD. The sibling loader produces
 *   {grid: {lat0, lon0, dLat, dLon, nLat, nLon}, u: [...], v: [...], provenance}
 * where `u`/`v` are eastward/northward velocity in m/s on a regular lat/lon
 * grid, row-major, `value[iLat * nLon + iLon]`, with `lat = lat0 + iLat*dLat`
 * and `lon = lon0 + iLon*dLon` (dLat/dLon may be negative — ERDDAP serves some
 * grids latitude-descending — and both signs are handled without a transpose).
 * `null` (or any non-finite entry) means "no observation here": land, ice, a
 * QC rejection, or outside the swath.
 *
 * NO-DATA IS NOT SLACK WATER. {@link createFieldSampler} reports `ok:false`
 * and returns NaN for a gap, and never substitutes 0. `makeForcingSampler` in
 * `src/sim/leeway.js` does the opposite — it samples a forecast hole as 0 and
 * raises a `degraded` flag — which for a *drift* integration silently asserts
 * that the water is still. A streakline over a gap must be retired, not parked.
 * The gap test is free: the four-corner bilinear sum is evaluated in IEEE-754
 * arithmetic, where NaN x 0 = NaN, so even a corner carrying zero interpolation
 * weight (a particle sitting exactly on a grid line beside a masked cell)
 * poisons the sum. `ok` is therefore exactly "all four corners of both
 * components are finite" for free, without a per-corner branch; the one branch
 * that remains forces BOTH components to NaN when either fails, since half a
 * velocity is not a velocity.
 *
 * BILINEAR. With i0 = floor((lat-lat0)/dLat), j0 = floor((lon-lon0)/dLon),
 * ty and tx the fractional parts,
 *   f = f[i0][j0](1-tx)(1-ty) + f[i0][j1]tx(1-ty)
 *     + f[i1][j0](1-tx)ty     + f[i1][j1]tx*ty.
 * Longitude is reduced modulo 360 DEGREES first, before the division by dLon,
 * so a box straddling the antimeridian samples correctly and a wrapped
 * coordinate lands on very nearly the same interpolant as its unwrapped twin.
 * NOT on exactly the same one, and the margin over the alternative is smaller
 * than it looks. Both orders of operation carry about ulp(360)/|dLon| of error
 * in cell units — degree-first because the reduced degree value has
 * ulp(360) = 5.68e-14 and is then divided by dLon; index-first because the
 * reduced index value has ulp(360/|dLon|), the same quantity to within the
 * binade it lands in. They therefore differ by a factor in [1, 2), NOT by
 * 1/|dLon|. Population for every number in this paragraph: the 2e5 longitudes
 * lon_k = -180 + 360k/2e5 + 0.0123456789 deg, k = 0..2e5-1, on a grid with
 * lon0 = -180; metric max_k |fj(lon_k) - fj(lon_k - 360)| in CELLS.
 *   dLon 0.25: 2.2737e-13 degree-first, 2.2737e-13 index-first (ratio 1.00)
 *   dLon 0.08: 7.3896e-13 degree-first, 1.1937e-12 index-first (ratio 1.62)
 *   dLon 0.01: 5.9117e-12 degree-first, 9.5497e-12 index-first (ratio 1.62)
 * Degree-first is kept because it is never worse and reads as the geometric
 * operation it is. At dLon 0.25 the residual is 5.7e-14 deg — 6 NANOMETRES of
 * ground distance, 11 orders below the grid's own 0.25 deg resolution — and
 * over that same population, sampling u = sin(0.017j) + i and v = cos(0.013j),
 * 59.2% of points return a BIT-identical u and v from the two written forms,
 * worst |du| 4.0e-15. The residual scales with the magnitude of the longitude
 * as written rather than the point it denotes, so a coordinate two turns out
 * (lon + 720) degrades to |du| 2.8e-13; renderers unproject into one turn.
 * When the grid is periodic
 * (nLon*|dLon| = 360 within half a cell) the j1 = nLon corner wraps to column 0
 * instead of falling off the east edge. That closing SEAM cell is measured at
 * its true angular width, 360 - (nLon-1)|dLon| — exactly one cell only when the
 * axis covers 360 exactly. The half-cell slack in the periodicity test puts
 * lonPeriod = 360/|dLon| in [nLon - 0.5, nLon + 0.5], so the seam is between
 * 0.5 and 1.5 cells wide; 1430 columns of 0.2517 deg cover 359.931 and close
 * with a seam of 1.274 cells. Dividing the seam offset by one cell lets tx exceed
 * 1, which is extrapolation past the last node dressed as interpolation, and
 * bilinear's only safety guarantee is that it is a CONVEX combination of the
 * four corners: with tx in [0, 1] the result is bracketed by the observed
 * values, and outside it is not. Latitude never wraps: a 0.25 deg global grid
 * runs to +-89.875, and the poles sample as `ok:false` rather than being clamped
 * into a fabricated value.
 *
 * STORAGE. Both components are copied once into Float32Array with nulls mapped
 * to NaN: 4 bytes/cell/component (a 120x240 regional box = 230 KB; the full
 * 720x1440 0.25 deg global field = 8.3 MB) and monomorphic element reads in the
 * hot loop. Float32 rounds stored velocities by <= 2^-24 = 5.96e-8 relative.
 * Measured on the live box below, sampling exactly on each node of a 6x8 stride
 * through the 41x81 grid and comparing against the raw decimal ERDDAP served,
 * the MAX relative error was 5.11e-8 — at the bound, as it should be, since the
 * bound is attained near the top of each binade. (An earlier revision quoted
 * 3.9e-9 here, which was one node, not a maximum.) That is orders of magnitude
 * below the product uncertainty the payload reports in `provenance.rmseMs`.
 *
 * SPEED RAMP. Sequential multi-hue, strictly increasing in luminance, hue
 * sweeping monotonically 192 deg -> 41 deg (teal -> cyan -> green -> chartreuse
 * -> amber). No hue is revisited, so equal colour means equal speed; a rainbow
 * ramp fails that and is a documented misreading hazard for magnitude fields
 * [Borland & Taylor 2007; Crameri et al. 2020]. Stops are interpolated in
 * LINEAR LIGHT, which buys two properties: the sRGB gamut is the unit cube in
 * linear light and is convex, so a convex combination of in-gamut stops can
 * never clip; and WCAG relative luminance Y is a linear functional of the
 * linear-light components, so Y(t) is piecewise linear and monotone at the
 * stops implies monotone everywhere.
 * Measured stop luminances / WCAG contrast (L1+0.05)/(L2+0.05) against a dark
 * ocean (Y = 0.02) and bright daylight imagery (Y = 0.65):
 *   t=0.00 rgb(38,124,146)  Y=0.169 L*=48  vs dark 3.13  vs bright 3.20
 *   t=0.25 rgb(46,158,168)  Y=0.279 L*=60  vs dark 4.69  vs bright 2.13
 *   t=0.50 rgb(96,196,150)  Y=0.442 L*=72  vs dark 7.02  vs bright 1.42
 *   t=0.75 rgb(190,214,100) Y=0.600 L*=82  vs dark 9.28  vs bright 1.08
 *   t=1.00 rgb(255,201,80)  Y=0.636 L*=84  vs dark 9.80  vs bright 1.02
 * No opaque colour is strongly legible on both extremes at once: over
 * backgrounds spanning black to white the best achievable minimum contrast is
 * 4.58:1, at Y = 0.179 (solve (Y+0.05)/0.05 = 1.05/(Y+0.05)). The low stop sits
 * essentially at that minimax point (Y = 0.169, 3.1:1 both ways) because slow
 * water is most of the ocean and most of the particles; above it the ramp
 * commits to the dark background this layer actually draws over, since the
 * field only exists over water. Where imagery is within ~0.15 Y of a stop (sun
 * glint, ice) hue and chroma are the only separator, which is why every stop
 * keeps >= 46% HSL saturation instead of fading toward white.
 *
 * SPEED -> RAMP POSITION. t = clamp(speed/scale, 0, 1)^SPEED_RAMP_GAMMA. The
 * gamma is not decoration: probing `noaacwBLENDEDNRTcurrentsDaily` on
 * 2026-08-31 over a 30x60 deg Gulf Stream box (29,161 rows, 84.4% finite, so
 * ~24.6k cells) gave |v| — the northward component magnitude, a lower bound on
 * speed = hypot(u,v) — median 0.128, p95 0.553, max 2.025 m/s. Linear on
 * [0, 1.5] that median lands at t = 0.085, i.e. the entire ocean renders as one
 * flat teal; at gamma 0.55 it lands at t = 0.26 and the p95 bound at t = 0.58.
 * DEFAULT_SPEED_SCALE is 1.5 m/s rather than the reference project's
 * MAX_CURRENT_MS = 2.4 (`lib/ocean/domain.ts`), which is a QC *rejection*
 * threshold, not a display range. Callers with a payload in hand should prefer
 * an adaptive scale from {@link fieldStats}, e.g. max(0.5, 2*p95Ms).
 * Re-probed independently on 2026-09-01 (latest field 2026-08-30) over a 10x20
 * deg box at 32-42 N, 80-60 W — 41x81 = 3321 cells, 79.3% finite — where
 * {@link fieldStats} gives speed mean 0.387, p95 1.133, max 2.165 m/s and |v|
 * median 0.133, consistent with the wider box above. At scale 1.5 that p95
 * lands at t = 0.86, so the amber end is reached by the stream core and
 * essentially nothing else.
 *
 * COST, measured on that live box (Node 24, WSL2, Ryzen 9800X3D): 10^6 sampler
 * calls in 16.6 ms (17 ns/call, so a 10^5-particle frame spends ~1.7 ms in
 * interpolation); a full 8000-particle `step` including the caller's projection
 * and sampling costs 0.35 ms/frame averaged over 600 frames.
 *
 * PARTICLES. Screen-space advection: the caller projects the field velocity to
 * pixels/step and this module never sees a camera. Retirement, not clamping,
 * on all four of: age past its own maxAge, outside the viewport rect, a
 * `velocityAt` that reports no data, and a non-finite position (a projection
 * behind the limb). Every particle draws its own lifetime from
 * U[minAge, maxAge] AND is born at a uniformly random phase of that lifetime —
 * without the phase stagger a bulk reseed (first frame, camera jump, new
 * payload) gives every particle the same death step and the whole field blinks
 * in unison one lifetime later. Determinism is a hard requirement so the
 * renderer can be regression-tested: all randomness comes from one seeded
 * mulberry32 stream, the same generator as `makeRng` in `src/sim/leeway.js`
 * (duplicated rather than imported to keep this render-loop module free of that
 * module's land-mask dependency).
 *
 * Integration is forward Euler by default (local truncation error O(dt^2)),
 * with an optional midpoint step (O(dt^3)) for callers running large dt. At the
 * intended budget — ~10^4 particles, dt = 1 frame, screen speeds of a few
 * px/frame — the field varies over hundreds of pixels and Euler's error is far
 * below a pixel; the second `velocityAt` call, which carries the projection,
 * costs more than it buys.
 *
 * Sources:
 * - earth.nullschool.net (C. Beccario) — the visual target: short advected
 *   trails, speed-coloured, fading with age.
 * - Borland, D. & R.M. Taylor (2007): Rainbow Color Map (Still) Considered
 *   Harmful. IEEE Computer Graphics and Applications 27(2), 14-17.
 * - Crameri, F., G.E. Shephard & P.J. Heron (2020): The misuse of colour in
 *   science communication. Nature Communications 11, 5444.
 * - W3C WCAG 2.2, relative luminance and contrast-ratio definitions
 *   (Y = 0.2126R + 0.7152G + 0.0722B on linearized sRGB; ratio
 *   (L1+0.05)/(L2+0.05)); IEC 61966-2-1 for the sRGB transfer function;
 *   CIE 15:2004 for L* = 116 f(Y) - 16.
 * - Hyndman, R.J. & Y. Fan (1996): Sample Quantiles in Statistical Packages.
 *   The American Statistician 50(4), 361-365 — p95 here is their type 1
 *   (nearest rank, no interpolation).
 * - mulberry32 (T. Ettinger, public domain), as already vendored in
 *   `src/sim/leeway.js`.
 * - Reference implementation `lib/ocean/{interpolate,particles,rng,domain}.ts`
 *   by the same author: bilinear-with-null-corners and the QC constants
 *   (MAX_CURRENT_MS 2.4) cited above come from there.
 *
 * @module data/oceanFieldMath
 */

/* ------------------------------------------------------------------ grid -- */

/**
 * Validate a payload grid descriptor and return it as plain numbers.
 *
 * @param {{lat0: number, lon0: number, dLat: number, dLon: number,
 *   nLat: number, nLon: number}} grid - Grid descriptor from the payload.
 * @param {number} [minSpan=1] - Minimum required cells per axis (the sampler
 *   passes 2, since bilinear needs two rows and two columns).
 * @returns {{lat0: number, lon0: number, dLat: number, dLon: number,
 *   nLat: number, nLon: number}} The same six numbers, validated.
 * @throws {Error} If any field is missing, non-finite, a zero spacing, or a
 *   non-integer/too-small dimension. Refuses to guess defaults: a malformed
 *   grid would otherwise sample plausible-looking garbage forever.
 */
function readGrid(grid, minSpan = 1) {
  if (!grid || typeof grid !== 'object') throw new Error('ocean field payload has no grid');
  const { lat0, lon0, dLat, dLon, nLat, nLon } = grid;
  for (const [name, value] of [['lat0', lat0], ['lon0', lon0], ['dLat', dLat], ['dLon', dLon]]) {
    if (!Number.isFinite(value)) throw new Error(`ocean field grid.${name} must be finite, got ${value}`);
  }
  if (dLat === 0 || dLon === 0) throw new Error('ocean field grid spacing must be non-zero');
  if (!Number.isInteger(nLat) || nLat < minSpan) {
    throw new Error(`ocean field grid.nLat must be an integer >= ${minSpan}, got ${nLat}`);
  }
  if (!Number.isInteger(nLon) || nLon < minSpan) {
    throw new Error(`ocean field grid.nLon must be an integer >= ${minSpan}, got ${nLon}`);
  }
  return { lat0, lon0, dLat, dLon, nLat, nLon };
}

/**
 * Whether a longitude axis closes on itself: nLon columns of dLon cover 360 deg
 * to within half a cell, so column nLon-1 is (about) one cell west of column 0.
 * The half-cell slack admits grids whose spacing is a rounded decimal, e.g. the
 * 1440x0.25 deg global product; the sampler measures the true closing gap
 * rather than assuming it is exactly one cell.
 *
 * @param {number} nLon - Column count.
 * @param {number} dLon - Column spacing, degrees, either sign.
 * @returns {boolean} True when the axis is globally periodic.
 */
function isPeriodicLon(nLon, dLon) {
  return Math.abs(Math.abs(nLon * dLon) - 360) <= Math.abs(dLon) * 0.5;
}

/**
 * Corner coordinates of a payload grid, plus whether it closes on itself in
 * longitude. Useful to the renderer for seeding particles only where the field
 * exists; does not consider data coverage, only geometry.
 *
 * @param {object} grid - Payload `grid` descriptor.
 * @returns {{latMin: number, latMax: number, lonMin: number, lonMax: number,
 *   wrapsLon: boolean}} Bounds of the grid NODES (not cell edges) in degrees,
 *   ordered min <= max whatever the sign of dLat/dLon. `wrapsLon` is true when
 *   nLon*|dLon| equals 360 within half a cell, i.e. column nLon-1 is one cell
 *   west of column 0.
 * @throws {Error} On a malformed grid (see {@link readGrid}).
 */
export function gridBounds(grid) {
  const g = readGrid(grid);
  const latEnd = g.lat0 + (g.nLat - 1) * g.dLat;
  const lonEnd = g.lon0 + (g.nLon - 1) * g.dLon;
  return {
    latMin: Math.min(g.lat0, latEnd),
    latMax: Math.max(g.lat0, latEnd),
    lonMin: Math.min(g.lon0, lonEnd),
    lonMax: Math.max(g.lon0, lonEnd),
    wrapsLon: isPeriodicLon(g.nLon, g.dLon),
  };
}

/**
 * Copy a payload component into a Float32Array, mapping null/undefined and any
 * non-finite entry (including +-Infinity) to NaN so the sampler's NaN
 * propagation is the single gap mechanism.
 *
 * @param {Array<number|null>|Float32Array|Float64Array} values - Component.
 * @param {number} cells - Expected length, nLat*nLon.
 * @param {string} name - Field name, for the error message.
 * @returns {Float32Array} Dense copy; never aliases the input.
 * @throws {Error} If the component is missing, is not an Array or a typed
 *   array, or is the wrong length. The type check is not pedantry: anything
 *   else with a `.length` (a string, a `{length: n}` stub) would index to
 *   non-numbers, every one of which maps to NaN, and the field would load as a
 *   silent all-gap ocean instead of reporting that the payload is wrong.
 */
function toFloat32(values, cells, name) {
  if (!values || typeof values.length !== 'number') {
    throw new Error(`ocean field payload.${name} is missing`);
  }
  if (!Array.isArray(values) && !ArrayBuffer.isView(values)) {
    throw new Error(`ocean field payload.${name} must be an Array or a typed array`);
  }
  if (values.length !== cells) {
    throw new Error(`ocean field payload.${name} has ${values.length} entries, grid needs ${cells}`);
  }
  const out = new Float32Array(cells);
  for (let i = 0; i < cells; i += 1) {
    const value = values[i];
    out[i] = Number.isFinite(value) ? value : NaN;
  }
  return out;
}

/**
 * Build a bilinear sampler over a field payload.
 *
 * The returned closure allocates nothing: it fills and returns ONE result
 * object that it owns, so the ~10^5 calls in an animation frame cost no GC.
 * The caller must read `u`/`v`/`ok` before the next call and must never retain
 * the object; each `createFieldSampler` call gets its own, so two samplers
 * never collide.
 *
 * `ok` is false — and `u`/`v` are NaN, never 0 — when the position is outside
 * the grid in latitude, outside it in longitude on a non-periodic grid, or any
 * of the four surrounding corners of either component is a gap. A caller that
 * ignores `ok` therefore produces visibly broken output instead of a plausible
 * slack-water lie.
 *
 * @param {{grid: object, u: Array<number|null>|Float32Array|Float64Array,
 *   v: Array<number|null>|Float32Array|Float64Array}} payload - Field payload;
 *   only `grid`, `u`, `v` are read (`provenance` is ignored). Components are
 *   copied, so the caller may reuse the buffers immediately.
 * @returns {(lat: number, lon: number) => {u: number, v: number, ok: boolean}}
 *   Sampler in degrees, returning eastward/northward m/s.
 * @throws {Error} On a malformed grid (needs nLat >= 2 and nLon >= 2 to
 *   interpolate), or a component that is not an Array or typed array, or one
 *   whose length disagrees with the grid.
 */
export function createFieldSampler(payload) {
  const { lat0, lon0, dLat, dLon, nLat, nLon } = readGrid(payload && payload.grid, 2);
  const cells = nLat * nLon;
  const u = toFloat32(payload && payload.u, cells, 'u');
  const v = toFloat32(payload && payload.v, cells, 'v');
  const wrapsLon = isPeriodicLon(nLon, dLon);
  // Number of grid columns that would span the full 360 deg at this spacing;
  // longitude is reduced into [0, lonPeriod) so a box straddling the
  // antimeridian is sampled by the same index arithmetic as any other box.
  const lonPeriod = 360 / Math.abs(dLon);
  const lastLat = nLat - 2;
  const lastLon = nLon - 2;
  // Width, in index units, of the SEAM cell that closes a periodic grid: the
  // gap from node nLon-1 back round to node 0. It is exactly 1 only when
  // nLon*|dLon| is exactly 360. `isPeriodicLon` admits half a cell of slack, so
  // on a grid like 1430 x 0.2517 deg (= 359.931) the seam is 1.27 cells wide
  // and dividing the offset by 1 would run tx past 1 — an EXTRAPOLATION beyond
  // the last node, reported as ok:true. Measured on such a grid before this
  // fix: a field whose only values are 0 and 100 returned -27.0 m/s. Dividing
  // by the true seam width keeps the result a convex combination of the two
  // bracketing nodes, which is the one property that makes bilinear safe.
  const seamSpan = lonPeriod - (nLon - 1);

  const out = { u: NaN, v: NaN, ok: false };
  const miss = () => {
    out.u = NaN;
    out.v = NaN;
    out.ok = false;
    return out;
  };

  return function sampleField(lat, lon) {
    const fi = (lat - lat0) / dLat;
    if (!(fi >= 0 && fi <= nLat - 1)) return miss();
    let i0 = Math.floor(fi);
    if (i0 > lastLat) i0 = lastLat;
    const ty = fi - i0;

    // Reduce in DEGREES before dividing. This is NOT exact — (lon - lon0) mod
    // 360 rounds, and the two written forms of one point can land up to
    // 2.3e-13 of a cell apart on the 0.25 deg global grid (see the @file block
    // for the measured comparison against reducing the index instead, which is
    // worse by a factor in [1, 2), not by 1/|dLon| as an earlier revision of
    // this comment claimed). 2.3e-13 cells is 6 NANOMETRES of ground distance
    // and cannot move j0, so the seam is continuous in every way a renderer can
    // observe.
    let lonRel = lon - lon0;
    lonRel -= 360 * Math.floor(lonRel / 360);
    let fj = lonRel / dLon;
    if (fj < 0) fj += lonPeriod; // dLon < 0: index runs west, wrap to the far end
    let j0;
    let j1;
    let tx;
    if (fj >= 0 && fj <= nLon - 1) {
      // Interior cell. Identical arithmetic on periodic and regional grids, and
      // the bound guarantees tx in [0, 1]. A non-finite lon leaves fj NaN, so
      // both comparisons are false and control reaches the refusal below rather
      // than indexing the storage with NaN.
      j0 = Math.floor(fj);
      if (j0 > lastLon) j0 = lastLon; // fj exactly nLon-1: use the last cell, tx = 1
      j1 = j0 + 1;
      tx = fj - j0;
    } else if (wrapsLon && fj > nLon - 1) {
      // The seam. tx is the fraction of the true closing gap, not of one cell.
      j0 = nLon - 1;
      j1 = 0;
      tx = (fj - (nLon - 1)) / seamSpan;
      if (tx > 1) tx = 1; // fj may round up to exactly lonPeriod
    } else {
      return miss();
    }

    const rowA = i0 * nLon;
    const rowB = rowA + nLon;
    const a = rowA + j0;
    const b = rowA + j1;
    const c = rowB + j0;
    const d = rowB + j1;
    const w00 = (1 - tx) * (1 - ty);
    const w01 = tx * (1 - ty);
    const w10 = (1 - tx) * ty;
    const w11 = tx * ty;

    // NaN x 0 = NaN, so a gap at a zero-weight corner still fails the test —
    // exactly the "any needed corner" rule, with no per-corner branch.
    const su = u[a] * w00 + u[b] * w01 + u[c] * w10 + u[d] * w11;
    const sv = v[a] * w00 + v[b] * w01 + v[c] * w10 + v[d] * w11;
    // Storage holds only finite values or NaN (toFloat32 maps Infinity to NaN),
    // so the self-comparison is a complete finiteness test and avoids the call.
    if (su === su && sv === sv) {
      out.u = su;
      out.v = sv;
      out.ok = true;
      return out;
    }
    // A gap in EITHER component invalidates the whole vector: half a velocity
    // is not a velocity, and leaving the surviving component finite would let a
    // caller that skips `ok` advect along one axis only.
    return miss();
  };
}

/* ----------------------------------------------------------------- ramp -- */

/**
 * @const {ReadonlyArray<{t: number, r: number, g: number, b: number}>} Anchor
 * stops of the speed ramp, evenly spaced in t and strictly increasing in WCAG
 * relative luminance (0.169, 0.279, 0.442, 0.600, 0.636) while hue falls
 * monotonically (192, 185, 152, 73, 41 deg). See the @file block for the
 * contrast measurements and why the ramp is not a rainbow.
 */
export const SPEED_RAMP_STOPS = Object.freeze([
  Object.freeze({ t: 0.00, r: 38, g: 124, b: 146 }),
  Object.freeze({ t: 0.25, r: 46, g: 158, b: 168 }),
  Object.freeze({ t: 0.50, r: 96, g: 196, b: 150 }),
  Object.freeze({ t: 0.75, r: 190, g: 214, b: 100 }),
  Object.freeze({ t: 1.00, r: 255, g: 201, b: 80 }),
]);

/**
 * @const {number} Speed in m/s mapped to the top of the ramp. Faster water
 * clips to the amber end rather than wrapping. See the @file block: chosen from
 * a measured Gulf Stream |v| distribution, not from the QC ceiling.
 */
export const DEFAULT_SPEED_SCALE = 1.5;

/**
 * @const {number} Exponent applied to the normalized speed before the ramp
 * lookup. gamma < 1 expands the crowded slow end: at DEFAULT_SPEED_SCALE the
 * measured median |v| (0.128 m/s) moves from t = 0.085 to t = 0.26.
 */
export const SPEED_RAMP_GAMMA = 0.55;

/** @const {number} Ramp lookup-table resolution (t quantized to 1/255). */
const RAMP_LUT_SIZE = 256;

/** sRGB electro-optical transfer function, IEC 61966-2-1. 0..255 -> 0..1 linear. */
function srgbToLinear(code) {
  const s = code / 255;
  return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
}

/** Inverse transfer function, linear 0..1 -> 0..255 sRGB code, clamped. */
function linearToSrgb(value) {
  const clamped = value <= 0 ? 0 : value >= 1 ? 1 : value;
  const s = clamped <= 0.0031308 ? clamped * 12.92 : 1.055 * clamped ** (1 / 2.4) - 0.055;
  return Math.round(s * 255);
}

/**
 * Ramp lookup table, built once at module load. Stops are interpolated in
 * linear light (convex, so never out of gamut) and re-encoded to 8-bit sRGB.
 * Baking it removes three Math.pow calls per particle per frame; the cost is
 * quantizing t to 1/255, which moves a colour by at most one 8-bit code per
 * channel — invisible on the 1-2 px marks this ramp is drawn as.
 * @type {Uint8Array}
 */
const RAMP_LUT = (() => {
  const stops = SPEED_RAMP_STOPS;
  const lin = new Float64Array(stops.length * 3);
  for (let s = 0; s < stops.length; s += 1) {
    lin[s * 3] = srgbToLinear(stops[s].r);
    lin[s * 3 + 1] = srgbToLinear(stops[s].g);
    lin[s * 3 + 2] = srgbToLinear(stops[s].b);
  }
  const segments = stops.length - 1;
  const lut = new Uint8Array(RAMP_LUT_SIZE * 3);
  for (let q = 0; q < RAMP_LUT_SIZE; q += 1) {
    const t = q / (RAMP_LUT_SIZE - 1);
    const f = t * segments;
    let s = Math.floor(f);
    if (s > segments - 1) s = segments - 1;
    const k = f - s;
    for (let ch = 0; ch < 3; ch += 1) {
      const a = lin[s * 3 + ch];
      const b = lin[(s + 1) * 3 + ch];
      lut[q * 3 + ch] = linearToSrgb(a + (b - a) * k);
    }
  }
  return lut;
})();

/**
 * Normalized ramp position for a speed: clamp(speed/scale, 0, 1)^gamma.
 *
 * @param {number} speedMs - Current speed magnitude, m/s.
 * @param {number} [scale=DEFAULT_SPEED_SCALE] - Speed mapped to t = 1.
 * @returns {number} t in [0, 1]. A non-finite or negative speed returns 0:
 *   colour is a display mapping, never the data gate (the sampler's `ok` is),
 *   so a stray NaN yields the ramp floor instead of throwing inside the frame
 *   loop. Note what that costs — the floor is a saturated teal identical to
 *   genuine slack water, so `speedRampT(NaN) === speedRampT(0)` and the OUTPUT
 *   cannot distinguish "no speed reported" from "measured 0 m/s". The particle
 *   system stores NaN, not 0, in `speedMs` exactly so that a caller which wants
 *   the distinction can still make it: test `Number.isFinite(speedMs)` before
 *   colouring and draw the unknown case differently (or not at all).
 */
export function speedRampT(speedMs, scale = DEFAULT_SPEED_SCALE) {
  if (!Number.isFinite(speedMs) || speedMs <= 0) return 0;
  const denom = Number.isFinite(scale) && scale > 0 ? scale : DEFAULT_SPEED_SCALE;
  const x = speedMs >= denom ? 1 : speedMs / denom;
  return x ** SPEED_RAMP_GAMMA;
}

/**
 * Colour for a current speed on the sequential teal -> amber ramp.
 *
 * @param {number} speedMs - Speed magnitude in m/s (hypot of the components —
 *   NOT the screen-space particle speed, which changes with zoom).
 * @param {number} [scale=DEFAULT_SPEED_SCALE] - Speed mapped to the ramp top;
 *   speeds above it clip to amber. A non-positive or non-finite scale falls
 *   back to the default rather than dividing by zero.
 * @param {{r: number, g: number, b: number}} [out] - Optional target to write
 *   into, so a per-particle render loop can stay allocation-free.
 * @returns {{r: number, g: number, b: number}} Channels 0-255, integers.
 */
export function speedColor(speedMs, scale = DEFAULT_SPEED_SCALE, out) {
  const q = Math.round(speedRampT(speedMs, scale) * (RAMP_LUT_SIZE - 1)) * 3;
  const target = out || { r: 0, g: 0, b: 0 };
  target.r = RAMP_LUT[q];
  target.g = RAMP_LUT[q + 1];
  target.b = RAMP_LUT[q + 2];
  return target;
}

/**
 * Same ramp as a CSS colour string, for legend swatches and gradients.
 *
 * @param {number} speedMs - Speed magnitude, m/s.
 * @param {number} [scale=DEFAULT_SPEED_SCALE] - Speed mapped to the ramp top.
 * @returns {string} `rgb(r, g, b)`. Allocates — not for the per-particle loop.
 */
export function speedColorCss(speedMs, scale = DEFAULT_SPEED_SCALE) {
  const c = speedColor(speedMs, scale);
  return `rgb(${c.r}, ${c.g}, ${c.b})`;
}

/**
 * Evenly spaced samples along the ramp for drawing a legend.
 *
 * Samples are even in RAMP POSITION (so they render as a uniform CSS gradient)
 * and each carries the speed that maps to it, `speedMs = scale * t^(1/gamma)`,
 * which is the value a tick at that position must be labelled with. Sampling
 * evenly in speed instead would bunch the swatches.
 *
 * @param {number} [count=5] - Number of samples; truncated to an integer and
 *   clamped up to 2, the fewest that draw a gradient.
 * @param {number} [scale=DEFAULT_SPEED_SCALE] - Speed mapped to the ramp top.
 * @returns {Array<{t: number, speedMs: number, r: number, g: number, b: number}>}
 *   Ordered slowest to fastest; first is t = 0 (speed 0), last is t = 1
 *   (speed = scale, labelled as a ">=" bound by the caller since faster water
 *   clips there).
 * @throws {Error} On a non-finite `count`. Not defensive noise: `Math.max(2,
 *   Math.trunc(NaN))` is NaN, which silently produced an EMPTY legend (the
 *   documented ">= 2" never held), and `Infinity` hung the caller in an
 *   unbounded push loop. A legend size is small and known; a non-finite one is
 *   a bug upstream and is reported as one.
 */
export function speedLegendStops(count = 5, scale = DEFAULT_SPEED_SCALE) {
  if (!Number.isFinite(count)) {
    throw new Error(`speedLegendStops count must be finite, got ${count}`);
  }
  const n = Math.max(2, Math.trunc(count));
  const denom = Number.isFinite(scale) && scale > 0 ? scale : DEFAULT_SPEED_SCALE;
  const stops = [];
  for (let i = 0; i < n; i += 1) {
    const t = i / (n - 1);
    const speedMs = denom * t ** (1 / SPEED_RAMP_GAMMA);
    const c = speedColor(speedMs, denom);
    stops.push({ t, speedMs, r: c.r, g: c.g, b: c.b });
  }
  return stops;
}

/* ------------------------------------------------------------ trail fade -- */

/** @const {number} Fraction of a lifetime spent fading in at birth. */
export const TRAIL_FADE_IN_FRAC = 0.12;
/** @const {number} Fraction of a lifetime spent fading out before death. */
export const TRAIL_FADE_OUT_FRAC = 0.35;

/**
 * Hermite smoothstep, clamped: 0 below edge0, 1 above edge1, 3t^2 - 2t^3
 * between. C^1 continuous, so a fade built from it has no visible kink.
 *
 * @param {number} edge0 - Lower edge.
 * @param {number} edge1 - Upper edge.
 * @param {number} x - Sample point.
 * @returns {number} Value in [0, 1] for every input, NaN included. Degenerate
 *   edges (edge0 === edge1) give a hard step at that value rather than dividing
 *   by zero, and a NaN `x` returns 0 — the tests are written `!(t > 0)` rather
 *   than `t <= 0` precisely so that an unordered comparison lands on the
 *   invisible end. Returning NaN here would multiply straight into an alpha and
 *   paint a fully opaque or fully transparent mark depending on the canvas.
 */
export function smoothstep(edge0, edge1, x) {
  if (edge1 === edge0) return x >= edge0 ? 1 : 0;
  const t = (x - edge0) / (edge1 - edge0);
  if (!(t > 0)) return 0;
  if (t >= 1) return 1;
  return t * t * (3 - 2 * t);
}

/**
 * Opacity of a particle's trail at a given age: fades in over the first
 * TRAIL_FADE_IN_FRAC of its life, holds at 1, fades out over the last
 * TRAIL_FADE_OUT_FRAC. The product of two smoothsteps, so the profile is C^1
 * everywhere and particles neither pop into existence nor vanish mid-stroke.
 * Since the two ramps do not overlap (0.12 + 0.35 < 1) the plateau reaches
 * exactly 1.
 *
 * @param {number} age - Elapsed life, in whatever unit the caller steps with.
 * @param {number} maxAge - That particle's lifetime, same unit.
 * @returns {number} Alpha in [0, 1]; exactly 0 at birth, at death, and for any
 *   non-positive maxAge or out-of-range age (a dead or malformed particle is
 *   invisible, never fully opaque).
 */
export function buildTrailAlpha(age, maxAge) {
  if (!(maxAge > 0) || !(age >= 0)) return 0;
  const u = age / maxAge;
  if (u >= 1) return 0;
  return smoothstep(0, TRAIL_FADE_IN_FRAC, u) * (1 - smoothstep(1 - TRAIL_FADE_OUT_FRAC, 1, u));
}

/* -------------------------------------------------------------- particles -- */

/** @const {number} Default shortest particle lifetime, in step units. */
export const DEFAULT_MIN_AGE = 24;
/** @const {number} Default longest particle lifetime, in step units. */
export const DEFAULT_MAX_AGE = 90;

/**
 * Seeded mulberry32 uniform generator. Same seed gives the same stream on every
 * engine and platform (all operations are exact 32-bit integer ops plus one
 * exact division). Identical to `makeRng` in `src/sim/leeway.js`.
 *
 * @param {number} seed - Any finite number; truncated to 32 bits. 0 is replaced
 *   by the golden-ratio constant so a falsy seed still gives a full-period
 *   stream rather than a degenerate one.
 * @returns {() => number} Uniform draws in [0, 1).
 */
export function createRng(seed) {
  let state = (Math.trunc(seed) >>> 0) || 0x9e3779b9;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Deterministic particle store for the streakline field.
 *
 * State lives in parallel typed arrays indexed by particle: `x`, `y` (current
 * screen position, px), `prevX`, `prevY` (position before the last step — the
 * other end of the segment to draw), `age`, `maxAge` (this particle's own
 * lifetime), `speedMs` (last observed field speed, for colouring), and `alive`
 * (1 or 0). They are exposed directly so the renderer can walk them without
 * per-particle objects; writing to them is allowed and is the escape hatch for
 * anything this API does not cover.
 *
 * Particles are created DEAD with no position: the viewport is not known at
 * construction. The first `step` with a `spawn` callback brings them online,
 * each with its own random lifetime and a random birth phase, which is what
 * keeps the field from blinking in unison (see the @file block).
 *
 * @param {object} options - Configuration.
 * @param {number} options.count - Number of particles; positive integer.
 * @param {number} [options.seed=1] - RNG seed. Same seed plus the same
 *   `velocityAt`/`spawn` behaviour reproduces the run exactly.
 * @param {number} [options.minAge=DEFAULT_MIN_AGE] - Shortest lifetime, in the
 *   same units as the `dt` passed to `step` (defaults assume dt = 1 per frame,
 *   so 24-90 frames ~ 0.4-1.5 s at 60 fps; scale them if stepping in seconds).
 * @param {number} [options.maxAge=DEFAULT_MAX_AGE] - Longest lifetime.
 * @returns {{count: number, x: Float32Array, y: Float32Array,
 *   prevX: Float32Array, prevY: Float32Array, age: Float32Array,
 *   maxAge: Float32Array, speedMs: Float32Array, alive: Uint8Array,
 *   ageRange: {min: number, max: number}, random: () => number,
 *   respawn: (i: number, x: number, y: number) => void,
 *   kill: (i: number) => void, killAll: () => void,
 *   aliveCount: () => number, step: (options: object) => number}}
 * @throws {Error} On a non-positive count or an age range that is not
 *   0 < minAge <= maxAge.
 */
export function createParticleSystem({
  count,
  seed = 1,
  minAge = DEFAULT_MIN_AGE,
  maxAge = DEFAULT_MAX_AGE,
} = {}) {
  if (!Number.isInteger(count) || count <= 0) {
    throw new Error(`particle count must be a positive integer, got ${count}`);
  }
  if (!(minAge > 0) || !(maxAge >= minAge)) {
    throw new Error(`particle ages must satisfy 0 < minAge <= maxAge, got ${minAge}..${maxAge}`);
  }
  const rng = createRng(seed);
  const ageSpan = maxAge - minAge;

  const x = new Float32Array(count);
  const y = new Float32Array(count);
  const prevX = new Float32Array(count);
  const prevY = new Float32Array(count);
  const age = new Float32Array(count);
  const life = new Float32Array(count);
  const speedMs = new Float32Array(count);
  const alive = new Uint8Array(count);
  x.fill(NaN);
  y.fill(NaN);
  prevX.fill(NaN);
  prevY.fill(NaN);
  speedMs.fill(NaN);

  /**
   * Place particle `i` at a screen position and bring it to life.
   *
   * Draws a fresh lifetime from U[minAge, maxAge] AND a birth age uniform on
   * [0, lifetime): a particle joins the field mid-life, so a bulk respawn of
   * every particle in one frame still produces deaths spread over a whole
   * lifetime instead of one synchronised blink. `prev` is set to the new
   * position so the first segment drawn has zero length rather than streaking
   * across the screen from wherever the particle used to be.
   *
   * @param {number} i - Particle index (unchecked; caller iterates `count`).
   * @param {number} px - Screen x, pixels.
   * @param {number} py - Screen y, pixels.
   * @returns {void}
   */
  function respawn(i, px, py) {
    const span = minAge + ageSpan * rng();
    life[i] = span;
    age[i] = span * rng();
    x[i] = px;
    y[i] = py;
    prevX[i] = px;
    prevY[i] = py;
    speedMs[i] = NaN;
    alive[i] = 1;
  }

  /**
   * Retire particle `i`. Position is left in place (harmless: nothing draws a
   * dead particle) so a caller can inspect where it died.
   *
   * @param {number} i - Particle index.
   * @returns {void}
   */
  function kill(i) {
    alive[i] = 0;
    speedMs[i] = NaN;
  }

  /**
   * Retire every particle. Consumes no randomness, so the RNG stream — and
   * therefore determinism — is unaffected by how often the caller resets.
   *
   * @returns {void}
   */
  function killAll() {
    alive.fill(0);
    speedMs.fill(NaN);
  }

  /**
   * Count of living particles. O(count) — for tests and diagnostics; `step`
   * returns the same number for free.
   *
   * @returns {number} Particles with alive === 1.
   */
  function aliveCount() {
    let n = 0;
    for (let i = 0; i < count; i += 1) if (alive[i] === 1) n += 1;
    return n;
  }

  const system = {
    count,
    x,
    y,
    prevX,
    prevY,
    age,
    maxAge: life,
    speedMs,
    alive,
    ageRange: Object.freeze({ min: minAge, max: maxAge }),
    random: rng,
    respawn,
    kill,
    killAll,
    aliveCount,
    step,
  };

  /**
   * Advance every living particle by one step.
   *
   * Per particle: sample the screen-space velocity at its current position,
   * integrate, age it, then retire it if any of four conditions holds — the
   * lookup reported no data, the new position is non-finite (projection behind
   * the limb), the new position is outside `bounds`, or `age >= maxAge`. A
   * retired particle is offered to `spawn` in the same pass, so the field
   * refills without a second sweep; a particle `spawn` declines to place stays
   * dead until a later step.
   *
   * @param {object} options - Step inputs.
   * @param {(x: number, y: number) => ({vx: number, vy: number, ok: boolean,
   *   speedMs?: number} | null)} options.velocityAt - Screen-space velocity in
   *   px per unit dt at a screen position, with `ok:false` (or null) where the
   *   field has no data. May return a reused object — this function copies what
   *   it needs before calling again. An optional `speedMs` (the physical speed
   *   in m/s at that point) is stored per particle for colouring. Under
   *   `midpoint` the stored `speedMs` is the one reported at the START of the
   *   step, not at the midpoint: it labels the segment by where it began.
   * @param {number} [options.dt=1] - Step size, same unit as minAge/maxAge.
   *   Must be finite and >= 0. Backward advection is expressed by negating
   *   `velocityAt`'s output, NOT by a negative dt — a negative dt would run
   *   `age` down instead of up, so no particle would ever reach its lifetime
   *   and {@link buildTrailAlpha} would return 0 for the whole field.
   * @param {{minX: number, minY: number, maxX: number, maxY: number}|null}
   *   [options.bounds=null] - Viewport rectangle in pixels, inclusive. Pass
   *   null/undefined to disable the viewport retirement rule entirely; a
   *   partial or non-finite rectangle is refused rather than treated as "no
   *   bounds", since every comparison against an undefined edge is false and
   *   the field would leak off-screen forever with no visible error.
   * @param {((i: number, system: object) => void)|null} [options.spawn=null] -
   *   Called for each dead particle; should call `system.respawn(i, x, y)` to
   *   place it. Use `system.random()` for any randomness so the run stays
   *   reproducible.
   * @param {'euler'|'midpoint'} [options.integrator='euler'] - Forward Euler
   *   (one lookup, local error O(dt^2)) or explicit midpoint (two lookups,
   *   O(dt^3)). Midpoint retires the particle if the midpoint lookup misses.
   *   Any other value is refused rather than quietly falling back to Euler.
   * @returns {number} Living particles after the step.
   * @throws {Error} If `velocityAt` is not a function, `dt` is not a
   *   non-negative finite number, `bounds` is a malformed or inverted
   *   rectangle, `spawn` is a non-null non-function, or `integrator` is
   *   unrecognised. Every one of these otherwise fails silently — as a frozen
   *   field, a field that never retires, or a field that dies whole on the
   *   first step — which is indistinguishable from a data outage on screen.
   */
  function step({ velocityAt, dt = 1, bounds = null, spawn = null, integrator = 'euler' } = {}) {
    if (typeof velocityAt !== 'function') throw new Error('step requires a velocityAt(x, y) function');
    if (!Number.isFinite(dt) || dt < 0) throw new Error(`step dt must be finite and >= 0, got ${dt}`);
    if (spawn !== null && spawn !== undefined && typeof spawn !== 'function') {
      throw new Error('step spawn must be a function or null');
    }
    // null reads as "unset" here, as it does for bounds and spawn: a config
    // object that carries integrator: null means the default, not a typo.
    if (integrator !== 'euler' && integrator !== 'midpoint'
      && integrator !== null && integrator !== undefined) {
      throw new Error(`step integrator must be 'euler' or 'midpoint', got ${integrator}`);
    }
    const midpoint = integrator === 'midpoint';
    const clip = bounds !== null && bounds !== undefined;
    let minX = 0;
    let minY = 0;
    let maxX = 0;
    let maxY = 0;
    if (clip) {
      ({ minX, minY, maxX, maxY } = bounds);
      if (!Number.isFinite(minX) || !Number.isFinite(minY)
        || !Number.isFinite(maxX) || !Number.isFinite(maxY)) {
        throw new Error('step bounds needs finite minX, minY, maxX, maxY (or null to disable)');
      }
      if (!(maxX >= minX) || !(maxY >= minY)) {
        throw new Error(`step bounds is inverted: x ${minX}..${maxX}, y ${minY}..${maxY}`);
      }
    }
    let living = 0;

    for (let i = 0; i < count; i += 1) {
      if (alive[i] === 1) {
        const px = x[i];
        const py = y[i];
        const vel = velocityAt(px, py);
        if (!vel || vel.ok !== true) {
          kill(i);
        } else {
          // Copy out before any second lookup: velocityAt may hand back the
          // same object every call (createFieldSampler does exactly that).
          let vx = vel.vx;
          let vy = vel.vy;
          const observed = vel.speedMs;
          let ok = true;
          if (midpoint) {
            const mid = velocityAt(px + 0.5 * dt * vx, py + 0.5 * dt * vy);
            if (!mid || mid.ok !== true) {
              ok = false;
            } else {
              vx = mid.vx;
              vy = mid.vy;
            }
          }
          if (!ok) {
            kill(i);
          } else {
            const nx = px + dt * vx;
            const ny = py + dt * vy;
            if (!Number.isFinite(nx) || !Number.isFinite(ny)) {
              kill(i);
            } else {
              prevX[i] = px;
              prevY[i] = py;
              x[i] = nx;
              y[i] = ny;
              speedMs[i] = Number.isFinite(observed) ? observed : NaN;
              const aged = age[i] + dt;
              age[i] = aged;
              if (aged >= life[i]) kill(i);
              else if (clip && (nx < minX || nx > maxX || ny < minY || ny > maxY)) kill(i);
            }
          }
        }
      }
      if (alive[i] === 0 && spawn) spawn(i, system);
      if (alive[i] === 1) living += 1;
    }
    return living;
  }

  return system;
}

/* ------------------------------------------------------------------ stats -- */

/**
 * Summary statistics of a field payload, for the legend and the provenance
 * readout.
 *
 * POPULATION. Every statistic is over the FINITE CELLS ONLY: grid cells where
 * both `u` and `v` are finite numbers, scored as speed = hypot(u, v) in m/s. A
 * half-observed cell (one component null) has no defined speed and is excluded,
 * as is every gap; gaps are counted, not imputed. `meanMs` is the arithmetic
 * mean of the per-cell speeds (mean of magnitudes, NOT the magnitude of the
 * mean current, which would be far smaller wherever flow reverses), summed with
 * Neumaier compensation so a million-cell global field does not drift. `p95Ms`
 * is the nearest-rank 95th percentile — sorted ascending, index
 * ceil(0.95*finite) - 1, no interpolation between order statistics
 * [Hyndman & Fan 1996, type 1]. Cells are weighted equally: this is a per-cell
 * distribution, not an area-weighted one, so a global grid over-weights high
 * latitudes by 1/cos(lat).
 *
 * Cost is one O(n) pass plus a sort of the finite subset, and a temporary
 * Float64Array of `finite` entries — call it once per payload, not per frame.
 *
 * @param {{grid: object, u: Array<number|null>, v: Array<number|null>}} payload
 *   - Field payload.
 * @returns {{minMs: number|null, maxMs: number|null, meanMs: number|null,
 *   p95Ms: number|null, finite: number, total: number}} Statistics in m/s;
 *   the four values are null (not 0, not NaN) when no cell is finite, so a
 *   legend renders "no data" instead of a flat calm ocean. `total` is
 *   nLat*nLon, `finite` the size of the population above.
 * @throws {Error} On a malformed grid or components whose length disagrees
 *   with it.
 */
export function fieldStats(payload) {
  const { nLat, nLon } = readGrid(payload && payload.grid);
  const total = nLat * nLon;
  const u = payload && payload.u;
  const v = payload && payload.v;
  for (const [name, values] of [['u', u], ['v', v]]) {
    // Same rejection as toFloat32: anything that is not an Array or a typed
    // array would index to non-numbers, count as zero finite cells, and report
    // a perfectly well-formed "no data anywhere" for a payload that is simply
    // the wrong shape.
    if (values && !Array.isArray(values) && !ArrayBuffer.isView(values)) {
      throw new Error(`ocean field payload.${name} must be an Array or a typed array`);
    }
  }
  if (!u || typeof u.length !== 'number' || u.length !== total) {
    throw new Error(`ocean field payload.u has ${u ? u.length : 'no'} entries, grid needs ${total}`);
  }
  if (!v || typeof v.length !== 'number' || v.length !== total) {
    throw new Error(`ocean field payload.v has ${v ? v.length : 'no'} entries, grid needs ${total}`);
  }

  let finite = 0;
  for (let i = 0; i < total; i += 1) {
    if (Number.isFinite(u[i]) && Number.isFinite(v[i])) finite += 1;
  }
  if (finite === 0) {
    return { minMs: null, maxMs: null, meanMs: null, p95Ms: null, finite: 0, total };
  }

  const speeds = new Float64Array(finite);
  let n = 0;
  let minMs = Infinity;
  let maxMs = -Infinity;
  // Neumaier compensated summation: error bound independent of n.
  let sum = 0;
  let comp = 0;
  for (let i = 0; i < total; i += 1) {
    const uu = u[i];
    const vv = v[i];
    if (!Number.isFinite(uu) || !Number.isFinite(vv)) continue;
    // sqrt(u^2+v^2), not Math.hypot: hypot's scaling guard buys nothing for
    // O(1) m/s velocities (overflow needs ~1e154) and costs ~10x on the
    // million-cell global grid this runs over.
    const s = Math.sqrt(uu * uu + vv * vv);
    speeds[n] = s;
    n += 1;
    if (s < minMs) minMs = s;
    if (s > maxMs) maxMs = s;
    const t = sum + s;
    comp += Math.abs(sum) >= Math.abs(s) ? (sum - t) + s : (s - t) + sum;
    sum = t;
  }
  speeds.sort();
  const rank = Math.min(finite - 1, Math.max(0, Math.ceil(0.95 * finite) - 1));
  return {
    minMs,
    maxMs,
    meanMs: (sum + comp) / finite,
    p95Ms: speeds[rank],
    finite,
    total,
  };
}
