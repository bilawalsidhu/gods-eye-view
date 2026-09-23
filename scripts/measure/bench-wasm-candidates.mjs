#!/usr/bin/env node
// Measure the three standing WASM candidates from the R6 plan
// (docs/PLAN.md Batch T, verdicts recorded in docs/PERFORMANCE.md):
//
//   1. LabelArbiter.solve at the DENSE stop — runs on a 125 ms throttle
//      (8 solves/s), so anything ≥ ~2 ms is a main-thread resident.
//   2. The detection-projection O(n) loop (detectionProjection.worker.js's
//      real handler, driven through a `self` shim) — per-frame at 60 fps,
//      budget 16.6 ms.
//   3. AIS bulk row normalization (the production normalizeVessel through
//      its exported test seam, EGM96 grid warm) — per poll over a
//      12k-row payload, chunked 500 rows per idle slice.
//
// All three are pure JS running on V8; node measures the same JIT the
// browser runs. A candidate whose measured cost sits far below the budget
// it runs against is DISQUALIFIED for WASM: there is nothing for a
// compiled kernel to win. Method: 20 warm-up iterations, then 200 timed
// iterations (median + p95). Positions are deterministic pseudo-random
// (LCG) so runs are comparable.
import { performance } from 'node:perf_hooks';

const FRAME_BUDGET_MS = 1000 / 60;

/** Deterministic LCG so every run measures the same workload. */
function lcg(seed) {
  let state = seed >>> 0;
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 0x100000000;
  };
}

function stats(samples) {
  const sorted = [...samples].sort((a, b) => a - b);
  const median = sorted[Math.floor(sorted.length / 2)];
  const p95 = sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.95))];
  const mean = samples.reduce((a, b) => a + b, 0) / samples.length;
  return { median, p95, mean };
}

async function benchLabelArbiter() {
  const { LabelArbiter, allocateLayerQuotas } = await import('../../src/data/labelArbiter.js');
  const LAYERS = ['flights', 'military', 'ais-vessels', 'satellites', 'cctv', 'traffic'];
  const rand = lcg(42);
  // DENSE production shape: per-layer BoundedCohort caps at 256, ambient
  // budget ~100 labels at the DENSE stop; 300 mixed candidates across 6
  // layers with non-overlapping-ish placements spread over a 1920×1080
  // viewport.
  const candidates = [];
  for (let i = 0; i < 300; i += 1) {
    const layerId = LAYERS[i % LAYERS.length];
    const x = Math.round(rand() * 1900);
    const y = Math.round(rand() * 1060);
    candidates.push({
      key: `${layerId}:${i}`,
      layerId,
      sourceId: i,
      priority: i % 3 === 0 ? 25 : 0,
      centerDistance: rand() * 1200,
      keyholeAlpha: 1,
      placements: [{ corner: 'NE', rect: { x, y, w: 20, h: 12 } }],
    });
  }
  const demandByLayer = new Map(LAYERS.map((l) => [l, 50]));
  const arbiter = new LabelArbiter();
  const solve = () => arbiter.solve(candidates, {
    capacity: 100,
    strategy: 'ELASTIC',
    demandByLayer,
    now: 1e6 + Math.round(rand() * 100),
    preserveIncumbents: true,
  });
  for (let i = 0; i < 20; i += 1) solve();
  const samples = [];
  for (let i = 0; i < 200; i += 1) {
    const t0 = performance.now();
    solve();
    samples.push(performance.now() - t0);
  }
  const selected = arbiter.lastDiagnostics?.selected ?? arbiter.activeStateCount();
  // Quota allocation rides the same throttle — measure it for the record.
  const quotaSamples = [];
  for (let i = 0; i < 200; i += 1) {
    const t0 = performance.now();
    allocateLayerQuotas(demandByLayer, 100, 'ELASTIC', {});
    quotaSamples.push(performance.now() - t0);
  }
  return {
    workload: '300 candidates / 6 layers / capacity 100 (DENSE), 1920×1080 placements',
    solve: stats(samples),
    quotaAlloc: stats(quotaSamples),
    budget: '8 solves/s (125 ms throttle)',
    selected,
  };
}

/** Install the `self` shim and import the worker ONCE — an ESM module
 * evaluates a single time per process, so the shim must be in place before
 * the first (and only) import and every later payload rides the same
 * registered handler. Returns a drive(payload) → output-message function. */
async function setupDetectionProjection() {
  const listeners = {};
  let lastMessage = null;
  globalThis.self = {
    addEventListener: (type, fn) => { listeners[type] = fn; },
    postMessage: (msg) => { lastMessage = msg; },
  };
  await import('../../src/workers/detectionProjection.worker.js');
  if (!listeners.message) {
    throw new Error('worker did not register a message handler');
  }
  return (payload) => {
    listeners.message({ data: payload });
    return lastMessage;
  };
}

async function benchDetectionProjection(drive, count, seed) {
  const rand = lcg(seed);
  // Camera above the WGS84 surface looking at contacts spread over the
  // visible hemisphere; ~1/3 of rows project off-screen (clipW ≤ 0) and a
  // few sit behind the horizon so both early-out arms execute.
  const R = 6378137;
  const cam = { x: 0, y: 0, z: R + 2e6 };
  const objects = new Map();
  for (let i = 0; i < count; i += 1) {
    const theta = rand() * Math.PI * 2;
    const phi = rand() * Math.PI * 0.45; // northern cap → mostly visible
    objects.set(i, {
      id: i,
      type: i % 5 === 0 ? 'Vessel' : 'AIR',
      skipLabel: i % 17 === 0,
      position: {
        x: R * Math.sin(phi) * Math.cos(theta),
        y: R * Math.sin(phi) * Math.sin(theta),
        z: R * Math.cos(phi),
      },
    });
  }
  const payload = {
    objectsById: objects,
    // A plausible rigid view-projection (values only need to be finite and
    // exercise the math; scale does not change the arithmetic count).
    viewProjection: {
      vp0: 1.8, vp1: 0, vp3: 0, vp4: 0, vp5: 3.2, vp7: 0,
      vp8: 0, vp9: 0, vp11: 1, vp12: 0.5, vp13: 0.5, vp15: 1.2,
    },
    cameraPosition: cam,
    width: 1920,
    height: 1080,
    camPos: cam,
    occluderCameraPos: cam,
    requestId: 1,
  };
  for (let i = 0; i < 20; i += 1) drive(payload);
  const samples = [];
  let visible = 0;
  for (let i = 0; i < 200; i += 1) {
    const t0 = performance.now();
    const out = drive(payload);
    samples.push(performance.now() - t0);
    visible = out.results.filter((r) => r.visible).length;
  }
  const s = stats(samples);
  return {
    count,
    stats: s,
    visible,
    frameBudgetPct: (s.median / FRAME_BUDGET_MS) * 100,
  };
}

async function benchAisNormalization() {
  const { _normalizeVesselForTest } = await import('../../src/data/aisLiveVessels.js');
  const { ensureGeoidReady } = await import('../../src/data/geoid.js');
  await ensureGeoidReady(); // bundled EGM96 grid — production steady state
  const rand = lcg(7);
  // AISStream row shape (normalizeVessel's field set), 12k rows = the
  // horizon-scale payload production observed (docs/PERFORMANCE.md).
  const ROWS = 12_000;
  const rows = Array.from({ length: ROWS }, (_, i) => ({
    mmsi: String(100000000 + i),
    input_identifier: `ID${i}`,
    name: i % 7 === 0 ? '' : `MV RNG ${i}`,
    imo: i % 3 === 0 ? String(9000000 + i) : '',
    type_specific: ['Cargo', 'Tanker', 'Fishing', 'Pleasure Craft'][i % 4],
    destination: i % 2 === 0 ? 'NLRTM' : '',
    speed: rand() * 22,
    course: rand() * 360,
    heading: rand() * 360,
    lat: 24 + rand() * 14,      // a busy real band (Gulf of Mexico-ish)
    lon: -98 + rand() * 20,
    last_position_UTC: '2026-09-23 12:00:00',
    last_position_epoch: 1758624000 + i,
  }));
  for (let i = 0; i < 5; i += 1) rows.forEach((r) => _normalizeVesselForTest(r));
  const samples = [];
  let normalized = 0;
  for (let i = 0; i < 30; i += 1) {
    const t0 = performance.now();
    for (const row of rows) {
      if (_normalizeVesselForTest(row)) normalized += 1;
    }
    samples.push(performance.now() - t0);
  }
  return {
    rows: ROWS,
    stats: stats(samples),
    normalized,
    perRowUs: (stats(samples).median * 1000) / ROWS,
    chunkedSliceMs: (stats(samples).median / (ROWS / 500)),
  };
}

const results = {};
results.labelArbiter = await benchLabelArbiter();
const driveProjection = await setupDetectionProjection();
results.projection250 = await benchDetectionProjection(driveProjection, 250, 11);
results.projection1000 = await benchDetectionProjection(driveProjection, 1000, 12);
results.projection5000 = await benchDetectionProjection(driveProjection, 5000, 13);
results.aisNormalization = await benchAisNormalization();

const fmt = (s) => `median ${s.median.toFixed(3)} ms | p95 ${s.p95.toFixed(3)} ms | mean ${s.mean.toFixed(3)} ms`;
console.log('=== WASM-candidate benchmarks (node V8, median/p95 of timed iters) ===');
console.log(`[1] LabelArbiter.solve  ${results.labelArbiter.workload}`);
console.log(`    ${fmt(results.labelArbiter.solve)}   [budget: ${results.labelArbiter.budget}]`);
console.log(`    allocateLayerQuotas: ${fmt(results.labelArbiter.quotaAlloc)}`);
for (const key of ['projection250', 'projection1000', 'projection5000']) {
  const r = results[key];
  console.log(`[2] detectionProjection n=${r.count} (${r.visible} visible rows/frame)`);
  console.log(`    ${fmt(r.stats)}   [budget: 60 fps frame = ${FRAME_BUDGET_MS.toFixed(1)} ms → ${r.frameBudgetPct.toFixed(2)}%]`);
}
const ais = results.aisNormalization;
console.log(`[3] AIS normalizeVessel × ${ais.rows} rows (EGM96 warm, ${ais.normalized} normalized)`);
console.log(`    ${fmt(ais.stats)} per payload | ${ais.perRowUs.toFixed(3)} µs/row | idle-slice (500 rows): ${ais.chunkedSliceMs.toFixed(3)} ms`);
