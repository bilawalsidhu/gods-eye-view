/**
 * Stochastic leeway drift model — pure math, no Cesium/DOM/network.
 *
 * Formulation (Breivik & Allen 2008): a drifting object moves with the
 * surface current plus a leeway response to the 10 m wind, split into a
 * downwind component and a signed crosswind component. Each component is
 * linear in wind speed, L = (slope/100)·W10 + offset/100 [m/s], with a
 * per-particle Gaussian perturbation whose scale is the taxonomy's
 * regression standard error, and the crosswind sign flips through rare
 * "jibing" events at an exponential rate.
 *
 * Coefficients: USCG leeway taxonomy, PIW-1 "Person-in-water, unknown
 * state (mean values)" — transcribed 2026-08-28 from the OBJECTPROP table
 * distributed with met.no's OpenDrift Leeway model (values originally from
 * Allen & Plourde 1999 and Allen 2005):
 *   downwind  slope 0.96 % of W10, offset 0 cm/s, std error 12.0 cm/s
 *   crosswind slope ±0.54 %,       offset 0 cm/s, std error  9.4 cm/s
 *   jibing    0.04 / hour (OpenDrift default), applied per step as
 *             p = 1 − exp(−λ·Δt), λ = −ln(1 − rate)/3600 s⁻¹
 *
 * Sources:
 * - Allen, A.A. & J.V. Plourde (1999): Review of Leeway: Field Experiments
 *   and Implementation. USCG R&D Center report CG-D-08-99.
 * - Allen, A.A. (2005): Leeway Divergence. USCG R&D Center CG-D-05-05.
 * - Breivik, Ø. & A.A. Allen (2008): An operational search and rescue model
 *   for the Norwegian Sea and the North Sea. J. Marine Systems 69(1-2).
 * - OpenDrift Leeway model (met.no), OBJECTPROP.DAT + leeway.py — the
 *   machine-readable taxonomy and the per-step jibe formula mirrored here.
 *
 * Time integration is classical RK4 on dx/dt = v(x, t) over forecast fields
 * interpolated bilinearly in space and linearly in time. The per-particle
 * leeway perturbation, crosswind sign, and turbulence draw are held constant
 * across the four stages of a step (the stochastic terms are step-piecewise
 * constant, so RK4's order applies to the deterministic forcing part).
 * Particle 0 carries no stochastic terms at all: it is the deterministic
 * best-estimate track.
 */

import { maskStateAt, MASK_LAND } from '../data/landSeaMaskCodec.js';

export const EARTH_RADIUS_M = 6371000;

const DEG = Math.PI / 180;

export const LEEWAY_CLASSES = Object.freeze({
  PIW: Object.freeze({
    label: 'Person in water (unknown state)',
    downwind: Object.freeze({ slopePct: 0.96, offsetCms: 0, stdCms: 12.0 }),
    crosswind: Object.freeze({ slopePct: 0.54, offsetCms: 0, stdCms: 9.4 }),
    jibeRatePerHour: 0.04,
  }),
});

/**
 * Deterministic 32-bit RNG (mulberry32). Same seed → same stream, across
 * main thread and worker.
 * @param {number} seed - Any finite number; hashed to 32 bits.
 * @returns {() => number} Uniform [0, 1) generator.
 */
export function makeRng(seed) {
  let state = (Math.trunc(seed) >>> 0) || 0x9e3779b9;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Standard normal draw (Box–Muller) from a uniform generator. */
export function randn(rng) {
  let u = 0;
  while (u === 0) u = rng(); // avoid log(0)
  const v = rng();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

/**
 * Meteorological direction (FROM, degrees clockwise from north) → east/north
 * velocity components. A wind "from 270°" blows toward the east.
 * @param {number} speedMs - Wind speed, m/s.
 * @param {number} fromDeg - Direction the wind comes FROM.
 * @returns {{u: number, v: number}} East (u) and north (v) components, m/s.
 */
export function metFromDirToUV(speedMs, fromDeg) {
  const toRad = (fromDeg + 180) * DEG;
  return { u: speedMs * Math.sin(toRad), v: speedMs * Math.cos(toRad) };
}

/**
 * Oceanographic direction (TO, degrees clockwise from north) → east/north
 * velocity components. A current "toward 90°" flows east. The wind/current
 * FROM-vs-TO asymmetry is the classic leeway sign bug — it lives in exactly
 * these two functions and nowhere else.
 * @param {number} speedMs - Current speed, m/s.
 * @param {number} toDeg - Direction the current flows TOWARD.
 * @returns {{u: number, v: number}}
 */
export function oceanToDirToUV(speedMs, toDeg) {
  const toRad = toDeg * DEG;
  return { u: speedMs * Math.sin(toRad), v: speedMs * Math.cos(toRad) };
}

/**
 * Per-step jibe probability from an hourly rate: p = 1 − exp(−λ·Δt) with
 * λ = −ln(1 − ratePerHour)/3600 (the OpenDrift formulation).
 * @param {number} ratePerHour - Jibe probability per hour (0 disables).
 * @param {number} dtS - Time step, seconds.
 * @returns {number}
 */
export function perStepJibeProbability(ratePerHour, dtS) {
  if (!(ratePerHour > 0) || !(dtS > 0)) return 0;
  const lambda = -Math.log(1 - Math.min(ratePerHour, 0.999999)) / 3600;
  return 1 - Math.exp(-lambda * dtS);
}

/**
 * Build a forcing sampler over a normalized grid:
 * `{lats, lons, hoursMs, currentU, currentV, windU, windV}` where each field
 * is a flat array of length `hoursMs.length × lats.length × lons.length`,
 * hour-major then lat-major (`field[(t·NLAT + iLat)·NLON + iLon]`).
 *
 * Bilinear in space, linear in time, clamped at the grid edges. NaN values
 * (forecast holes) sample as 0 with `degraded: true` — a gap must never
 * inject NaN into particle positions, and the caller surfaces degradation
 * honestly instead of inventing forcing.
 *
 * @param {Object} grid - Normalized forcing grid.
 * @returns {(lat: number, lon: number, tMs: number) =>
 *   {curU: number, curV: number, windU: number, windV: number, degraded: boolean}}
 */
export function makeForcingSampler(grid) {
  const { lats, lons, hoursMs } = grid;
  const NLAT = lats.length;
  const NLON = lons.length;

  const bracket = (values, x) => {
    if (x <= values[0]) return { i0: 0, i1: 0, w: 0 };
    const last = values.length - 1;
    if (x >= values[last]) return { i0: last, i1: last, w: 0 };
    let i = 0;
    while (values[i + 1] < x) i += 1;
    const span = values[i + 1] - values[i];
    return { i0: i, i1: i + 1, w: span > 0 ? (x - values[i]) / span : 0 };
  };

  const firstHourMs = hoursMs[0];
  const lastHourMs = hoursMs[hoursMs.length - 1];

  return (lat, lon, tMs) => {
    const bLat = bracket(lats, lat);
    const bLon = bracket(lons, lon);
    const bT = bracket(hoursMs, tMs);
    let degraded = false;
    // A time outside the forcing axis is clamped to the end hour by bracket(),
    // which silently freezes the field rather than failing. That is a DIFFERENT
    // failure from a NaN value and must be reported separately: `degraded` only
    // ever tripped on non-finite samples, so a run integrating hours past the
    // end of the forecast reported itself perfectly healthy.
    const clampedInTime = tMs < firstHourMs || tMs > lastHourMs;

    const cell = (field, t, iLat, iLon) => {
      const value = field[(t * NLAT + iLat) * NLON + iLon];
      if (Number.isFinite(value)) return value;
      degraded = true;
      return 0;
    };
    const bilinear = (field, t) => {
      const v00 = cell(field, t, bLat.i0, bLon.i0);
      const v01 = cell(field, t, bLat.i0, bLon.i1);
      const v10 = cell(field, t, bLat.i1, bLon.i0);
      const v11 = cell(field, t, bLat.i1, bLon.i1);
      const v0 = v00 + (v01 - v00) * bLon.w;
      const v1 = v10 + (v11 - v10) * bLon.w;
      return v0 + (v1 - v0) * bLat.w;
    };
    const sample = (field) => {
      const early = bilinear(field, bT.i0);
      if (bT.i0 === bT.i1) return early;
      return early + (bilinear(field, bT.i1) - early) * bT.w;
    };

    return {
      curU: sample(grid.currentU),
      curV: sample(grid.currentV),
      windU: sample(grid.windU),
      windV: sample(grid.windV),
      degraded,
      clampedInTime,
    };
  };
}

/**
 * Build a land test from either beaching forcing form. Pure and worker-safe —
 * no allocation inside the returned closure.
 *
 * Forms:
 * - `{type: 'bathy', lats, lons, z}` — ETOPO-style grid, `z` row-major
 *   (lat-major) elevation in meters; nearest cell decides, z >= 0 means land
 *   (the rule from the Catalina drift project). Assumes uniform spacing;
 *   indices clamp to the grid edges.
 * - `{type: 'mask', width, height, data}` — packed 2-bit bitmask; land ONLY
 *   when the cell state is MASK_LAND — coastal-mixed cells never beach.
 *
 * @param {Object|null} landMask - Beaching forcing, or null/unknown for none.
 * @returns {((lat: number, lon: number) => boolean) | null}
 */
export function makeLandTester(landMask) {
  if (!landMask) return null;
  if (landMask.type === 'bathy') {
    const { lats, lons, z } = landMask;
    const nLat = lats.length;
    const nLon = lons.length;
    const lat0 = lats[0];
    const lon0 = lons[0];
    // Uniform spacing: index by rounding, clamped — no per-call search.
    const dLat = nLat > 1 ? (lats[nLat - 1] - lat0) / (nLat - 1) : 1;
    const dLon = nLon > 1 ? (lons[nLon - 1] - lon0) / (nLon - 1) : 1;
    return (lat, lon) => {
      const row = Math.min(nLat - 1, Math.max(0, Math.round((lat - lat0) / dLat)));
      const col = Math.min(nLon - 1, Math.max(0, Math.round((lon - lon0) / dLon)));
      return z[row * nLon + col] >= 0;
    };
  }
  if (landMask.type === 'mask') {
    return (lat, lon) => maskStateAt(landMask, lat, lon) === MASK_LAND;
  }
  return null;
}

/**
 * Great-circle distance (haversine, R = 6371 km) between two lat/lon points.
 * @param {number} lat1 @param {number} lon1 @param {number} lat2
 * @param {number} lon2
 * @returns {number} Distance in kilometers.
 */
function haversineKm(lat1, lon1, lat2, lon2) {
  const dLat = (lat2 - lat1) * DEG;
  const dLon = (lon2 - lon1) * DEG;
  const a = Math.sin(dLat / 2) ** 2
    + Math.cos(lat1 * DEG) * Math.cos(lat2 * DEG) * Math.sin(dLon / 2) ** 2;
  return 2 * 6371 * Math.asin(Math.sqrt(Math.min(1, a)));
}

/**
 * Run a full leeway Monte Carlo ensemble.
 *
 * Per particle, seeded once: an initial position scatter (`posSigmaM`),
 * additive downwind/crosswind velocity residuals ~N(0, stdCms/100), and a
 * 50/50 crosswind sign that may jibe each step. Per step: velocity =
 * current + downwind leeway along the wind unit vector + signed crosswind
 * leeway along its right-perpendicular (+ optional per-step turbulence),
 * advanced on the sphere with classical RK4.
 *
 * Particle 0 is the deterministic best-estimate track: no initial scatter,
 * zero leeway residuals, no jibe, no turbulence, and no crosswind term at
 * all — the ±1 crosswind sign makes that term bimodal with mean ≈ 0, so the
 * best estimate excludes it rather than picking a sign. Its random numbers
 * are still drawn (and discarded) exactly like any other particle's, so
 * particles 1..n−1 see bit-identical rng streams regardless of how the
 * control particle is treated.
 *
 * @param {Object} options
 * @param {number} options.n Particle count.
 * @param {number} options.seedLat Seed latitude, degrees.
 * @param {number} options.seedLon Seed longitude, degrees.
 * @param {number} options.startTimeMs Epoch ms of the drift start.
 * @param {number} options.horizonH Simulation horizon, hours.
 * @param {number} options.dtMin Time step, minutes.
 * @param {Object} options.grid Normalized forcing grid (makeForcingSampler).
 * @param {number} options.rngSeed Deterministic ensemble seed.
 * @param {string} [options.cls='PIW'] Leeway class key.
 * @param {Object} [options.classOverrides] Test/tuning overrides merged onto the class.
 * @param {number} [options.posSigmaM=100] Initial position scatter, meters.
 * @param {number} [options.sigmaTurbMs=0] Per-step turbulent velocity noise,
 *   m/s: each perturbed particle adds (du, dv) ~ N(0, σ) drawn once per step
 *   and held across the four RK4 stages. 0 leaves the rng stream untouched.
 * @param {boolean} [options.backward=false] Integrate backward in time:
 *   timesMs decrease from startTimeMs (frames stay in integration order).
 *   Beaching applies identically — a reverse-drifting particle freezing on
 *   land answers "could they have come from shore".
 * @param {Object|null} [options.landMask=null] Beaching forcing for
 *   {@link makeLandTester}; null disables beaching (frames bit-identical to
 *   the pre-beaching model).
 * @returns {{timesMs: Float64Array, frames: Float32Array,
 *   beachedAtFrame: Int32Array, n: number, degraded: boolean,
 *   clampedInTime: boolean, clampedFrames: number, frameCount: number,
 *   meanEndLat: number, meanEndLon: number, spreadKm: number}}
 *   `degraded` reports non-finite forcing SAMPLES (zero-filled); the separate
 *   `clampedInTime`/`clampedFrames` report integration past the ends of the
 *   forcing time axis, where the field is frozen at its end hour. The two are
 *   different failures and a run can have either without the other.
 *   `frames` is frame-major `[lon, lat]` pairs: `frames[(t·n + i)·2]` = lon.
 *   `beachedAtFrame[i]` is the first frame particle i is frozen (−1 = never);
 *   frames stay dense — a beached particle re-records its last water position.
 *   `meanEndLat`/`meanEndLon` average the final-frame positions of ALL
 *   particles (beached ones at their frozen position); `spreadKm` is the RMS
 *   great-circle distance of those positions from that mean.
 */
export function runEnsemble({
  n,
  seedLat,
  seedLon,
  startTimeMs,
  horizonH,
  dtMin,
  grid,
  rngSeed,
  cls = 'PIW',
  classOverrides = null,
  posSigmaM = 100,
  sigmaTurbMs = 0,
  backward = false,
  landMask = null,
}) {
  const base = LEEWAY_CLASSES[cls] ?? LEEWAY_CLASSES.PIW;
  const config = classOverrides ? { ...base, ...classOverrides } : base;
  const rng = makeRng(rngSeed);
  const sampler = makeForcingSampler(grid);
  const isLand = makeLandTester(landMask);

  const dtS = dtMin * 60;
  const dtSigned = backward ? -dtS : dtS;
  const steps = Math.max(1, Math.round((horizonH * 3600) / dtS));
  const jibeP = perStepJibeProbability(config.jibeRatePerHour, dtS);

  const lat = new Float64Array(n);
  const lon = new Float64Array(n);
  const downEps = new Float64Array(n);
  const crossEps = new Float64Array(n);
  const crossSign = new Float64Array(n);

  const scatterDeg = posSigmaM / EARTH_RADIUS_M / DEG;
  const cosSeed = Math.cos(seedLat * DEG);
  for (let i = 0; i < n; i += 1) {
    lat[i] = seedLat + randn(rng) * scatterDeg;
    lon[i] = seedLon + (randn(rng) * scatterDeg) / cosSeed;
    downEps[i] = randn(rng) * (config.downwind.stdCms / 100);
    crossEps[i] = randn(rng) * (config.crosswind.stdCms / 100);
    crossSign[i] = rng() < 0.5 ? -1 : 1;
  }
  // Particle 0 is the deterministic control track: its draws above were
  // consumed (keeping particles 1..n−1 on bit-identical streams) but are
  // discarded here. crossSign[0] is never read — the control particle has
  // no crosswind term (the ±1 sign bimodality has mean ≈ 0).
  if (n > 0) {
    lat[0] = seedLat;
    lon[0] = seedLon;
    downEps[0] = 0;
    crossEps[0] = 0;
  }

  const timesMs = new Float64Array(steps + 1);
  const frames = new Float32Array((steps + 1) * n * 2);
  const beachedAtFrame = new Int32Array(n).fill(-1);
  let degraded = false;
  let clampedFrames = 0;
  let clampedInTime = false;

  const record = (frame) => {
    const offset = frame * n * 2;
    for (let i = 0; i < n; i += 1) {
      frames[offset + i * 2] = lon[i];
      frames[offset + i * 2 + 1] = lat[i];
    }
  };

  timesMs[0] = startTimeMs;
  record(0);

  const downSlope = config.downwind.slopePct / 100;
  const downOffset = config.downwind.offsetCms / 100;
  const crossSlope = config.crosswind.slopePct / 100;
  const crossOffset = config.crosswind.offsetCms / 100;

  // One RK4 stage: sample the forcing at (pLat, pLon, tMs), add the leeway
  // response and the step-held turbulence (du, dv), and return the position
  // rate in deg/s using THIS stage's latitude for the metric factor.
  const stageRate = (i, pLat, pLon, tMs, du, dv) => {
    const forcing = sampler(pLat, pLon, tMs);
    if (forcing.degraded) degraded = true;
    if (forcing.clampedInTime) clampedInTime = true;

    let vE = forcing.curU + du;
    let vN = forcing.curV + dv;
    const windSpeed = Math.hypot(forcing.windU, forcing.windV);
    if (windSpeed > 0) {
      const wU = forcing.windU / windSpeed;
      const wV = forcing.windV / windSpeed;
      if (i === 0) {
        // Control particle: pure current + mean downwind response only.
        const down = downSlope * windSpeed + downOffset;
        vE += down * wU;
        vN += down * wV;
      } else {
        const down = downSlope * windSpeed + downOffset + downEps[i];
        const cross = crossSign[i] * (crossSlope * windSpeed + crossOffset + crossEps[i]);
        // Right-perpendicular of the downwind unit vector: (v, −u).
        vE += down * wU + cross * wV;
        vN += down * wV + cross * -wU;
      }
    }

    const cosLat = Math.cos(pLat * DEG);
    return {
      dLat: (vN / EARTH_RADIUS_M) / DEG,
      dLon: (vE / (EARTH_RADIUS_M * (cosLat || 1e-9))) / DEG,
    };
  };

  for (let step = 1; step <= steps; step += 1) {
    // Stage times for this step: t0 = start of step, in signed time.
    const t0 = startTimeMs + (step - 1) * dtSigned * 1000;
    const tHalf = t0 + dtSigned * 500;
    const t1 = t0 + dtSigned * 1000;
    for (let i = 0; i < n; i += 1) {
      // Beached particles are frozen: no sampling, no rng draws; record()
      // re-emits the held position so frames stay dense for scrubbing.
      if (beachedAtFrame[i] !== -1) continue;

      // Turbulence: one (du, dv) draw per step, held across all four stages.
      // The draws are consumed for the control particle too (and discarded)
      // so particles 1..n−1 keep bit-identical streams.
      let du = 0;
      let dv = 0;
      if (sigmaTurbMs > 0) {
        const gu = randn(rng);
        const gv = randn(rng);
        if (i !== 0) {
          du = gu * sigmaTurbMs;
          dv = gv * sigmaTurbMs;
        }
      }

      // Classical RK4 on dx/dt = v(x, t). The stochastic terms (leeway
      // residuals, crosswind sign, turbulence) are constant across the four
      // stages, so RK4's order applies to the deterministic forcing part.
      const k1 = stageRate(i, lat[i], lon[i], t0, du, dv);
      const k2 = stageRate(i, lat[i] + k1.dLat * dtSigned / 2, lon[i] + k1.dLon * dtSigned / 2, tHalf, du, dv);
      const k3 = stageRate(i, lat[i] + k2.dLat * dtSigned / 2, lon[i] + k2.dLon * dtSigned / 2, tHalf, du, dv);
      const k4 = stageRate(i, lat[i] + k3.dLat * dtSigned, lon[i] + k3.dLon * dtSigned, t1, du, dv);
      const nextLat = lat[i] + (dtSigned / 6) * (k1.dLat + 2 * k2.dLat + 2 * k3.dLat + k4.dLat);
      const nextLon = lon[i] + (dtSigned / 6) * (k1.dLon + 2 * k2.dLon + 2 * k3.dLon + k4.dLon);

      if (isLand !== null && isLand(nextLat, nextLon)) {
        // Freeze at the LAST WATER position; no jibe draw on this step.
        beachedAtFrame[i] = step;
        continue;
      }
      lat[i] = nextLat;
      lon[i] = nextLon;

      // Jibe draw AFTER the position update, once per step. Consumed for the
      // control particle too, but crossSign[0] is never read.
      if (jibeP > 0 && rng() < jibeP) crossSign[i] = -crossSign[i];
    }
    timesMs[step] = t1;
    // Frames whose own timestamp falls outside the forcing axis are integrated
    // on a frozen end-hour field; count them so the panel can say how much of
    // the run is extrapolation rather than forecast.
    if (t1 < grid.hoursMs[0] || t1 > grid.hoursMs[grid.hoursMs.length - 1]) clampedFrames += 1;
    record(step);
  }

  // Ensemble diagnostics over ALL particles (beached ones sit frozen at
  // their last water position in lat/lon, so they are included as-is).
  let sumLat = 0;
  let sumLon = 0;
  for (let i = 0; i < n; i += 1) {
    sumLat += lat[i];
    sumLon += lon[i];
  }
  const meanEndLat = n > 0 ? sumLat / n : seedLat;
  const meanEndLon = n > 0 ? sumLon / n : seedLon;
  let sumSqKm = 0;
  for (let i = 0; i < n; i += 1) {
    sumSqKm += haversineKm(meanEndLat, meanEndLon, lat[i], lon[i]) ** 2;
  }
  const spreadKm = n > 0 ? Math.sqrt(sumSqKm / n) : 0;

  return {
    timesMs,
    frames,
    beachedAtFrame,
    n,
    degraded,
    clampedInTime,
    clampedFrames,
    frameCount: steps + 1,
    meanEndLat,
    meanEndLon,
    spreadKm,
  };
}
