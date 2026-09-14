import { test } from 'node:test';
import assert from 'node:assert/strict';

import { packMaskStates, MASK_WATER } from '../../data/landSeaMaskCodec.js';
import {
  boxSpanKm,
  buildFieldPayload,
  buildTargetGrid,
  chooseTier,
  createTangentProjection,
  formatAge,
  metresPerDegLat,
  metresPerDegLon,
  normalizeBox,
  resampleBilinearOntoGrid,
  DEFAULT_TARGET_CELLS,
  FIELD_FORMAT,
  FIELD_FORMAT_VERSION,
  FIELD_SANITY_MAX_MS,
  GLOBAL_FIELD_SANITY_MAX_MS,
  HFR_MAX_SPAN_KM,
  HFR_SATURATION_COVERAGE,
  MAX_TARGET_CELLS,
  MIN_HFR_CONTRIBUTION,
  MIN_HFR_COVERAGE,
  MIN_TARGET_CELLS,
  RESAMPLE_EDGE_CELLS,
  TIERS,
} from './fieldGrid.js';

// Every buildFieldPayload test injects all five dependencies, so this suite
// never imports ./hfradar.js, ./globalCurrents.js or ./barnes.js.

const T0 = Date.UTC(2026, 7, 31, 18, 0, 0); // 2026-08-31T18:00Z, a fixed "now"

/** Monterey Bay-sized box: 1 deg tall, ~89 km wide at 36.8N. Well inside the HFR span cap. */
const BAY = Object.freeze({ latMin: 36.3, lonMin: -122.5, latMax: 37.3, lonMax: -121.5 });

/** @returns {{latMin: number, lonMin: number, latMax: number, lonMax: number}} */
function box(latMin, lonMin, latMax, lonMax) {
  return { latMin, lonMin, latMax, lonMax };
}

/** Builds `count` HF-radar observations spread over the box, all with the same vector. */
function observations(count, view = BAY, { u = 0.4, v = -0.2, hdop = 0.5 } = {}) {
  const out = [];
  const side = Math.ceil(Math.sqrt(count));
  for (let i = 0; i < count; i += 1) {
    const r = Math.floor(i / side) / Math.max(1, side - 1);
    const c = (i % side) / Math.max(1, side - 1);
    out.push({
      lat: view.latMin + r * (view.latMax - view.latMin),
      lon: view.lonMin + c * (view.lonMax - view.lonMin),
      u,
      v,
      hdop,
    });
  }
  return out;
}

/** A `fetchHfrField` that returns a healthy 2 km product. */
function hfrOk(overrides = {}) {
  return async () => ({
    observations: observations(200),
    datasetId: 'ucsdHfrW2',
    resolutionKm: 2,
    lengthScaleM: 10000,
    validAtMs: T0 - 2 * 3600_000,
    ageMs: 2 * 3600_000,
    rejected: 37,
    source: { id: 'ucsdHfrW2', label: 'IOOS HF-radar 2 km totals', url: 'https://example.invalid/w2' },
    ...overrides,
  });
}

/**
 * A `barnesVector(obs, xs, ys, L)` that fills the first `fraction` of the
 * lat-major grid and leaves the rest NaN, so coverage is exactly controllable.
 * It also asserts the real contract: SEPARABLE strictly-increasing axes
 * (xs = columns/longitude, ys = rows/latitude) and a positional length scale.
 */
function barnesFilling(fraction, fill = () => ({ u: 0.4, v: -0.2 })) {
  return (obs, xs, ys, L) => {
    assert.ok(Number.isFinite(L) && L > 0, 'barnesVector takes L positionally, in metres');
    assert.ok(Array.isArray(obs), 'observations must be a plain array');
    for (const axis of [xs, ys]) {
      for (let i = 1; i < axis.length; i += 1) {
        assert.ok(axis[i] > axis[i - 1], 'axes must be strictly increasing');
      }
    }
    const n = xs.length * ys.length;
    const u = new Float64Array(n).fill(Number.NaN);
    const v = new Float64Array(n).fill(Number.NaN);
    const filled = Math.round(n * fraction);
    for (let k = 0; k < filled; k += 1) {
      const value = fill(k, xs, ys);
      u[k] = value.u;
      v[k] = value.v;
    }
    return { u, v, weight: new Float64Array(n).fill(1), used: obs.length };
  };
}

/**
 * A `fetchGlobalCurrents` returning a uniform 0.25 deg patch. Axes and fields
 * are TYPED arrays, as the real module returns (Float64Array/Float32Array).
 */
function globalOk({ nLat = 5, nLon = 4, step = 0.25, descendingLat = false, ...rest } = {}) {
  return async () => {
    const lats = new Float64Array(nLat);
    for (let i = 0; i < nLat; i += 1) lats[i] = 36.5 + (descendingLat ? nLat - 1 - i : i) * step;
    const lons = new Float64Array(nLon);
    for (let j = 0; j < nLon; j += 1) lons[j] = -122.25 + j * step;
    // Values follow the COORDINATE, not the array index, so the ascending and
    // descending fixtures describe the same physical field.
    const u = [];
    const v = [];
    for (let i = 0; i < nLat; i += 1) {
      const latIndex = Math.round((lats[i] - 36.5) / step);
      for (let j = 0; j < nLon; j += 1) {
        u.push(0.1 * (latIndex + 1));
        v.push(-0.05 * (j + 1));
      }
    }
    return {
      lats,
      lons,
      u: Float32Array.from(u),
      v: Float32Array.from(v),
      finite: u.length,
      total: u.length,
      source: {
        datasetId: 'noaacwBLENDEDNRTcurrentsDaily',
        label: 'NOAA blended NRT surface currents (daily, 0.25 deg)',
        url: 'https://example.invalid/blended',
        attribution: 'NOAA CoastWatch',
        license: 'public domain',
        resolutionDeg: step,
        nativeResolutionDeg: 0.25,
        stride: 1,
        validAtMs: T0 - 3 * 86400_000,
      },
      ...rest,
    };
  };
}

/**
 * A `fetchGlobalCurrents` returning exactly the axes and values given, so a test
 * can drive the orientation flip, the magnitude gate and the degenerate-axis
 * paths without going through `globalOk`'s synthetic field.
 *
 * @param {{lats: number[], lons: number[], u: number[], v: number[], source?: ?Object}} spec
 * @returns {Function} An async fetcher.
 */
function globalRaw({ lats, lons, u, v, source = { datasetId: 'raw', resolutionDeg: 0.25 } }) {
  return async () => ({
    lats: Float64Array.from(lats),
    lons: Float64Array.from(lons),
    u: Float32Array.from(u),
    v: Float32Array.from(v),
    source,
  });
}

/**
 * A `fetchGlobalCurrents` whose 0.5 deg patch covers the whole BAY box with a
 * half-cell to spare and carries ONE constant vector, so every bilinearly
 * resampled target cell holds exactly that vector: a merge test can then name
 * the value a cell must have without reproducing the interpolation arithmetic.
 */
function globalConstant({ u = 0.9, v = -0.3, validAtMs = T0 - 2 * 86400_000 } = {}) {
  const lats = [36, 36.5, 37, 37.5];
  const lons = [-123, -122.5, -122, -121.5];
  const n = lats.length * lons.length;
  return globalRaw({
    lats,
    lons,
    u: new Array(n).fill(u),
    v: new Array(n).fill(v),
    source: {
      datasetId: 'noaacwBLENDEDNRTcurrentsDaily',
      label: 'NOAA blended NRT surface currents (daily, 0.25 deg)',
      attribution: 'NOAA CoastWatch',
      license: 'public domain',
      resolutionDeg: 0.5,
      validAtMs,
    },
  });
}

/** A `barnesVector` that fills exactly the southernmost `rows` lattice rows. */
function barnesFillingRows(rows, { u = 0.4, v = -0.2 } = {}) {
  return (obs, xs, ys) => {
    const nx = xs.length;
    const n = nx * ys.length;
    const au = new Float64Array(n).fill(Number.NaN);
    const av = new Float64Array(n).fill(Number.NaN);
    for (let k = 0; k < Math.min(rows * nx, n); k += 1) {
      au[k] = u;
      av[k] = v;
    }
    return { u: au, v: av, used: obs.length };
  };
}

/**
 * An all-water 8x4 land/sea mask, in the bundled asset's packed 2-bit format.
 * Small because maskStateAt only ever reads one cell per lookup.
 */
const ALL_WATER_MASK = {
  width: 8,
  height: 4,
  data: packMaskStates(new Uint8Array(8 * 4).fill(MASK_WATER), 8, 4),
};

/**
 * Assembles a full dependency map; anything omitted gets a working default.
 * `validateAnalysis(obs, xs, ys, L, opts)` owns its own holdout split — this
 * module never calls `holdoutSplit` itself.
 */
function deps({
  fetchHfrField = hfrOk(),
  fetchGlobalCurrents = globalOk(),
  barnesVector = barnesFilling(1),
  validateAnalysis = (obs, xs, ys, L, opts) => {
    assert.ok(Number.isFinite(L) && L > 0, 'validateAnalysis takes L positionally');
    assert.equal(opts.holdoutFrac, 0.12);
    assert.equal(opts.seed, 7);
    return {
      holdoutCount: Math.floor(obs.length * opts.holdoutFrac),
      rmseMs: 0.0912,
      maeMs: 0.07,
      biasU: 0.01,
      biasV: -0.002,
      coverage: 0.9,
      meanSigmaMs: 0.0314,
    };
  },
  // These tests exercise tier logic, not geography. Without an injected mask
  // the module would classify their synthetic boxes against the real bundled
  // GSHHG asset, so a fixture box that happens to sit over Nevada would be
  // blanked to no-data and every coverage assertion would depend on where the
  // fixture's made-up coordinates land. All-water keeps them deterministic;
  // waterCells.test.mjs owns the land/sea behaviour against the real asset.
  loadMask = async () => ALL_WATER_MASK,
} = {}) {
  return { fetchHfrField, fetchGlobalCurrents, barnesVector, validateAnalysis, loadMask };
}

/* ---------------------------------------------------------------- *
 * chooseTier — decided by ground span, not zoom
 * ---------------------------------------------------------------- */

test('chooseTier picks HF radar for a bay-sized box and global for a basin-sized one', () => {
  assert.equal(chooseTier(BAY).id, 'hfr');
  assert.equal(chooseTier(box(20, -130, 50, -70)).id, 'global');
});

test('chooseTier switches tiers across the 800 km span threshold', () => {
  // metresPerDegLat(36.8) ~ 110.97 km/deg: 7.0 deg = 777 km (under), 7.5 deg = 832 km (over).
  const under = box(33.3, -122.5, 40.3, -121.5);
  const over = box(33.05, -122.5, 40.55, -121.5);
  assert.ok(7.0 * metresPerDegLat(36.8) / 1000 < HFR_MAX_SPAN_KM);
  assert.ok(7.5 * metresPerDegLat(36.8) / 1000 > HFR_MAX_SPAN_KM);
  assert.equal(chooseTier(under).id, 'hfr');
  assert.equal(chooseTier(over).id, 'global');
});

test('chooseTier measures longitude on the ground, so a 10 deg box at 70N is still small', () => {
  const arctic = box(69.5, 0, 70.5, 10);
  // 10 deg of longitude is ~381 km at 70N but would be ~1113 km if read as degrees.
  assert.ok(10 * metresPerDegLon(70) / 1000 < HFR_MAX_SPAN_KM);
  assert.ok(10 * metresPerDegLat(70) / 1000 > HFR_MAX_SPAN_KM);
  assert.equal(chooseTier(arctic).id, 'hfr');
  assert.equal(chooseTier(box(69.5, 0, 70.5, 40)).id, 'global');
});

test('chooseTier honours allowHfr: false and returns frozen descriptors', () => {
  assert.equal(chooseTier(BAY, { allowHfr: false }).id, 'global');
  assert.equal(chooseTier(BAY), TIERS.hfr);
  assert.ok(Object.isFrozen(TIERS) && Object.isFrozen(TIERS.hfr) && Object.isFrozen(TIERS.global));
  assert.ok(Object.isFrozen(TIERS.composite));
  assert.throws(() => { TIERS.hfr.minResolutionKm = 99; }, TypeError);
  // `composite` describes an outcome, not a source, so it is never CHOSEN: it is
  // the label the payload takes when both fetched tiers ended up drawing cells.
  for (const view of [BAY, box(20, -130, 50, -70), box(69.5, 0, 70.5, 40)]) {
    for (const allowHfr of [true, false]) {
      assert.notEqual(chooseTier(view, { allowHfr }).id, TIERS.composite.id);
    }
  }
});

test('chooseTier refuses a malformed box rather than guessing a tier', () => {
  assert.throws(() => chooseTier(box(40, -122, 30, -121)), /latMax must exceed latMin/);
  assert.throws(() => chooseTier(box(30, -122, 40, -122)), /longitude span is zero/);
  assert.throws(() => chooseTier(box(30, Number.NaN, 40, -121)), /lonMin is not a finite number/);
  assert.throws(() => chooseTier(box(-95, -122, 40, -121)), /latitudes out of range/);
});

/* ---------------------------------------------------------------- *
 * buildTargetGrid — shape, aspect, axes
 * ---------------------------------------------------------------- */

test('buildTargetGrid hits the cell budget and reconstructs its own axes arithmetically', () => {
  const grid = buildTargetGrid(BAY, DEFAULT_TARGET_CELLS);
  assert.ok(grid.nLat * grid.nLon <= DEFAULT_TARGET_CELLS + grid.nLon);
  assert.ok(grid.nLat * grid.nLon >= DEFAULT_TARGET_CELLS - grid.nLon);
  assert.equal(grid.lats.length, grid.nLat);
  assert.equal(grid.lons.length, grid.nLon);
  assert.equal(grid.lat0, BAY.latMin);
  assert.equal(grid.lon0, BAY.lonMin);
  for (let i = 0; i < grid.nLat; i += 1) assert.equal(grid.lats[i], grid.lat0 + i * grid.dLat);
  for (let j = 0; j < grid.nLon; j += 1) assert.equal(grid.lons[j], grid.lon0 + j * grid.dLon);
  assert.ok(Math.abs(grid.lats[grid.nLat - 1] - BAY.latMax) < 1e-9);
  assert.ok(Math.abs(grid.lons[grid.nLon - 1] - BAY.lonMax) < 1e-9);
  assert.ok(grid.dLat > 0 && grid.dLon > 0);
});

test('buildTargetGrid matches the box GROUND aspect, not its degree aspect', () => {
  // 1 deg tall (111.0 km) x 4 deg wide at 30.5N (383.5 km) -> ground aspect ~3.46.
  const wide = box(30, -124, 31, -120);
  const grid = buildTargetGrid(wide, 4096);
  const latKm = 1 * metresPerDegLat(30.5) / 1000;
  const lonKm = 4 * metresPerDegLon(30.5) / 1000;
  const groundAspect = lonKm / latKm;
  assert.ok(grid.nLon > grid.nLat, `expected a wide grid, got ${grid.nLon}x${grid.nLat}`);
  const gridAspect = grid.nLon / grid.nLat;
  assert.ok(
    Math.abs(gridAspect - groundAspect) / groundAspect < 0.05,
    `grid aspect ${gridAspect.toFixed(2)} should track ground aspect ${groundAspect.toFixed(2)}`,
  );
  // A square-degree box at 30.5N is NOT square on the ground; the grid must lean tall.
  const square = buildTargetGrid(box(30, -121, 31, -120), 4096);
  assert.ok(square.nLat > square.nLon);
});

test('buildTargetGrid clamps the cell budget at both ends', () => {
  const tiny = buildTargetGrid(BAY, 4);
  assert.ok(tiny.nLat * tiny.nLon >= MIN_TARGET_CELLS - tiny.nLon);
  assert.ok(tiny.nLat >= 2 && tiny.nLon >= 2);
  const huge = buildTargetGrid(BAY, 5_000_000);
  assert.ok(huge.nLat * huge.nLon <= MAX_TARGET_CELLS + huge.nLon);
  const defaulted = buildTargetGrid(BAY, Number.NaN);
  assert.deepEqual(
    [defaulted.nLat, defaulted.nLon],
    [buildTargetGrid(BAY).nLat, buildTargetGrid(BAY).nLon],
  );
});

test('buildTargetGrid spans an antimeridian-crossing box the short way', () => {
  const grid = buildTargetGrid(box(-1, 179, 1, -179), 256);
  assert.ok(Math.abs(grid.dLon * (grid.nLon - 1) - 2) < 1e-9, 'span must be 2 deg, not 358');
  assert.equal(grid.lons[0], 179);
  assert.ok(Math.abs(grid.lons[grid.nLon - 1] - 181) < 1e-9, 'axis runs past +180; the client wraps');
});

test('buildTargetGrid refuses a malformed box', () => {
  assert.throws(() => buildTargetGrid(box(40, -122, 30, -121)), /latMax must exceed latMin/);
  assert.throws(() => buildTargetGrid(box(30, -122, 40, -122)), /longitude span is zero/);
  assert.throws(() => buildTargetGrid(null), /view box is missing/);
});

/* ---------------------------------------------------------------- *
 * buildFieldPayload — HF-radar path
 * ---------------------------------------------------------------- */

test('the HF-radar path serves a field with coverage and holdout metrics', async () => {
  const payload = await buildFieldPayload({
    box: BAY,
    atMs: T0,
    targetCells: 1024,
    deps: deps(),
  });

  assert.equal(payload.status, 'ok');
  assert.equal(payload.format, FIELD_FORMAT);
  assert.equal(payload.version, FIELD_FORMAT_VERSION);
  assert.equal(payload.requestedAtMs, T0);
  assert.deepEqual(payload.box, { latMin: 36.3, lonMin: -122.5, latMax: 37.3, lonMax: -121.5 });

  assert.equal(payload.u.length, payload.grid.nLat * payload.grid.nLon);
  assert.equal(payload.v.length, payload.u.length);
  assert.ok(payload.grid.dLat > 0 && payload.grid.dLon > 0);
  assert.equal(payload.grid.lat0, BAY.latMin);

  const p = payload.provenance;
  assert.equal(p.tier, 'hfr');
  assert.equal(p.datasetId, 'ucsdHfrW2');
  assert.equal(p.label, 'IOOS HF-radar 2 km totals');
  assert.equal(p.kind, 'observed');
  assert.equal(p.resolutionKm, 2);
  assert.equal(p.lengthScaleM, 10000);
  assert.equal(p.validAtMs, T0 - 2 * 3600_000);
  assert.equal(p.ageMs, 2 * 3600_000);
  assert.equal(p.ageLabel, '2 h old');
  assert.equal(p.stale, false);
  assert.equal(p.coverage, 1);
  assert.equal(p.rejected, 37);
  // The SHIPPED field is analysed over all 200 vectors; the holdout only scores it.
  assert.equal(p.observations, 200);
  assert.equal(p.holdoutCount, 24);
  assert.equal(p.rmseMs, 0.091);
  assert.equal(p.meanSigmaMs, 0.031);
  assert.equal(p.biasUMs, 0.01);
  assert.equal(p.biasVMs, -0.002);
  assert.equal(p.sourceNote, null);
  assert.equal(p.fallbackFrom, null);
  assert.ok(p.note.includes('Barnes'));
  assert.deepEqual(p.caveats, []);

  assert.equal(payload.stats.cells, payload.u.length);
  assert.equal(payload.stats.finite, payload.u.length);
  assert.equal(payload.stats.speedMaxMs, 0.447); // hypot(0.4, 0.2)
  assert.deepEqual(payload.attempts, []);
});

test('a stale HF-radar hour is reported in the legend, not hidden', async () => {
  const payload = await buildFieldPayload({
    box: BAY,
    atMs: T0,
    targetCells: 256,
    deps: deps({ fetchHfrField: hfrOk({ ageMs: 9 * 3600_000, validAtMs: T0 - 9 * 3600_000 }) }),
  });
  assert.equal(payload.provenance.stale, true);
  assert.equal(payload.provenance.ageLabel, '9 h old');
  assert.ok(payload.provenance.caveats.some((c) => c.includes('9 h old')));
});

test('too few HF-radar vectors demotes the tier instead of analysing 12 points', async () => {
  const payload = await buildFieldPayload({
    box: BAY,
    atMs: T0,
    targetCells: 256,
    deps: deps({ fetchHfrField: async () => ({ observations: observations(12), lengthScaleM: 10000 }) }),
  });
  assert.equal(payload.provenance.tier, 'global');
  assert.match(payload.attempts[0].reason, /only 12 HF-radar vectors/);
});

test('an HF-radar fetch with no length scale is refused rather than guessed', async () => {
  const payload = await buildFieldPayload({
    box: BAY,
    atMs: T0,
    targetCells: 256,
    deps: deps({ fetchHfrField: hfrOk({ lengthScaleM: undefined }) }),
  });
  assert.equal(payload.provenance.tier, 'global');
  assert.match(payload.attempts[0].reason, /no Barnes length scale/);
});

test('a throwing HF-radar fetch becomes a reason, not an exception', async () => {
  const payload = await buildFieldPayload({
    box: BAY,
    atMs: T0,
    targetCells: 256,
    deps: deps({ fetchHfrField: async () => { throw new Error('ERDDAP 503'); } }),
  });
  assert.equal(payload.status, 'ok');
  assert.equal(payload.provenance.tier, 'global');
  assert.deepEqual(payload.attempts, [{ tier: 'hfr', reason: 'ERDDAP 503' }]);
});

/* ---------------------------------------------------------------- *
 * Compositing
 *
 * CHANGED BEHAVIOUR. Two tests here previously asserted the MIN_HFR_COVERAGE
 * gate: that a 17.5%-filled analysis was traded wholesale for the global field
 * ("a sparse HF-radar analysis falls back to global instead of serving voids")
 * and that a 40%-filled one was served alone ("coverage just above the
 * threshold is served on the HF-radar tier"). Both outcomes are now wrong by
 * construction — a partial analysis is composited with the global fill instead
 * of either being discarded or leaving the rest of the view empty — so the two
 * were rewritten around the merge rather than weakened. The measurement that
 * killed the gate is in the module's @file block: a 1x1 deg Monterey Bay box
 * covers 25% of the water and would have been demoted whole.
 * ---------------------------------------------------------------- */

test('a partial HF-radar analysis is composited with the global fill, not traded for it', async () => {
  const sparse = MIN_HFR_COVERAGE / 2; // 17.5%: demoted outright under the old gate
  const payload = await buildFieldPayload({
    box: BAY,
    atMs: T0,
    targetCells: 1024,
    deps: deps({ barnesVector: barnesFilling(sparse) }),
  });

  assert.equal(payload.status, 'ok');
  assert.equal(payload.provenance.tier, 'composite');
  assert.equal(payload.provenance.kind, 'mixed');
  assert.equal(payload.provenance.fallbackFrom, null, 'nothing was fallen back FROM');
  assert.deepEqual(payload.attempts, [], 'neither tier failed, so nothing is in attempts');

  // The radar analysis survives intact and keeps describing itself.
  assert.equal(payload.provenance.rmseMs, 0.091);
  assert.equal(payload.provenance.lengthScaleM, 10000);
  assert.equal(payload.provenance.observations, 200);
  assert.equal(payload.provenance.resolutionKm, 2);
  assert.equal(payload.provenance.datasetId, 'ucsdHfrW2');

  const [hfr, global] = payload.provenance.sources;
  assert.equal(payload.provenance.sources.length, 2);
  assert.equal(hfr.tier, 'hfr');
  assert.equal(hfr.kind, 'observed');
  assert.equal(hfr.resolutionKm, 2);
  assert.equal(hfr.ageLabel, '2 h old');
  assert.equal(global.tier, 'global');
  assert.equal(global.kind, 'derived');
  assert.ok(global.resolutionKm > 20, `global cells are coarse, got ${global.resolutionKm} km`);
  assert.equal(global.ageLabel, '3 days old');
  assert.ok(hfr.cells > 0 && global.cells > 0, 'both tiers must actually be drawn');

  // The split has to be sayable in one sentence, with both ages and both scales.
  const split = payload.provenance.caveats.find((c) => /of drawn cells are/.test(c));
  assert.ok(split, `expected a split caveat, got ${JSON.stringify(payload.provenance.caveats)}`);
  assert.match(split, /^\d+% of drawn cells are 2 km HF radar \(2 h old\); the other \d+% is \d+ km (?:blended altimetric geostrophic|HYCOM global forecast) currents \(3 days old\)\.$/);
  // The global product's own lag caveat survives, marked as belonging to the fill.
  assert.ok(payload.provenance.caveats.some((c) => /^Global fill — published with a multi-day lag/.test(c)));
});

test('the merge takes HF radar first, the resampled global second, and null last', async () => {
  // The analysis fills exactly the southernmost lattice row; the global patch is
  // one constant vector covering the whole box, so every other water cell must
  // carry that vector exactly and no cell may hold a blend of the two.
  const payload = await buildFieldPayload({
    box: BAY,
    atMs: T0,
    targetCells: 256,
    deps: deps({
      barnesVector: barnesFillingRows(1, { u: 0.4, v: -0.2 }),
      fetchGlobalCurrents: globalConstant({ u: 0.9, v: -0.3 }),
    }),
  });

  const { nLat, nLon } = payload.grid;
  assert.equal(payload.provenance.tier, 'composite');
  for (let j = 0; j < nLon; j += 1) {
    assert.equal(payload.u[j], 0.4, `row 0 col ${j} must keep the HF value`);
    assert.equal(payload.v[j], -0.2);
  }
  for (let k = nLon; k < nLat * nLon; k += 1) {
    assert.equal(payload.u[k], 0.9, `cell ${k} must be the global fill, unaveraged`);
    assert.equal(payload.v[k], -0.3);
  }
  const [hfr, global] = payload.provenance.sources;
  assert.equal(hfr.cells, nLon);
  assert.equal(global.cells, nLat * nLon - nLon);
  assert.equal(payload.stats.finite, nLat * nLon);
  // 0.4 and 0.9 are both present; 0.65 — their mean — must not be.
  assert.equal(payload.u.includes(0.65), false, 'a cell has one provenance, never a blend');
});

test('water the global fill cannot reach stays null rather than being extrapolated', async () => {
  // globalOk covers 36.5..37.5 N, -122.25..-121.5 E, so the southern and western
  // edges of the BAY box lie more than half a source cell outside it.
  const payload = await buildFieldPayload({
    box: BAY,
    atMs: T0,
    targetCells: 1024,
    deps: deps({ barnesVector: barnesFillingRows(1) }),
  });
  assert.equal(payload.provenance.tier, 'composite');
  assert.ok(payload.u.includes(null), 'unreachable water is null, never 0 and never nearest-neighboured');
  assert.ok(payload.stats.finite < payload.stats.cells);
  const drawn = payload.provenance.sources.reduce((sum, s) => sum + s.cells, 0);
  assert.equal(drawn, payload.stats.finite, 'the sources account for every drawn cell');
});

test('cellShare is each source share of the FINITE cells and the shares sum to 1', async () => {
  for (const fraction of [0.05, 0.3, 0.5, 0.85]) {
    const payload = await buildFieldPayload({
      box: BAY,
      atMs: T0,
      targetCells: 1024,
      deps: deps({
        barnesVector: barnesFilling(fraction),
        fetchGlobalCurrents: globalConstant(),
      }),
    });
    assert.equal(payload.provenance.tier, 'composite', `fraction ${fraction}`);
    const shares = payload.provenance.sources.map((s) => s.cellShare);
    const sum = shares.reduce((a, b) => a + b, 0);
    assert.ok(Math.abs(sum - 1) < 1e-9, `shares ${JSON.stringify(shares)} must sum to 1`);
    for (const source of payload.provenance.sources) {
      assert.ok(
        Math.abs(source.cellShare - source.cells / payload.stats.finite) <= 5e-5,
        `${source.tier} share ${source.cellShare} must equal ${source.cells}/${payload.stats.finite}`,
      );
    }
    assert.equal(
      payload.provenance.sources.reduce((n, s) => n + s.cells, 0),
      payload.stats.finite,
    );
  }
});

test('all three tier namings follow from which sources actually drew cells', async () => {
  // hfr: the analysis covers everything, so the global tier contributes nothing.
  const hfr = await buildFieldPayload({
    box: BAY, atMs: T0, targetCells: 1024, deps: deps({ barnesVector: barnesFilling(1) }),
  });
  assert.equal(hfr.provenance.tier, 'hfr');
  assert.equal(hfr.provenance.kind, 'observed');
  assert.deepEqual(hfr.provenance.sources.map((s) => s.tier), ['hfr']);
  assert.equal(hfr.provenance.sources[0].cellShare, 1);

  // global: the HF tier contributes nothing at all.
  const global = await buildFieldPayload({
    box: BAY,
    atMs: T0,
    targetCells: 1024,
    deps: deps({ fetchHfrField: async () => null }),
  });
  assert.equal(global.provenance.tier, 'global');
  assert.equal(global.provenance.kind, 'derived');
  assert.deepEqual(global.provenance.sources.map((s) => s.tier), ['global']);
  assert.equal(global.provenance.sources[0].cellShare, 1);
  assert.equal(global.provenance.sources[0].cells, global.stats.finite);

  // composite: both drew cells.
  const composite = await buildFieldPayload({
    box: BAY,
    atMs: T0,
    targetCells: 1024,
    deps: deps({ barnesVector: barnesFilling(0.5), fetchGlobalCurrents: globalConstant() }),
  });
  assert.equal(composite.provenance.tier, 'composite');
  assert.equal(composite.provenance.kind, 'mixed');
  assert.deepEqual(composite.provenance.sources.map((s) => s.tier), ['hfr', 'global']);
});

test('a saturated HF analysis never issues the global request', async () => {
  let globalCalls = 0;
  const payload = await buildFieldPayload({
    box: BAY,
    atMs: T0,
    targetCells: 1024,
    deps: deps({
      barnesVector: barnesFilling(1),
      fetchGlobalCurrents: async (...args) => { globalCalls += 1; return globalOk()(...args); },
    }),
  });
  assert.equal(payload.provenance.tier, 'hfr');
  assert.ok(payload.provenance.coverage >= HFR_SATURATION_COVERAGE);
  assert.equal(globalCalls, 0, 'a fill with nothing to fill must not cost a round trip');
  assert.deepEqual(payload.provenance.caveats, [], 'nothing was withheld, so nothing to admit');

  // Just below saturation the request IS made, so the threshold is load-bearing
  // rather than an accident of the fixture always filling everything.
  let calls = 0;
  const nearly = await buildFieldPayload({
    box: BAY,
    atMs: T0,
    targetCells: 1024,
    deps: deps({
      barnesVector: barnesFilling(HFR_SATURATION_COVERAGE - 0.1),
      fetchGlobalCurrents: async (...args) => { calls += 1; return globalConstant()(...args); },
    }),
  });
  assert.equal(calls, 1);
  assert.equal(nearly.provenance.tier, 'composite');
});

test('too few HF-radar vectors costs no Barnes pass', async () => {
  let barnesCalls = 0;
  const payload = await buildFieldPayload({
    box: BAY,
    atMs: T0,
    targetCells: 1024,
    deps: deps({
      fetchHfrField: async () => ({ observations: observations(12), lengthScaleM: 10000 }),
      barnesVector: (...args) => { barnesCalls += 1; return barnesFilling(1)(...args); },
    }),
  });
  assert.equal(barnesCalls, 0, 'the vector floor must be checked before the analysis, not after');
  assert.equal(payload.provenance.tier, 'global');
});

test('an analysis below the composite floor is dropped rather than drawn as speckle', async () => {
  const speckle = MIN_HFR_CONTRIBUTION / 2;
  const payload = await buildFieldPayload({
    box: BAY,
    atMs: T0,
    targetCells: 1024,
    deps: deps({ barnesVector: barnesFilling(speckle) }),
  });
  assert.equal(payload.provenance.tier, 'global');
  assert.equal(payload.provenance.fallbackFrom, 'hfr');
  assert.equal(payload.provenance.sources.length, 1);
  assert.equal(payload.attempts.length, 1);
  assert.match(payload.attempts[0].reason, /filled 1% of the water in view, below the 2% worth compositing/);
  assert.ok(payload.provenance.caveats.some((c) => c.includes('Shown instead of HF radar')));
  // Nothing about the served field may look like a live measurement.
  assert.equal(payload.provenance.rmseMs, null);
  assert.equal(payload.provenance.lengthScaleM, null);
  assert.equal(payload.provenance.observations, null);
  assert.equal(payload.provenance.ageLabel, '3 days old');
  assert.ok(payload.provenance.caveats.some((c) => c.includes('multi-day lag')));

  // Just above the floor the same analysis is kept and composited.
  const kept = await buildFieldPayload({
    box: BAY,
    atMs: T0,
    targetCells: 1024,
    deps: deps({ barnesVector: barnesFilling(MIN_HFR_CONTRIBUTION * 2) }),
  });
  assert.equal(kept.provenance.tier, 'composite');
});

test('a lost global fill leaves the radar field standing, and says the rest is blank', async () => {
  const payload = await buildFieldPayload({
    box: BAY,
    atMs: T0,
    targetCells: 1024,
    deps: deps({
      barnesVector: barnesFilling(0.4),
      fetchGlobalCurrents: async () => { throw new Error('ERDDAP 504'); },
    }),
  });
  assert.equal(payload.status, 'ok');
  assert.equal(payload.provenance.tier, 'hfr');
  assert.equal(payload.provenance.rmseMs, 0.091, 'the analysis is served whatever its coverage');
  assert.deepEqual(payload.provenance.sources.map((s) => s.tier), ['hfr']);
  assert.ok(payload.provenance.caveats.some((c) => /ERDDAP 504.*blank rather than modelled/.test(c)));
  assert.ok(payload.u.includes(null));
});

test('a legend can never read a composite cell as the wrong instrument', async () => {
  const payload = await buildFieldPayload({
    box: BAY,
    atMs: T0,
    targetCells: 1024,
    deps: deps({
      barnesVector: barnesFilling(0.5),
      fetchGlobalCurrents: globalConstant({ validAtMs: T0 - 2 * 86400_000 }),
    }),
  });
  const [hfr, global] = payload.provenance.sources;
  // Every field a legend row would print differs between the two sources, and
  // neither row carries the other's numbers.
  assert.notEqual(hfr.tier, global.tier);
  assert.notEqual(hfr.kind, global.kind);
  assert.notEqual(hfr.ageLabel, global.ageLabel);
  assert.notEqual(hfr.datasetId, global.datasetId);
  assert.ok(global.resolutionKm / hfr.resolutionKm > 10, 'the two scales are an order apart');
  assert.equal(hfr.ageMs, 2 * 3600_000);
  assert.equal(global.ageMs, 2 * 86400_000);
  assert.equal(hfr.validAtMs, T0 - 2 * 3600_000);
  assert.equal(global.validAtMs, T0 - 2 * 86400_000);
  // Both products are credited, since both are drawn.
  assert.match(payload.provenance.attribution, /NOAA CoastWatch/);
  assert.equal(payload.provenance.kind, 'mixed');
});

/* ---------------------------------------------------------------- *
 * resampleBilinearOntoGrid
 * ---------------------------------------------------------------- */

/** A 2x2 unit-degree source at the origin; u carries the corner values, v = -u. */
function unitSource(u = [0, 10, 20, 30]) {
  return {
    grid: { lat0: 0, lon0: 0, dLat: 1, dLon: 1, nLat: 2, nLon: 2 },
    u,
    v: u.map((value) => (value == null ? null : -value)),
  };
}

/** A target lattice from explicit axes, in the shape buildTargetGrid returns. */
function lattice(lats, lons) {
  return { lats, lons, nLat: lats.length, nLon: lons.length };
}

test('bilinear resampling reproduces the source at its nodes and the exact mean between them', () => {
  const src = unitSource();
  const out = resampleBilinearOntoGrid(src.grid, src.u, src.v, lattice([0, 0.5, 1], [0, 0.5, 1]));

  // Nodes come back exactly: (0,0)=0, (0,1)=10, (1,0)=20, (1,1)=30.
  assert.equal(out.u[0], 0);
  assert.equal(out.u[2], 10);
  assert.equal(out.u[6], 20);
  assert.equal(out.u[8], 30);
  // Edge midpoints are the two-corner means, the centre is the four-corner mean.
  assert.equal(out.u[1], 5);
  assert.equal(out.u[3], 10);
  assert.equal(out.u[4], 15);
  assert.equal(out.u[5], 20);
  assert.equal(out.u[7], 25);
  assert.equal(out.finite, 9);
  // v is resampled with the same weights, independently of u. `+ 0` because the
  // module collapses a rounded -0 to +0 so payloads survive a JSON round trip.
  for (let k = 0; k < 9; k += 1) assert.equal(out.v[k], -out.u[k] + 0);

  // Off-centre weights, so the test is not blind to a swapped (1-t) factor:
  // 25% of the way north and 75% east is 0.75*(0.25*10 + 0.75*30)... in the
  // (lat, lon) convention that is (1-0.25)*[(1-0.75)*0 + 0.75*10]
  //                             +    0.25 *[(1-0.75)*20 + 0.75*30].
  const skew = resampleBilinearOntoGrid(src.grid, src.u, src.v, lattice([0.25], [0.75]));
  assert.equal(skew.u[0], 0.75 * 7.5 + 0.25 * 27.5);
});

test('bilinear resampling refuses a null corner instead of substituting zero', () => {
  // The north-east corner is no-data; nothing that leans on it may be drawn.
  const src = unitSource([0, 10, 20, null]);
  const out = resampleBilinearOntoGrid(src.grid, src.u, src.v, lattice([0, 0.5, 1], [0, 0.5, 1]));

  assert.equal(out.u[4], null, 'the centre needs all four corners');
  assert.equal(out.u[5], null, 'the east edge midpoint needs the void corner');
  assert.equal(out.u[7], null, 'the north edge midpoint needs it too');
  assert.equal(out.u[8], null, 'the void corner itself');
  // Cells whose weights on the void corner are exactly zero are still drawn: the
  // sample does not need a corner it does not weight.
  assert.equal(out.u[0], 0);
  assert.equal(out.u[1], 5, 'the south edge midpoint weights only the south corners');
  assert.equal(out.u[3], 10, 'the west edge midpoint weights only the west corners');
  assert.equal(out.u[6], 20);
  assert.equal(out.finite, 5);
  // A refused cell is null in BOTH components; the renderer never sees a half vector.
  for (let k = 0; k < 9; k += 1) assert.equal(out.u[k] == null, out.v[k] == null);

  // And a void that only v carries refuses the cell just as a void in u does.
  const halfVoid = resampleBilinearOntoGrid(
    src.grid, [0, 10, 20, 30], [0, -10, -20, null], lattice([0.5], [0.5]),
  );
  assert.equal(halfVoid.u[0], null);
  assert.equal(halfVoid.v[0], null);
});

test('bilinear resampling reaches half a source cell past the outermost centres, and no further', () => {
  const src = unitSource();
  assert.equal(RESAMPLE_EDGE_CELLS, 0.5);
  // ERDDAP snaps its axis, so the source's first centre routinely sits inside
  // the requested box; the edge of the view must still be drawn.
  const inside = resampleBilinearOntoGrid(src.grid, src.u, src.v, lattice([-0.5, 1.5], [-0.5, 1.5]));
  assert.equal(inside.finite, 4);
  assert.equal(inside.u[0], 0, 'clamped onto the south-west cell, not extrapolated past it');
  assert.equal(inside.u[3], 30);

  const outside = resampleBilinearOntoGrid(src.grid, src.u, src.v, lattice([-0.51, 1.51], [0, 1]));
  assert.deepEqual(outside.u, [null, null, null, null], 'beyond half a cell is extrapolation');
  assert.equal(outside.finite, 0);
});

test('bilinear resampling meets the target lattice across the antimeridian', () => {
  // Source numbered in [-180, 180); target numbered past +180, as an
  // antimeridian-crossing view box is (see buildTargetGrid).
  const src = { lat0: 0, lon0: -180, dLat: 1, dLon: 1, nLat: 2, nLon: 2 };
  const u = [0, 10, 20, 30];
  const out = resampleBilinearOntoGrid(src, u, u.map((x) => -x), lattice([0], [179.5, 180, 180.5, 181]));
  assert.equal(out.u[0], 0, '179.5 is half a cell west of the -180 centre, so it clamps onto it');
  assert.equal(out.u[1], 0, '180 IS -180');
  assert.equal(out.u[2], 5);
  assert.equal(out.u[3], 10, '181 is -179');
});

test('bilinear resampling handles a degenerate single-row source without dividing by zero', () => {
  const src = { lat0: 36.625, lon0: -122.25, dLat: 0.25, dLon: 0.25, nLat: 1, nLon: 2 };
  const out = resampleBilinearOntoGrid(src, [0.1, 0.3], [0, 0], lattice([36.625, 36.7], [-122.25, -122.125]));
  assert.equal(out.u[0], 0.1);
  assert.equal(out.u[1], 0.2);
  assert.equal(out.u[2], 0.1, 'a row-less source repeats its one row within the half-cell reach');
  assert.equal(out.u[3], 0.2);
});

test('resampled values are rounded to the served precision, like every other number', () => {
  const src = unitSource([0, 1 / 3, 0, 1 / 3]);
  const out = resampleBilinearOntoGrid(src.grid, src.u, src.v, lattice([0], [0.5]));
  assert.equal(out.u[0], 0.167, '1/6 at 3 decimals');
  assert.equal(out.v[0], -0.167);
});

/* ---------------------------------------------------------------- *
 * Global path
 * ---------------------------------------------------------------- */

test('the global tier is served on the source axes, oriented south-to-north', async () => {
  const ascending = await buildFieldPayload({
    box: BAY, atMs: T0, allowHfr: false, deps: deps({ fetchGlobalCurrents: globalOk() }),
  });
  const descending = await buildFieldPayload({
    box: BAY, atMs: T0, allowHfr: false, deps: deps({ fetchGlobalCurrents: globalOk({ descendingLat: true }) }),
  });

  assert.equal(ascending.provenance.tier, 'global');
  assert.deepEqual(ascending.grid, { lat0: 36.5, lon0: -122.25, dLat: 0.25, dLon: 0.25, nLat: 5, nLon: 4 });
  // A descending source axis must come back with the SAME geometry and rows.
  assert.deepEqual(descending.grid, ascending.grid);
  assert.deepEqual(descending.u, ascending.u);
  assert.deepEqual(descending.v, ascending.v);
  assert.equal(ascending.provenance.resolutionKm > 20, true);
  assert.equal(ascending.provenance.datasetId, 'noaacwBLENDEDNRTcurrentsDaily');
  assert.equal(ascending.provenance.attribution, 'NOAA CoastWatch');
  assert.equal(ascending.provenance.license, 'public domain');
  assert.equal(ascending.attempts.length, 0);
  assert.equal(ascending.provenance.fallbackFrom, null);
});

test('a strided global request admits in the legend that it is a subsample', async () => {
  const payload = await buildFieldPayload({
    box: BAY,
    atMs: T0,
    allowHfr: false,
    deps: deps({ fetchGlobalCurrents: globalOk({ step: 0.5, source: undefined }) }),
  });
  // globalOk spreads `rest` last, so override the source wholesale.
  const strided = await buildFieldPayload({
    box: BAY,
    atMs: T0,
    allowHfr: false,
    deps: deps({
      fetchGlobalCurrents: globalOk({
        step: 0.5,
        source: {
          datasetId: 'noaacwBLENDEDNRTcurrentsDaily',
          label: 'NOAA blended NRT surface currents',
          resolutionDeg: 0.5,
          nativeResolutionDeg: 0.25,
          stride: 2,
          validAtMs: T0 - 3 * 86400_000,
        },
      }),
    }),
  });
  // With no `source` at all the legend falls back to generic truths and invents
  // nothing: no dataset id, no attribution, and no claim about subsampling.
  assert.equal(payload.status, 'ok');
  assert.equal(payload.provenance.datasetId, null);
  assert.equal(payload.provenance.attribution, null);
  assert.equal(payload.provenance.label, TIERS.global.label);
  assert.deepEqual(payload.provenance.caveats, []);
  assert.ok(strided.provenance.caveats.some((c) => /Subsampled every 2 cells from the 0.25 deg grid/.test(c)));
});

test('the global tier keeps values its own fetcher admitted, and only the HF-radar tier uses the 4.8 gate', async () => {
  // globalCurrents.js maps |component| > GLOBAL_CURRENTS_DATASET.maxSpeedMs (5)
  // to NaN and documents why the HF-radar-tuned gate must not be reused here, so
  // a 4.9 m/s cell reaching this module is data the fetcher deliberately kept.
  assert.ok(FIELD_SANITY_MAX_MS < GLOBAL_FIELD_SANITY_MAX_MS);
  const keep = 4.9;
  const drop = 5.2; // past the fetcher's own envelope; only a corrupt feed gets here
  const payload = await buildFieldPayload({
    box: BAY,
    atMs: T0,
    allowHfr: false,
    deps: deps({
      fetchGlobalCurrents: globalRaw({
        lats: [36.5, 36.75],
        lons: [-122.25, -122],
        u: [keep, drop, 0.3, 0.4],
        v: [0.1, 0.1, 0.1, 0.1],
      }),
    }),
  });
  assert.deepEqual(payload.u, [keep, null, 0.3, 0.4]);
  assert.deepEqual(payload.v, [0.1, null, 0.1, 0.1]);
  assert.equal(payload.stats.finite, 3);

  // The same magnitude on the HF-radar tier is a degenerate Barnes weight sum
  // (that fetcher rejects every observation above 2.4 m/s) and must be dropped.
  const hfr = await buildFieldPayload({
    box: BAY,
    atMs: T0,
    targetCells: 64,
    deps: deps({ barnesVector: barnesFilling(1, () => ({ u: keep, v: 0.1 })) }),
  });
  assert.equal(hfr.provenance.tier, 'global', 'a wholly out-of-range analysis must not be served as hfr');
  assert.match(hfr.attempts[0].reason, /filled 0% of the water in view/);
});

test('a source axis of one point takes its step from the fetcher, or the tier is refused', async () => {
  // A view thinner than one 0.25 deg cell comes back as a single row. dLat must
  // still be positive — the wire contract says clients divide by it.
  const thin = box(36.55, -122.3, 36.65, -121.4);
  const withResolution = await buildFieldPayload({
    box: thin,
    atMs: T0,
    allowHfr: false,
    deps: deps({
      fetchGlobalCurrents: globalRaw({
        lats: [36.625],
        lons: [-122.25, -122, -121.75, -121.5],
        u: [0.1, 0.2, 0.3, 0.4],
        v: [0, 0, 0, 0],
        source: { datasetId: 'noaacwBLENDEDNRTcurrentsDaily', resolutionDeg: 0.25 },
      }),
    }),
  });
  assert.equal(withResolution.status, 'ok');
  assert.equal(withResolution.grid.nLat, 1);
  assert.equal(withResolution.grid.dLat, 0.25, 'the single-row step comes from the fetcher, not from 0');
  assert.ok(withResolution.grid.dLon > 0);

  // Without a reported resolution there is nothing honest to put there.
  const bare = await buildFieldPayload({
    box: thin,
    atMs: T0,
    allowHfr: false,
    deps: deps({
      fetchGlobalCurrents: globalRaw({
        lats: [36.625],
        lons: [-122.25, -122, -121.75, -121.5],
        u: [0.1, 0.2, 0.3, 0.4],
        v: [0, 0, 0, 0],
        source: null,
      }),
    }),
  });
  assert.equal(bare.status, 'unavailable');
  assert.match(bare.reason, /1x4 grid with no cell size/);
  assert.equal(bare.grid, null);
});

test('a descending longitude axis is flipped, not served back to front', async () => {
  const ascending = await buildFieldPayload({
    box: BAY,
    atMs: T0,
    allowHfr: false,
    deps: deps({
      fetchGlobalCurrents: globalRaw({
        lats: [36.5, 36.75],
        lons: [-122.25, -122],
        u: [0.1, 0.2, 0.3, 0.4],
        v: [-0.1, -0.2, -0.3, -0.4],
      }),
    }),
  });
  const descending = await buildFieldPayload({
    box: BAY,
    atMs: T0,
    allowHfr: false,
    deps: deps({
      // Same physical field, longitude emitted east-to-west: each row reversed.
      fetchGlobalCurrents: globalRaw({
        lats: [36.5, 36.75],
        lons: [-122, -122.25],
        u: [0.2, 0.1, 0.4, 0.3],
        v: [-0.2, -0.1, -0.4, -0.3],
      }),
    }),
  });
  assert.deepEqual(descending.grid, ascending.grid);
  assert.equal(descending.grid.lon0, -122.25, 'column 0 is the westernmost');
  assert.equal(descending.grid.dLon, 0.25);
  assert.deepEqual(descending.u, ascending.u);
  assert.deepEqual(descending.v, ascending.v);

  // Both axes descending at once exercises the two flips together.
  const both = await buildFieldPayload({
    box: BAY,
    atMs: T0,
    allowHfr: false,
    deps: deps({
      fetchGlobalCurrents: globalRaw({
        lats: [36.75, 36.5],
        lons: [-122, -122.25],
        u: [0.4, 0.3, 0.2, 0.1],
        v: [-0.4, -0.3, -0.2, -0.1],
      }),
    }),
  });
  assert.deepEqual(both.grid, ascending.grid);
  assert.deepEqual(both.u, ascending.u);
  assert.deepEqual(both.v, ascending.v);
});

test('an axis with a non-finite value says so instead of blaming the spacing', async () => {
  const payload = await buildFieldPayload({
    box: BAY,
    atMs: T0,
    allowHfr: false,
    deps: deps({
      fetchGlobalCurrents: async () => ({
        lats: Float64Array.from([36.5, Number.NaN, 37]),
        lons: Float64Array.from([-122.25, -122]),
        u: new Float32Array(6),
        v: new Float32Array(6),
      }),
    }),
  });
  assert.equal(payload.status, 'unavailable');
  assert.match(payload.reason, /latitude axis has a non-finite value at index 1/);
});

test('the global fetcher is told which clock the payload measures age against', async () => {
  // The payload documents ageMs as requestedAtMs - validAtMs, but the fetcher
  // computes its own source.ageMs against `nowMs`, which defaults to Date.now().
  // Leaving it to default would report two different ages for the same field
  // whenever the caller asks for a valid time other than "now".
  let seen;
  await buildFieldPayload({
    box: BAY,
    atMs: T0,
    allowHfr: false,
    deps: deps({
      fetchGlobalCurrents: async (options) => {
        seen = options;
        return globalOk()();
      },
    }),
  });
  assert.equal(seen.nowMs, T0);
  assert.deepEqual(seen.box, { latMin: 36.3, lonMin: -122.5, latMax: 37.3, lonMax: -121.5 });
  assert.ok(Number.isInteger(seen.targetCells) && seen.targetCells > 0);
});

test('the global tier admits when it served a different time from the one asked for', async () => {
  // fetchGlobalCurrents always probes time[(last)] and cannot honour a historical
  // atMs, so a request for last week comes back as the newest step. Substituting
  // the served time for the requested one in silence is the exact failure the
  // payload exists to prevent, and the clamp to ageMs >= 0 would otherwise print
  // "just now" for a three-day-old field.
  const lastWeek = T0 - 7 * 86400_000;
  const validAtMs = T0 - 3 * 86400_000;
  const payload = await buildFieldPayload({
    box: BAY,
    atMs: lastWeek,
    allowHfr: false,
    deps: deps({
      fetchGlobalCurrents: globalRaw({
        lats: [36.5, 36.75],
        lons: [-122.25, -122],
        u: [0.1, 0.2, 0.3, 0.4],
        v: [0, 0, 0, 0],
        source: { datasetId: 'noaacwBLENDEDNRTcurrentsDaily', resolutionDeg: 0.25, validAtMs },
      }),
    }),
  });
  assert.equal(payload.requestedAtMs, lastWeek);
  assert.equal(payload.provenance.validAtMs, validAtMs);
  assert.equal(payload.provenance.ageMs, 0, 'a field newer than the request is not "aged"');
  assert.ok(
    payload.provenance.caveats.some((c) => c.includes(new Date(validAtMs).toISOString())),
    `expected the served valid time in the caveats, got ${JSON.stringify(payload.provenance.caveats)}`,
  );

  // The ordinary "asked for now" case must not pick up the caveat.
  const now = await buildFieldPayload({
    box: BAY, atMs: T0, allowHfr: false, deps: deps(),
  });
  assert.equal(now.provenance.caveats.some((c) => /newest published step is available/.test(c)), false);
});

test('a global field that is entirely no-data is refused, never served as an all-null grid', async () => {
  const payload = await buildFieldPayload({
    box: BAY,
    atMs: T0,
    allowHfr: false,
    deps: deps({
      fetchGlobalCurrents: globalRaw({
        lats: [36.5, 36.75],
        lons: [-122.25, -122],
        u: [Number.NaN, Number.NaN, Number.NaN, Number.NaN],
        v: [0.1, 0.2, 0.3, 0.4],
      }),
    }),
  });
  assert.equal(payload.status, 'unavailable');
  assert.equal(payload.u, null);
  assert.match(payload.reason, /entirely no-data/);
});

test('non-uniform global axes are treated as upstream drift, not smoothed over', async () => {
  const payload = await buildFieldPayload({
    box: BAY,
    atMs: T0,
    allowHfr: false,
    deps: deps({
      fetchGlobalCurrents: async () => ({
        lats: [36.5, 36.75, 37.4], // third step is 0.65, not 0.25
        lons: [-122.25, -122],
        u: [0, 0, 0, 0, 0, 0],
        v: [0, 0, 0, 0, 0, 0],
      }),
    }),
  });
  assert.equal(payload.status, 'unavailable');
  assert.match(payload.reason, /not uniformly spaced/);
});

/* ---------------------------------------------------------------- *
 * HF-radar preconditions and diagnostics
 * ---------------------------------------------------------------- */

test('a box that does not project to a separable lattice is caught before barnesVector', async () => {
  // 1 deg tall and a full 360 deg wide at 89.4 N: only 421 km on the ground, so
  // chooseTier really does route it here, and the projection's longitude wrap
  // puts the last column back on top of the first.
  const polar = box(88.9, -180, 89.9, 180);
  assert.equal(chooseTier(polar).id, 'hfr', 'the precondition failure must be reachable');
  let barnesCalls = 0;
  const payload = await buildFieldPayload({
    box: polar,
    atMs: T0,
    targetCells: 256,
    deps: deps({
      fetchHfrField: hfrOk({ observations: observations(60, polar) }),
      barnesVector: (...args) => { barnesCalls += 1; return barnesFilling(1)(...args); },
    }),
  });
  assert.equal(barnesCalls, 0, 'the guard must fire before the kernel, not after its RangeError');
  assert.equal(payload.provenance.tier, 'global');
  assert.match(payload.attempts[0].reason, /does not project to a separable Barnes lattice \(longitude axis/);
  assert.doesNotMatch(payload.attempts[0].reason, /flattened per-cell coordinates/);
});

test('a barnesVector whose output does not match the grid demotes the tier instead of shipping it', async () => {
  const payload = await buildFieldPayload({
    box: BAY,
    atMs: T0,
    targetCells: 256,
    deps: deps({
      barnesVector: (obs, xs, ys) => {
        const n = xs.length * ys.length;
        return { u: new Float64Array(n - 1).fill(0.2), v: new Float64Array(n).fill(0.1), used: obs.length };
      },
    }),
  });
  assert.equal(payload.provenance.tier, 'global');
  assert.match(payload.attempts[0].reason, /barnesVector returned \d+ u \/ \d+ v values for \d+ grid nodes/);
});

test('observations that are not two finite numbers at a finite place are dropped', async () => {
  const good = observations(45);
  const spoiled = good.map((o, i) => (i < 10 ? { ...o, u: Number.NaN } : o));
  const payload = await buildFieldPayload({
    box: BAY,
    atMs: T0,
    targetCells: 256,
    deps: deps({ fetchHfrField: hfrOk({ observations: spoiled }) }),
  });
  // 45 arrived (past the 40 floor), 35 survived the shape check (below it).
  assert.equal(payload.provenance.tier, 'global');
  assert.match(payload.attempts[0].reason, /only 35 HF-radar vectors survived shape checks \(need 40\)/);
});

test('cross-validation is optional and its loss is admitted, never faked', async () => {
  const off = await buildFieldPayload({
    box: BAY, atMs: T0, targetCells: 256, validate: false, deps: deps(),
  });
  assert.equal(off.provenance.tier, 'hfr');
  assert.equal(off.provenance.rmseMs, null);
  assert.equal(off.provenance.maeMs, null);
  assert.equal(off.provenance.biasUMs, null);
  assert.equal(off.provenance.holdoutCount, 0);
  assert.ok(off.provenance.caveats.some((c) => /No holdout cross-validation/.test(c)));

  // A validator that blows up costs the diagnostic, never the field.
  const broken = await buildFieldPayload({
    box: BAY,
    atMs: T0,
    targetCells: 256,
    deps: deps({ validateAnalysis: () => { throw new Error('singular matrix'); } }),
  });
  assert.equal(broken.provenance.tier, 'hfr');
  assert.equal(broken.status, 'ok');
  assert.equal(broken.provenance.rmseMs, null);
  assert.ok(broken.provenance.caveats.some((c) => /No holdout cross-validation/.test(c)));

  // So does one that answers with a shape this module does not recognise.
  const garbled = await buildFieldPayload({
    box: BAY,
    atMs: T0,
    targetCells: 256,
    deps: deps({ validateAnalysis: () => ({ rmse: 0.09 }) }),
  });
  assert.equal(garbled.provenance.rmseMs, null);
  assert.equal(garbled.provenance.holdoutCount, 0);
});

/* ---------------------------------------------------------------- *
 * Total failure
 * ---------------------------------------------------------------- */

test('both tiers failing yields status unavailable with a reason and no field at all', async () => {
  const payload = await buildFieldPayload({
    box: BAY,
    atMs: T0,
    deps: deps({ fetchHfrField: async () => null, fetchGlobalCurrents: async () => null }),
  });

  assert.equal(payload.status, 'unavailable');
  assert.equal(payload.grid, null);
  assert.equal(payload.u, null, 'never an array of nulls masquerading as a field');
  assert.equal(payload.v, null);
  assert.equal(payload.stats, null);
  assert.equal(payload.provenance, null);
  assert.ok(payload.reason.length > 0);
  assert.deepEqual(payload.attempts, [
    { tier: 'hfr', reason: 'no HF-radar vectors in view' },
    { tier: 'global', reason: 'global current field unavailable' },
  ]);
  assert.match(payload.reason, /hfr: no HF-radar vectors in view; global: global current field unavailable/);
});

test('a speckle analysis plus a dead global tier is unavailable, not a field of holes', async () => {
  // Below the composite floor the analysis is not served on its own either: at
  // 1% of the water there is no field, and `status: 'unavailable'` says so
  // rather than shipping a lattice that is 99% null.
  const payload = await buildFieldPayload({
    box: BAY,
    atMs: T0,
    targetCells: 1024,
    deps: deps({
      barnesVector: barnesFilling(MIN_HFR_CONTRIBUTION / 2),
      fetchGlobalCurrents: async () => null,
    }),
  });
  assert.equal(payload.status, 'unavailable');
  assert.equal(payload.u, null);
  assert.equal(payload.provenance, null);
  assert.equal(payload.attempts.length, 2);
  assert.deepEqual(payload.attempts.map((a) => a.tier), ['hfr', 'global']);
  assert.match(payload.attempts[0].reason, /below the 2% worth compositing/);
  assert.match(payload.reason, /no ocean-current tier could serve this view/);
});

test('a malformed box is refused before any fetcher is called', async () => {
  let called = 0;
  const payload = await buildFieldPayload({
    box: box(40, -122, 30, -121),
    atMs: T0,
    deps: deps({
      fetchHfrField: async () => { called += 1; return null; },
      fetchGlobalCurrents: async () => { called += 1; return null; },
    }),
  });
  assert.equal(payload.status, 'unavailable');
  assert.match(payload.reason, /unusable view box: latMax must exceed latMin/);
  assert.equal(called, 0);
  assert.deepEqual(payload.box, { latMin: 40, lonMin: -122, latMax: 30, lonMax: -121 });
});

/* ---------------------------------------------------------------- *
 * Wire format invariants
 * ---------------------------------------------------------------- */

test('every payload variant round-trips through JSON unchanged', async () => {
  const variants = await Promise.all([
    buildFieldPayload({ box: BAY, atMs: T0, targetCells: 512, deps: deps() }),
    buildFieldPayload({ box: BAY, atMs: T0, targetCells: 512, deps: deps({ barnesVector: barnesFilling(0.5) }) }),
    buildFieldPayload({ box: BAY, atMs: T0, allowHfr: false, deps: deps() }),
    buildFieldPayload({
      box: BAY,
      atMs: T0,
      deps: deps({ fetchHfrField: async () => null, fetchGlobalCurrents: async () => null }),
    }),
  ]);
  for (const payload of variants) {
    assert.deepStrictEqual(JSON.parse(JSON.stringify(payload)), payload);
    assert.equal(JSON.stringify(payload).includes('undefined'), false);
  }
});

test('a box carrying a signed zero still round-trips through JSON', async () => {
  // A camera sitting on the prime meridian hands back -0 from any `x * -1`, and
  // JSON.parse(JSON.stringify(-0)) is +0, so an un-normalised echo would make the
  // payload differ from its own serialisation under deepStrictEqual.
  const payload = await buildFieldPayload({
    box: { latMin: -1, lonMin: -0, latMax: 1, lonMax: 2 },
    atMs: T0,
    targetCells: 256,
    deps: deps(),
  });
  assert.equal(Object.is(payload.box.lonMin, -0), false);
  assert.equal(Object.is(payload.grid.lon0, -0), false);
  assert.deepStrictEqual(JSON.parse(JSON.stringify(payload)), payload);
});

test('an identical request is byte-identical apart from the server clock', async () => {
  const request = () => buildFieldPayload({ box: BAY, atMs: T0, targetCells: 512, deps: deps() });
  const [a, b] = await Promise.all([request(), request()]);
  assert.ok(Number.isFinite(a.generatedAtMs) && Number.isFinite(b.generatedAtMs));
  delete a.generatedAtMs;
  delete b.generatedAtMs;
  assert.deepStrictEqual(a, b, 'the holdout seed is fixed, so the reported skill must not wander');
});

test('speed statistics are attained values over the finite cells only', async () => {
  // Twenty cells with speeds 0.1..2.0 m/s (u = 0.1k, v = 0), the rest voids.
  // Nearest-rank p95 of 20 samples is the 19th, i.e. 1.9; the mean is 1.05.
  const payload = await buildFieldPayload({
    box: BAY,
    atMs: T0,
    allowHfr: false,
    deps: deps({
      fetchGlobalCurrents: globalRaw({
        lats: [36.5, 36.75, 37, 37.25, 37.5],
        lons: [-122.25, -122, -121.75, -121.5],
        u: Array.from({ length: 20 }, (_, k) => 0.1 * (k + 1)),
        v: new Array(20).fill(0),
      }),
    }),
  });
  assert.equal(payload.stats.cells, 20);
  assert.equal(payload.stats.finite, 20);
  assert.equal(payload.stats.speedMaxMs, 2);
  assert.equal(payload.stats.speedP95Ms, 1.9);
  assert.equal(payload.stats.speedMeanMs, 1.05);

  // Voids must not enter the population as zeros.
  const holed = await buildFieldPayload({
    box: BAY,
    atMs: T0,
    allowHfr: false,
    deps: deps({
      fetchGlobalCurrents: globalRaw({
        lats: [36.5, 36.75],
        lons: [-122.25, -122],
        u: [1, Number.NaN, Number.NaN, 3],
        v: [0, 0, 0, 0],
      }),
    }),
  });
  assert.equal(holed.stats.finite, 2);
  assert.equal(holed.stats.speedMeanMs, 2, 'mean over the two finite cells, not over four');
});

test('normalizeBox measures longitude eastward and boxSpanKm measures it on the ground', () => {
  assert.equal(normalizeBox(box(-1, 179, 1, -179)).lonSpanDeg, 2);
  assert.equal(normalizeBox(box(-1, -170, 1, 170)).lonSpanDeg, 340,
    'eastward from lonMin, not the shorter of the two arcs');
  assert.equal(normalizeBox(box(-1, -180, 1, 180)).lonSpanDeg, 360);
  assert.equal(normalizeBox(box(-1, 179, 1, -179)).midLon, 180);

  const span = boxSpanKm(box(69.5, 0, 70.5, 10));
  assert.ok(Math.abs(span.latKm - metresPerDegLat(70) / 1000) < 0.02);
  assert.ok(Math.abs(span.lonKm - 10 * metresPerDegLon(70) / 1000) < 0.02);
  assert.equal(span.maxKm, Math.max(span.latKm, span.lonKm));
  assert.throws(() => boxSpanKm(box(30, -122, 40, -122)), /longitude span is zero/);
});

test('u and v are row-major over lat-major indices and agree with the analysis nodes', async () => {
  const targetCells = 256;
  const grid = buildTargetGrid(BAY, targetCells);
  const projection = createTangentProjection(BAY);

  // u carries each node's eastward metre offset (from the SEPARABLE column
  // axis); v carries its flat index. Both scaled into a plausible m/s range so
  // the sanity gate passes.
  const payload = await buildFieldPayload({
    box: BAY,
    atMs: T0,
    targetCells,
    deps: deps({
      barnesVector: (_obs, xs, ys) => {
        const nx = xs.length;
        const n = nx * ys.length;
        const u = new Float64Array(n);
        const v = new Float64Array(n);
        for (let iy = 0; iy < ys.length; iy += 1) {
          for (let ix = 0; ix < nx; ix += 1) {
            const k = iy * nx + ix;
            u[k] = xs[ix] / 1e6;
            v[k] = k / 1e6;
          }
        }
        return { u, v, used: _obs.length };
      },
    }),
  });

  assert.equal(payload.provenance.tier, 'hfr');
  assert.equal(payload.grid.nLat, grid.nLat);
  assert.equal(payload.grid.nLon, grid.nLon);

  const round3 = (x) => { const r = Math.round(x * 1000) / 1000; return r === 0 ? 0 : r; };
  for (const [i, j] of [[0, 0], [0, grid.nLon - 1], [grid.nLat - 1, 0], [3, 5], [grid.nLat - 1, grid.nLon - 1]]) {
    const k = i * payload.grid.nLon + j;
    const lat = payload.grid.lat0 + i * payload.grid.dLat;
    const lon = payload.grid.lon0 + j * payload.grid.dLon;
    assert.equal(lat, grid.lats[i]);
    assert.equal(lon, grid.lons[j]);
    assert.equal(payload.v[k], round3(k / 1e6), `flat index ${k} must be latIndex*nLon + lonIndex`);
    assert.equal(
      payload.u[k],
      round3(projection.project(lat, lon).x / 1e6),
      `node (${i},${j}) must be projected from (${lat}, ${lon})`,
    );
  }
});

test('the tangent projection is metric, centred, and separable', () => {
  const projection = createTangentProjection(BAY);
  assert.equal(projection.lat0, 36.8);
  assert.equal(projection.lon0, -122);

  const origin = projection.project(36.8, -122);
  assert.ok(Math.hypot(origin.x, origin.y) < 1e-9);

  // Exact at the centre latitude/meridian: 0.5 deg is 0.5 * the WGS84 radius term.
  assert.ok(Math.abs(projection.project(37.3, -122).y - 0.5 * metresPerDegLat(36.8)) < 1e-6);
  assert.ok(Math.abs(projection.project(36.8, -121.5).x - 0.5 * metresPerDegLon(36.8)) < 1e-6);

  // SEPARABLE is the property barnesVector's row sweep depends on: x must
  // depend only on longitude and y only on latitude. An azimuthal-equidistant
  // map would fail exactly this assertion.
  for (const lat of [36.3, 36.8, 37.3]) {
    assert.equal(projection.project(lat, -121.7).x, projection.project(36.8, -121.7).x);
  }
  for (const lon of [-122.5, -122, -121.5]) {
    assert.equal(projection.project(37.1, lon).y, projection.project(37.1, -122).y);
  }

  // Longitude differences wrap, so an antimeridian box is 2 deg wide, not 358.
  const seam = createTangentProjection(box(-1, 179, 1, -179));
  assert.equal(seam.lon0, 180);
  assert.ok(seam.projectLon(181) > seam.projectLon(179));
  assert.ok(Math.abs(seam.projectLon(181) - seam.projectLon(179) - 2 * metresPerDegLon(0)) < 1e-6);
});

test('the WGS84 degree scales vary with latitude instead of a single constant', () => {
  // The reference project hard-codes M_PER_DEG_LAT = 111132.95 everywhere. The
  // true meridian degree runs 110574 m at the equator to 111694 m at the pole
  // (WGS84 a = 6378137, 1/f = 298.257223563), so that constant is ~0.5% off at
  // both ends. Pin the endpoints so a refactor cannot quietly reintroduce one.
  assert.ok(Math.abs(metresPerDegLat(0) - 110574) < 1, metresPerDegLat(0));
  assert.ok(Math.abs(metresPerDegLat(90) - 111694) < 1, metresPerDegLat(90));
  assert.ok(metresPerDegLat(90) > metresPerDegLat(45) && metresPerDegLat(45) > metresPerDegLat(0));

  // The parallel degree is 111319.5 m at the equator and collapses at the pole.
  assert.ok(Math.abs(metresPerDegLon(0) - 111319.5) < 1, metresPerDegLon(0));
  assert.ok(metresPerDegLon(90) < 1e-6);
  // cos-like falloff is what makes chooseTier treat a wide arctic box as small.
  assert.ok(Math.abs(metresPerDegLon(60) / metresPerDegLon(0) - 0.5) < 2e-3);
});

test('formatAge says out loud how old a field is', () => {
  assert.equal(formatAge(null), 'age unknown');
  assert.equal(formatAge(Number.NaN), 'age unknown');
  assert.equal(formatAge(5_000), 'just now');
  assert.equal(formatAge(42 * 60_000), '42 min old');
  assert.equal(formatAge(7 * 3600_000), '7 h old');
  assert.equal(formatAge(26 * 3600_000), '1 day old');
  assert.equal(formatAge(3 * 86400_000), '3 days old');
});

test('formatAge renders a forecast as AHEAD, never as "just now"', () => {
  // The global tier can be served by HYCOM, which publishes ~5 days out and
  // reports a NEGATIVE ageMs on purpose. Rendering that as "just now" is the
  // single most misleading thing a freshness label can say, and it is what a
  // Math.max(0, ...) clamp in resolveAgeMs used to produce.
  assert.equal(formatAge(-4 * 86400_000), '4 days ahead');
  assert.equal(formatAge(-26 * 3600_000), '1 day ahead');
  assert.equal(formatAge(-6 * 3600_000), '6 h ahead');
  assert.equal(formatAge(-42 * 60_000), '42 min ahead');
  // The "just now" band stays symmetric so ordinary clock skew is still skew.
  assert.equal(formatAge(-5_000), 'just now');
});

test('a HYCOM forecast step is labelled a forecast, not a fresh analysis', async () => {
  // The step nearest "now" on a -10 d .. +5 d axis can be ahead of now. The
  // fetcher reports ageMs against NOW (negative) and declares isForecast; every
  // one of those signals used to be destroyed between here and the legend.
  const leadMs = 4 * 86400_000;
  const validAtMs = T0 + leadMs;
  const payload = await buildFieldPayload({
    box: BAY,
    atMs: T0,
    allowHfr: false,
    deps: deps({
      fetchGlobalCurrents: globalRaw({
        lats: [36.5, 36.75],
        lons: [-122.25, -122],
        u: [0.1, 0.2, 0.3, 0.4],
        v: [0, 0, 0, 0],
        source: {
          datasetId: 'FMRC_ESPC-D-V02_uv3z_best',
          resolutionDeg: 0.04,
          validAtMs,
          ageMs: -leadMs,
          isForecast: true,
          forecastLeadMs: leadMs,
          kind: 'modeled',
          method: 'HYCOM ESPC-D-V02 primitive-equation ocean forecast',
        },
      }),
    }),
  });

  const p = payload.provenance;
  assert.equal(p.ageMs, -leadMs, 'the reported forecast age keeps its sign');
  assert.equal(p.ageLabel, '4 days ahead');
  assert.equal(p.isForecast, true);
  assert.equal(p.forecastLeadMs, leadMs);
  assert.equal(p.stale, false, 'a forecast is not stale');
  assert.equal(p.kind, 'modeled');
  assert.match(p.note, /primitive-equation model carrying tides/);
  assert.ok(
    p.caveats.some((c) => /FORECAST step/.test(c)),
    `expected a forecast caveat, got ${JSON.stringify(p.caveats)}`,
  );
  assert.equal(
    p.caveats.some((c) => /newest published step is available/.test(c)),
    false,
    'a forecast is not a publication-lag limit and must not be described as one',
  );
  // The sources[] entry carries the same facts, so a composite legend can too.
  assert.equal(p.sources[0].isForecast, true);
  assert.equal(p.sources[0].ageLabel, '4 days ahead');
});

test('a historical request served with the newest analysis is not called a forecast', async () => {
  // The guard on the other side: ageMs derived from a HISTORICAL atMs is
  // negative without anything being a forecast, so forecast-ness is read from
  // the source's own declaration and never from the sign.
  const lastWeek = T0 - 7 * 86400_000;
  const validAtMs = T0 - 3 * 86400_000;
  const payload = await buildFieldPayload({
    box: BAY,
    atMs: lastWeek,
    allowHfr: false,
    deps: deps({
      fetchGlobalCurrents: globalRaw({
        lats: [36.5, 36.75],
        lons: [-122.25, -122],
        u: [0.1, 0.2, 0.3, 0.4],
        v: [0, 0, 0, 0],
        source: { datasetId: 'noaacwBLENDEDNRTcurrentsDaily', resolutionDeg: 0.25, validAtMs },
      }),
    }),
  });
  assert.equal(payload.provenance.isForecast, false);
  assert.equal(payload.provenance.forecastLeadMs, null);
  assert.equal(payload.provenance.ageMs, 0);
  assert.ok(payload.provenance.caveats.some((c) => /newest published step is available/.test(c)));
});

test('a HYCOM-to-altimetry degradation is stated in the legend, not swallowed', async () => {
  // globalTier records WHY the preferred source did not serve. Every payload
  // builder used to drop that string, so a fall from tide- and wind-carrying
  // primitive equations to geostrophic-only altimetry left no trace at all.
  const reason = 'HYCOM unavailable: upstream returned 503';
  const payload = await buildFieldPayload({
    box: BAY,
    atMs: T0,
    allowHfr: false,
    deps: deps({
      fetchGlobalCurrents: globalRaw({
        lats: [36.5, 36.75],
        lons: [-122.25, -122],
        u: [0.1, 0.2, 0.3, 0.4],
        v: [0, 0, 0, 0],
        source: {
          datasetId: 'noaacwBLENDEDNRTcurrentsDaily',
          resolutionDeg: 0.25,
          validAtMs: T0 - 2 * 86400_000,
          kind: 'derived',
          fallbackFrom: reason,
        },
      }),
    }),
  });
  const p = payload.provenance;
  assert.ok(
    p.caveats.some((c) => c.includes(reason) && /no wind drift, no tides/.test(c)),
    `expected the degradation in the caveats, got ${JSON.stringify(p.caveats)}`,
  );
  assert.equal(p.sources[0].preferredSourceUnavailable, reason);
  assert.match(p.note, /Blended global surface currents/);
});

test('a Float32 stitched longitude axis is accepted, not read as shape drift', async () => {
  // The REAL axis HYCOM served for an English Channel box on 2026-09-02, captured
  // verbatim. HYCOM delivers Float32 coordinates in a 0-360 frame, and a box
  // crossing the PRIME MERIDIAN is stitched from two index ranges then shifted
  // into -180..180, so the residual is inherited from the pre-shift magnitude
  // where one ulp at 359.92 deg is 3.05e-5 deg. This axis deviates 1.03e-4 deg
  // about its own least-squares line -- more than the 8e-5 that 0.1% of a
  // 0.08 deg step allows. That rejected the entire tier and left the Channel
  // blank while the data was perfectly good.
  const lons = Float64Array.from([-2.560058594,-2.479980469,-2.400024414,-2.320068359,-2.239990234,-2.16003418,-2.079956055,-2,-1.920043945,-1.83996582,-1.760009766,-1.679931641,-1.599975586,-1.520019531,-1.439941406,-1.359985352,-1.280029297,-1.199951172,-1.119995117,-1.040039063,-0.959960938,-0.880004883,-0.800048828,-0.719970703,-0.640014648,-0.560058594,-0.479980469,-0.400024414,-0.320068359,-0.239990234,-0.16003418,-0.079956055,0,0.079956055,0.16003418,0.239990234,0.319946289,0.400024414,0.479980469,0.560058594]);
  const nLon = lons.length;
  const nLat = 4;
  const lats = Float64Array.from({ length: nLat }, (_, i) => Math.fround(49.52 + i * 0.04));

  const step = (lons[nLon - 1] - lons[0]) / (nLon - 1);
  let maxDev = 0;
  for (let j = 0; j < nLon; j += 1) maxDev = Math.max(maxDev, Math.abs(lons[j] - (lons[0] + j * step)));
  assert.ok(maxDev > Math.abs(step) * 1e-3,
    `fixture must exceed the old 0.1%-of-step tolerance (dev ${maxDev.toExponential(2)} vs ${(Math.abs(step) * 1e-3).toExponential(2)})`);

  const n = nLat * nLon;
  const payload = await buildFieldPayload({
    box: box(49.5, -2.5, 51.0, 0.5),
    atMs: T0,
    allowHfr: false,
    deps: deps({
      fetchGlobalCurrents: async () => ({
        lats,
        lons,
        u: Float32Array.from({ length: n }, () => 0.3),
        v: Float32Array.from({ length: n }, () => -0.1),
        source: { datasetId: 'FMRC_ESPC-D-V02_uv3z_best', resolutionDeg: 0.04, validAtMs: T0 },
      }),
    }),
  });

  assert.equal(payload.status, 'ok', payload.reason);
  assert.equal(payload.grid.nLon, nLon);
  assert.ok(payload.grid.dLon > 0, 'the stitched axis must still yield a positive step');
});
