import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  LEEWAY_CLASSES,
  EARTH_RADIUS_M,
  makeRng,
  randn,
  metFromDirToUV,
  oceanToDirToUV,
  perStepJibeProbability,
  makeForcingSampler,
  makeLandTester,
  runEnsemble,
} from './leeway.js';
import { packMaskStates, MASK_WATER, MASK_LAND, MASK_COASTAL } from '../data/landSeaMaskCodec.js';

/** Uniform 2x2x2 forcing grid: constant current + wind everywhere. */
function constantGrid({ curU = 0, curV = 0, windU = 0, windV = 0 } = {}) {
  const nodes = 4;
  const hours = 2;
  const fill = (value) => Float32Array.from({ length: nodes * hours }, () => value);
  return {
    lats: [33, 34],
    lons: [-119, -118],
    hoursMs: [Date.UTC(2026, 7, 29, 0, 0), Date.UTC(2026, 7, 30, 0, 0)],
    currentU: fill(curU),
    currentV: fill(curV),
    windU: fill(windU),
    windV: fill(windV),
  };
}

const SEED_LAT = 33.5;
const SEED_LON = -118.5;
const M_PER_RAD = EARTH_RADIUS_M;

function meanDisplacementMeters(result, n) {
  const frames = result.frames;
  const T = result.timesMs.length;
  const last = (T - 1) * n * 2;
  let dLonDeg = 0;
  let dLatDeg = 0;
  for (let i = 0; i < n; i += 1) {
    dLonDeg += frames[last + i * 2] - SEED_LON;
    dLatDeg += frames[last + i * 2 + 1] - SEED_LAT;
  }
  dLonDeg /= n;
  dLatDeg /= n;
  const east = (dLonDeg * Math.PI / 180) * M_PER_RAD * Math.cos(SEED_LAT * Math.PI / 180);
  const north = (dLatDeg * Math.PI / 180) * M_PER_RAD;
  return { east, north };
}

test('PIW leeway coefficients are the published USCG taxonomy values', () => {
  const piw = LEEWAY_CLASSES.PIW;
  assert.equal(piw.downwind.slopePct, 0.96);
  assert.equal(piw.downwind.offsetCms, 0);
  assert.equal(piw.downwind.stdCms, 12.0);
  assert.equal(piw.crosswind.slopePct, 0.54);
  assert.equal(piw.crosswind.offsetCms, 0);
  assert.equal(piw.crosswind.stdCms, 9.4);
  assert.equal(piw.jibeRatePerHour, 0.04);
});

test('direction conventions: wind is FROM, current is TO', () => {
  const westWind = metFromDirToUV(10, 270); // FROM west → blowing east
  assert.ok(Math.abs(westWind.u - 10) < 1e-9);
  assert.ok(Math.abs(westWind.v) < 1e-9);
  const northWind = metFromDirToUV(5, 0); // FROM north → blowing south
  assert.ok(Math.abs(northWind.u) < 1e-9);
  assert.ok(Math.abs(northWind.v + 5) < 1e-9);
  const eastCurrent = oceanToDirToUV(1, 90); // TO east
  assert.ok(Math.abs(eastCurrent.u - 1) < 1e-9);
  assert.ok(Math.abs(eastCurrent.v) < 1e-9);
});

test('per-step jibe probability matches the exponential-rate closed form', () => {
  // λ = -ln(1 - 0.04)/3600 s⁻¹; p(600 s) = 1 - exp(-λ·600)
  const expected = 1 - Math.exp(Math.log(1 - 0.04) * 600 / 3600);
  assert.ok(Math.abs(perStepJibeProbability(0.04, 600) - expected) < 1e-12);
  assert.equal(perStepJibeProbability(0, 600), 0);
});

test('rng is deterministic and randn produces both signs', () => {
  const a = makeRng(42);
  const b = makeRng(42);
  for (let i = 0; i < 5; i += 1) assert.equal(a(), b());
  const rng = makeRng(7);
  const draws = Array.from({ length: 100 }, () => randn(rng));
  assert.ok(draws.some((x) => x > 0) && draws.some((x) => x < 0));
});

test('forcing sampler reproduces a bilinear field and interpolates time linearly', () => {
  const grid = constantGrid();
  // Make currentU vary linearly with lon index at hour 0: nodes are lat-major.
  grid.currentU = Float32Array.from([0, 1, 0, 1, /* hour 1: */ 2, 3, 2, 3]);
  const sampler = makeForcingSampler(grid);
  const midLon = sampler(33, -118.5, grid.hoursMs[0]);
  assert.ok(Math.abs(midLon.curU - 0.5) < 1e-6, 'spatial midpoint of 0..1');
  const midTime = sampler(33, -119, (grid.hoursMs[0] + grid.hoursMs[1]) / 2);
  assert.ok(Math.abs(midTime.curU - 1) < 1e-6, 'time midpoint of 0..2');
  assert.equal(midTime.degraded, false);
});

test('forcing sampler zero-fills NaN nodes and flags degradation', () => {
  const grid = constantGrid({ curU: 0.5 });
  grid.currentU[0] = NaN;
  const sampler = makeForcingSampler(grid);
  const sample = sampler(33, -119, grid.hoursMs[0]);
  assert.ok(Number.isFinite(sample.curU));
  assert.equal(sample.degraded, true);
});

test('same seed → identical ensemble; different seed → different ensemble', () => {
  const options = {
    n: 64, seedLat: SEED_LAT, seedLon: SEED_LON,
    startTimeMs: Date.UTC(2026, 7, 29, 0, 0), horizonH: 2, dtMin: 10,
    grid: constantGrid({ curU: 0.3, windV: 8 }), rngSeed: 1234,
  };
  const a = runEnsemble(options);
  const b = runEnsemble(options);
  assert.deepEqual(Array.from(a.frames), Array.from(b.frames));
  const c = runEnsemble({ ...options, rngSeed: 999 });
  assert.notDeepEqual(Array.from(a.frames), Array.from(c.frames));
});

test('constant current + wind: ensemble mean drift matches the hand-computed leeway expectation', () => {
  const n = 2000;
  const horizonH = 6;
  // Current 0.3 m/s east; wind 10 m/s blowing north (FROM south).
  const result = runEnsemble({
    n, seedLat: SEED_LAT, seedLon: SEED_LON,
    startTimeMs: Date.UTC(2026, 7, 29, 0, 0), horizonH, dtMin: 10,
    grid: constantGrid({ curU: 0.3, windV: 10 }), rngSeed: 42,
  });
  const T = horizonH * 3600;
  const { east, north } = meanDisplacementMeters(result, n);
  // East: current only (crosswind signs are balanced) → 0.3 · 21600 = 6480 m.
  assert.ok(Math.abs(east - 0.3 * T) < 300, `east ${east.toFixed(0)} m vs ${0.3 * T} m`);
  // North: downwind leeway 0.96 % of 10 m/s = 0.096 m/s → 2073.6 m.
  assert.ok(Math.abs(north - 0.096 * T) < 300, `north ${north.toFixed(0)} m vs ${(0.096 * T).toFixed(0)} m`);
});

test('crosswind spreads symmetrically and jibing tightens the crosswind spread', () => {
  const base = {
    n: 1000, seedLat: SEED_LAT, seedLon: SEED_LON,
    startTimeMs: Date.UTC(2026, 7, 29, 0, 0), horizonH: 6, dtMin: 10,
    grid: constantGrid({ windV: 10 }), rngSeed: 5,
  };
  const noJibe = runEnsemble({ ...base, classOverrides: { jibeRatePerHour: 0 } });
  const fastJibe = runEnsemble({ ...base, classOverrides: { jibeRatePerHour: 20 } });

  const spreadEast = (result) => {
    const frames = result.frames;
    const last = (result.timesMs.length - 1) * base.n * 2;
    const lons = [];
    for (let i = 0; i < base.n; i += 1) lons.push(frames[last + i * 2]);
    const mean = lons.reduce((s, x) => s + x, 0) / lons.length;
    const variance = lons.reduce((s, x) => s + (x - mean) ** 2, 0) / lons.length;
    return { mean, sd: Math.sqrt(variance) };
  };

  const still = spreadEast(noJibe);
  // Balanced ± crosswind signs: the mean east displacement stays near zero
  // relative to the per-particle crosswind excursion (~1.2 km at 6 h).
  const meanEastM = (still.mean - SEED_LON) * Math.PI / 180 * M_PER_RAD * Math.cos(SEED_LAT * Math.PI / 180);
  assert.ok(Math.abs(meanEastM) < 200, `mean east ${meanEastM.toFixed(0)} m`);
  // Rapid jibing decorrelates the crosswind sign → tighter spread.
  assert.ok(spreadEast(fastJibe).sd < still.sd * 0.7, 'jibing must shrink crosswind dispersion');
});

/**
 * Bathymetry landMask: 3 lats x 5 lons, uniform spacing, z >= 0 means land.
 * Columns at lon >= -118.4 are land (a wall east of the seed) unless zLand
 * overrides the per-cell depth outright.
 */
function bathyWall({ zWater = -50, zLand = 0, allZ = null } = {}) {
  const lats = [33.4, 33.5, 33.6];
  const lons = [-118.5, -118.45, -118.4, -118.35, -118.3];
  const z = new Float64Array(lats.length * lons.length);
  for (let r = 0; r < lats.length; r += 1) {
    for (let c = 0; c < lons.length; c += 1) {
      z[r * lons.length + c] = allZ !== null ? allZ : (lons[c] >= -118.4 ? zLand : zWater);
    }
  }
  return { type: 'bathy', lats, lons, z };
}

/** Uniform-state packed bitmask landMask covering the whole globe coarsely. */
function uniformMask(state, width = 8, height = 4) {
  const states = new Uint8Array(width * height).fill(state);
  return { type: 'mask', width, height, data: packMaskStates(states) };
}

const WALL_OPTIONS = {
  n: 32, seedLat: 33.5, seedLon: -118.5,
  startTimeMs: Date.UTC(2026, 7, 29, 0, 0), horizonH: 6, dtMin: 10,
  grid: constantGrid({ curU: 0.5 }), rngSeed: 77, posSigmaM: 10,
};

test('no-mask frames are bit-identical to the pinned RK4 baseline and beachedAtFrame is all -1', () => {
  // Baseline captured by running runEnsemble on this exact scenario after
  // the RK4 + control-particle upgrade (scratch capture, 2026-08-29). Any
  // drift here means the step loop's arithmetic changed — the no-mask path
  // must stay byte-identical. Indices 0/1 and 16/17 are particle 0 (the
  // unscattered control track); 100/101 and 206/207 happen to match the old
  // Euler pins because with a spatially constant field the RK4−Euler
  // difference (~1e-8 deg) is below Float32 frame resolution (~7.6e-6 deg).
  const nodes = 4;
  const hours = 2;
  const fill = (v) => Float32Array.from({ length: nodes * hours }, () => v);
  const grid = {
    lats: [33, 34], lons: [-119, -118],
    hoursMs: [Date.UTC(2026, 7, 29, 0, 0), Date.UTC(2026, 7, 30, 0, 0)],
    currentU: fill(0.3), currentV: fill(-0.1), windU: fill(3), windV: fill(8),
  };
  const options = {
    n: 8, seedLat: 33.5, seedLon: -118.5,
    startTimeMs: Date.UTC(2026, 7, 29, 0, 0), horizonH: 2, dtMin: 10,
    grid, rngSeed: 1234,
  };
  const omitted = runEnsemble(options);
  assert.equal(omitted.frames.length, 208);
  const baseline = [
    [0, -118.5],
    [1, 33.5],
    [16, -118.49787139892578],
    [17, 33.499874114990234],
    [100, -118.48316955566406],
    [101, 33.498687744140625],
    [206, -118.47135925292969],
    [207, 33.49552917480469],
  ];
  for (const [k, value] of baseline) assert.equal(omitted.frames[k], value);
  assert.ok(omitted.beachedAtFrame instanceof Int32Array);
  assert.equal(omitted.beachedAtFrame.length, options.n);
  for (const value of omitted.beachedAtFrame) assert.equal(value, -1);
  const explicitNull = runEnsemble({ ...options, landMask: null });
  assert.deepEqual(Array.from(explicitNull.frames), Array.from(omitted.frames));
});

test('makeLandTester bathy: z >= 0 is land, z = -0.5 is water, nearest-cell clamped', () => {
  const isLand = makeLandTester(bathyWall());
  assert.equal(isLand(33.5, -118.5), false);
  assert.equal(isLand(33.5, -118.35), true);
  // Nearest cell: -118.43 rounds to the -118.45 water column; -118.42 to -118.4 land.
  assert.equal(isLand(33.5, -118.43), false);
  assert.equal(isLand(33.5, -118.42), true);
  // Clamped outside the grid to the nearest edge cell.
  assert.equal(isLand(90, -140), false);
  assert.equal(isLand(-90, 170), true);
  // z = -0.5 is water; z = 0 is land (the >= 0 rule exactly).
  assert.equal(makeLandTester(bathyWall({ allZ: -0.5 }))(33.5, -118.35), false);
  assert.equal(makeLandTester(bathyWall({ allZ: 0 }))(33.5, -118.5), true);
});

test('makeLandTester mask: land only when the cell state is MASK_LAND', () => {
  assert.equal(makeLandTester(uniformMask(MASK_LAND))(33.5, -118.5), true);
  assert.equal(makeLandTester(uniformMask(MASK_WATER))(33.5, -118.5), false);
  assert.equal(makeLandTester(uniformMask(MASK_COASTAL))(33.5, -118.5), false);
  assert.equal(makeLandTester(null), null);
});

test('bathy wall: particles beach at their last water position and stay frozen forever', () => {
  const result = runEnsemble({ ...WALL_OPTIONS, landMask: bathyWall() });
  const isLand = makeLandTester(bathyWall());
  const n = WALL_OPTIONS.n;
  const T = result.timesMs.length;
  for (let i = 0; i < n; i += 1) {
    const b = result.beachedAtFrame[i];
    assert.ok(b >= 1 && b < T, `particle ${i} must beach (got ${b})`);
    const lastWater = (b - 1) * n * 2 + i * 2;
    const frozenLon = result.frames[lastWater];
    const frozenLat = result.frames[lastWater + 1];
    // Frozen position is the last WATER position, never a land cell.
    assert.equal(isLand(frozenLat, frozenLon), false);
    for (let f = b; f < T; f += 1) {
      const off = f * n * 2 + i * 2;
      assert.equal(result.frames[off], frozenLon, `particle ${i} lon frame ${f}`);
      assert.equal(result.frames[off + 1], frozenLat, `particle ${i} lat frame ${f}`);
    }
  }
});

test('z = -0.5 everywhere never beaches; z = 0 everywhere beaches on the first step', () => {
  const wet = runEnsemble({ ...WALL_OPTIONS, landMask: bathyWall({ allZ: -0.5 }) });
  for (const value of wet.beachedAtFrame) assert.equal(value, -1);
  const dry = runEnsemble({ ...WALL_OPTIONS, landMask: bathyWall({ allZ: 0 }) });
  const n = WALL_OPTIONS.n;
  for (let i = 0; i < n; i += 1) {
    assert.equal(dry.beachedAtFrame[i], 1);
    // Frozen at the seed-scatter position recorded in frame 0.
    assert.equal(dry.frames[n * 2 + i * 2], dry.frames[i * 2]);
    assert.equal(dry.frames[n * 2 + i * 2 + 1], dry.frames[i * 2 + 1]);
  }
});

test('coastal bitmask cells never beach and leave the trajectory untouched', () => {
  const coastal = runEnsemble({ ...WALL_OPTIONS, landMask: uniformMask(MASK_COASTAL) });
  for (const value of coastal.beachedAtFrame) assert.equal(value, -1);
  const open = runEnsemble({ ...WALL_OPTIONS, landMask: null });
  assert.deepEqual(Array.from(coastal.frames), Array.from(open.frames));
});

test('ensemble with a landMask is deterministic under a fixed seed', () => {
  const a = runEnsemble({ ...WALL_OPTIONS, landMask: bathyWall() });
  const b = runEnsemble({ ...WALL_OPTIONS, landMask: bathyWall() });
  assert.deepEqual(Array.from(a.frames), Array.from(b.frames));
  assert.deepEqual(Array.from(a.beachedAtFrame), Array.from(b.beachedAtFrame));
});

test('RK4: constant-velocity drift matches the exact displacement to rounding', () => {
  // With a uniform current and no wind the RHS is the same at every RK4
  // stage, so the update is exact up to rounding (note: forward Euler is
  // exact here too — the discriminating order test is the next test).
  // The grid stores forcing as Float32, so the closed-form reference must
  // use the same truncated value: Math.fround(0.4), not 0.4.
  const horizonH = 6;
  const T = horizonH * 3600;
  const curU = Math.fround(0.4);
  const result = runEnsemble({
    n: 1, seedLat: SEED_LAT, seedLon: SEED_LON,
    startTimeMs: Date.UTC(2026, 7, 29, 0, 0), horizonH, dtMin: 20,
    grid: constantGrid({ curU: 0.4 }), rngSeed: 3,
  });
  // n = 1 → particle 0 is the deterministic control track, and meanEndLon
  // is computed from the Float64 state (frames are Float32, ~1e-7 relative).
  const dispLon = (curU * T / (EARTH_RADIUS_M * Math.cos(SEED_LAT * Math.PI / 180))) / (Math.PI / 180);
  assert.ok(Math.abs(result.meanEndLat - SEED_LAT) < 1e-12, `lat drifted ${result.meanEndLat}`);
  const relErr = Math.abs(result.meanEndLon - (SEED_LON + dispLon)) / dispLon;
  assert.ok(relErr < 1e-9, `relative lon error ${relErr}`);
});

test('RK4: lat-varying drift matches the secant-integral closed form at 1e-9 (Euler misses by ~1e-3)', () => {
  // Uniform current with vN ≠ 0: lat(t) = lat0 + (vN/R)t/DEG is linear, and
  // dlon/dt = vE/(R·cos φ)/DEG varies with lat, so
  //   Δlon = (vE/(vN·DEG))·[ln tan(π/4 + φ/2)]_{φ0}^{φT}   (∫sec φ dφ).
  // Forward Euler's global error here is ≈ (dt/2)·(f(T) − f(0)) ≈ 1.1e-3 deg
  // at dt = 20 min (f = the lon rate); classical RK4's O(dt⁴) term is far
  // below double rounding, so gate at 1e-9 deg and expect ~1e-13.
  const DEG = Math.PI / 180;
  const horizonH = 24;
  const T = horizonH * 3600;
  const vE = 2; // exactly representable in Float32
  const vN = 2;
  const lat0 = 60;
  const lon0 = 11;
  const result = runEnsemble({
    n: 1, seedLat: lat0, seedLon: lon0,
    startTimeMs: Date.UTC(2026, 7, 29, 0, 0), horizonH, dtMin: 20,
    grid: constantGrid({ curU: vE, curV: vN }), rngSeed: 3,
  });
  const phi0 = lat0 * DEG;
  const phiT = phi0 + (vN / EARTH_RADIUS_M) * T;
  const latExact = lat0 + ((vN / EARTH_RADIUS_M) * T) / DEG;
  const gd = (phi) => Math.log(Math.tan(Math.PI / 4 + phi / 2)); // inverse Gudermannian
  const lonExact = lon0 + (vE / (vN * DEG)) * (gd(phiT) - gd(phi0));
  assert.ok(Math.abs(result.meanEndLat - latExact) < 1e-9, `lat error ${result.meanEndLat - latExact}`);
  assert.ok(Math.abs(result.meanEndLon - lonExact) < 1e-9, `lon error ${result.meanEndLon - lonExact}`);
});

test('sigmaTurbMs adds per-step velocity noise: spread grows, and 0 is the identity', () => {
  const base = {
    n: 256, seedLat: SEED_LAT, seedLon: SEED_LON,
    startTimeMs: Date.UTC(2026, 7, 29, 0, 0), horizonH: 6, dtMin: 10,
    grid: constantGrid({ curU: 0.2 }), rngSeed: 21, posSigmaM: 50,
  };
  const calm = runEnsemble(base);
  const explicitZero = runEnsemble({ ...base, sigmaTurbMs: 0 });
  assert.deepEqual(Array.from(explicitZero.frames), Array.from(calm.frames),
    'sigmaTurbMs: 0 must not perturb the rng stream');
  const turb = runEnsemble({ ...base, sigmaTurbMs: 0.1 });
  assert.ok(turb.spreadKm > calm.spreadKm,
    `turbulent spread ${turb.spreadKm} must exceed calm spread ${calm.spreadKm}`);
});

test('particle 0 is the deterministic best-estimate track: seed-independent, current + downwind only', () => {
  const options = {
    n: 16, seedLat: SEED_LAT, seedLon: SEED_LON,
    startTimeMs: Date.UTC(2026, 7, 29, 0, 0), horizonH: 6, dtMin: 10,
    grid: constantGrid({ curU: 0.3, windV: 10 }), posSigmaM: 500,
  };
  const a = runEnsemble({ ...options, rngSeed: 1 });
  const b = runEnsemble({ ...options, rngSeed: 2 });
  const track = (result) => {
    const out = [];
    for (let t = 0; t < result.timesMs.length; t += 1) {
      out.push(result.frames[t * options.n * 2], result.frames[t * options.n * 2 + 1]);
    }
    return out;
  };
  // Deterministic given forcing: identical across different rng seeds.
  assert.deepEqual(track(a), track(b));
  // No initial scatter: frame 0 is exactly the seed (both exact in Float32).
  assert.equal(a.frames[0], Math.fround(SEED_LON));
  assert.equal(a.frames[1], Math.fround(SEED_LAT));
  // Final displacement = current east + downwind leeway north (no crosswind,
  // no eps): vE = fround(0.3), vN = 0.0096·10. Tolerance covers Float32 frame
  // rounding (~0.5 m) and the cos(lat) variation over the northward drift
  // (~1.5 m over 2.1 km of lat change).
  const T = 6 * 3600;
  const last = (a.timesMs.length - 1) * options.n * 2;
  const east = (a.frames[last] - SEED_LON) * Math.PI / 180 * M_PER_RAD * Math.cos(SEED_LAT * Math.PI / 180);
  const north = (a.frames[last + 1] - SEED_LAT) * Math.PI / 180 * M_PER_RAD;
  assert.ok(Math.abs(east - Math.fround(0.3) * T) < 25, `east ${east.toFixed(1)} m vs ${(0.3 * T).toFixed(1)} m`);
  assert.ok(Math.abs(north - 0.096 * T) < 25, `north ${north.toFixed(1)} m vs ${(0.096 * T).toFixed(1)} m`);
});

test('backward integration retraces a forward drift to its seed', () => {
  // n = 1 → the deterministic control particle: zero noise, ideal for the
  // reversal test (mirrors the Catalina backward-reverses-forward test).
  const grid = constantGrid({ curU: 0.3, curV: 0.15, windV: 8 });
  const options = {
    n: 1, seedLat: SEED_LAT, seedLon: SEED_LON,
    startTimeMs: Date.UTC(2026, 7, 29, 0, 0), horizonH: 6, dtMin: 10,
    grid, rngSeed: 9,
  };
  const fwd = runEnsemble(options);
  const endTime = fwd.timesMs[fwd.timesMs.length - 1];
  assert.ok(endTime > options.startTimeMs);
  const back = runEnsemble({
    ...options,
    seedLat: fwd.meanEndLat,
    seedLon: fwd.meanEndLon,
    startTimeMs: endTime,
    backward: true,
  });
  // timesMs decrease from the backward start; frames are in integration order.
  assert.equal(back.timesMs[0], endTime);
  for (let t = 1; t < back.timesMs.length; t += 1) {
    assert.ok(back.timesMs[t] < back.timesMs[t - 1], 'backward timesMs must decrease');
  }
  assert.equal(back.timesMs[back.timesMs.length - 1], options.startTimeMs);
  // RK4 is not exactly time-symmetric, but with near-uniform forcing the
  // reversal defect is far below 1e-8 deg (~1 mm).
  assert.ok(Math.abs(back.meanEndLat - SEED_LAT) < 1e-8, `lat defect ${back.meanEndLat - SEED_LAT}`);
  assert.ok(Math.abs(back.meanEndLon - SEED_LON) < 1e-8, `lon defect ${back.meanEndLon - SEED_LON}`);
});

test('meanEnd/spreadKm summarize the final frame over all particles', () => {
  // Zero-noise ensemble: no wind → no leeway eps or crosswind influence, so
  // every perturbed particle translates with the current and the final-frame
  // spread is exactly the initial scatter. With σ = 1 km per axis the RMS
  // great-circle distance from the mean is √(2σ²) = √2 km; sampling sd of
  // the estimator at n = 400 is ~3.5%, so 0.15 km is > 4σ.
  const options = {
    n: 400, seedLat: SEED_LAT, seedLon: SEED_LON,
    startTimeMs: Date.UTC(2026, 7, 29, 0, 0), horizonH: 4, dtMin: 10,
    grid: constantGrid({ curU: 0.25 }), rngSeed: 13, posSigmaM: 1000,
  };
  const result = runEnsemble(options);
  const T = 4 * 3600;
  const eastM = (result.meanEndLon - SEED_LON) * Math.PI / 180 * M_PER_RAD * Math.cos(SEED_LAT * Math.PI / 180);
  const northM = (result.meanEndLat - SEED_LAT) * Math.PI / 180 * M_PER_RAD;
  // Mean end ≈ seed + pure current drift, within scatter-mean noise σ/√n = 50 m.
  assert.ok(Math.abs(eastM - 0.25 * T) < 200, `mean east ${eastM.toFixed(0)} m`);
  assert.ok(Math.abs(northM) < 200, `mean north ${northM.toFixed(0)} m`);
  assert.ok(Math.abs(result.spreadKm - Math.SQRT2) < 0.15, `spreadKm ${result.spreadKm}`);
  const turb = runEnsemble({ ...options, sigmaTurbMs: 0.15 });
  assert.ok(turb.spreadKm > result.spreadKm, 'turbulence must widen the final spread');
});

test('every frame stays finite even when forcing has NaN holes', () => {
  const grid = constantGrid({ curU: 0.4, windV: 6 });
  grid.currentU[1] = NaN;
  grid.windV[2] = NaN;
  const result = runEnsemble({
    n: 128, seedLat: SEED_LAT, seedLon: SEED_LON,
    startTimeMs: Date.UTC(2026, 7, 29, 0, 0), horizonH: 3, dtMin: 10,
    grid, rngSeed: 11,
  });
  assert.equal(result.frames.length, result.timesMs.length * 128 * 2);
  for (const value of result.frames) assert.ok(Number.isFinite(value));
});

// ── Time-axis clamping is a distinct failure from a value gap (the A2 defect) ──
// bracket() clamps a time past the end of hoursMs to the last hour with w = 0,
// silently freezing the field. `degraded` only ever tripped on non-finite
// SAMPLES, so a run integrating past the end of its forecast reported itself
// perfectly healthy. Under the old forecast_days=2 every 48 h run did exactly
// that; these pin the two signals apart.

test('makeForcingSampler reports clampedInTime only outside the time axis', () => {
  const grid = constantGrid({ curU: 0.5 });
  const sampler = makeForcingSampler(grid);
  const [t0, t1] = grid.hoursMs;

  const inside = sampler(SEED_LAT, SEED_LON, (t0 + t1) / 2);
  assert.equal(inside.clampedInTime, false);
  assert.equal(inside.degraded, false);

  // Exactly on the endpoints is still inside the axis.
  assert.equal(sampler(SEED_LAT, SEED_LON, t0).clampedInTime, false);
  assert.equal(sampler(SEED_LAT, SEED_LON, t1).clampedInTime, false);

  const past = sampler(SEED_LAT, SEED_LON, t1 + 3600e3);
  assert.equal(past.clampedInTime, true);
  // Clamping is NOT a value gap: the field is frozen, not missing.
  assert.equal(past.degraded, false);
  assert.equal(past.curU, 0.5);

  assert.equal(sampler(SEED_LAT, SEED_LON, t0 - 3600e3).clampedInTime, true);
});

test('a run inside its forcing axis reports no clamped frames', () => {
  const grid = constantGrid({ curU: 0.2 });
  const result = runEnsemble({
    n: 4,
    seedLat: SEED_LAT,
    seedLon: SEED_LON,
    startTimeMs: grid.hoursMs[0],
    horizonH: 12, // well inside the 24 h axis
    dtMin: 10,
    grid,
    rngSeed: 1,
  });
  assert.equal(result.clampedInTime, false);
  assert.equal(result.clampedFrames, 0);
  assert.equal(result.frameCount, result.timesMs.length);
});

test('a run past the end of its forcing axis counts the extrapolated frames', () => {
  const grid = constantGrid({ curU: 0.2 });
  const axisHours = (grid.hoursMs[1] - grid.hoursMs[0]) / 3600e3; // 24 h
  const horizonH = 36;
  const result = runEnsemble({
    n: 4,
    seedLat: SEED_LAT,
    seedLon: SEED_LON,
    startTimeMs: grid.hoursMs[0],
    horizonH,
    dtMin: 10,
    grid,
    rngSeed: 1,
  });
  assert.equal(result.clampedInTime, true);
  // Frames are stamped at t0 + step·dt; those beyond the 24 h axis are clamped.
  // 36 h at 10 min = 216 steps, of which the last 12 h = 72 fall past the axis.
  const expected = Math.round(((horizonH - axisHours) * 60) / 10);
  assert.equal(result.clampedFrames, expected);
  // The frozen tail is still finite — clamping degrades honesty, not arithmetic.
  assert.ok(Number.isFinite(result.meanEndLat) && Number.isFinite(result.meanEndLon));
  // And it is NOT reported as a value gap.
  assert.equal(result.degraded, false);
});
