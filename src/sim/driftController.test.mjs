import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  normalizeForcingGrid,
  frameForTime,
  createDriftController,
  resolveDriftParams,
  DRIFT_OVERLAY_SOURCE_ID,
  DRIFT_DEFAULTS,
  DRIFT_POSITION_UNCERTAINTY,
} from './driftController.js';
import { createDriftPanel } from './driftPanel.js';

const HOURS = [Date.UTC(2026, 7, 29, 0, 0), Date.UTC(2026, 7, 29, 1, 0)];

/** Minimal 1x1 marine-grid payload (single node, two hours). */
function gridPayload() {
  return {
    status: 'ready',
    seed: { latitude: 33.5, longitude: -118.5 },
    grid: { lats: [33.5], lons: [-118.5] },
    hoursMs: HOURS,
    nodes: [{
      waveHeightM: [1, 1.1],
      currentKmh: [3.6, 7.2],
      currentDirDeg: [90, 90],
      windMs: [10, 10],
      windDirDeg: [180, 180],
    }],
  };
}

test('normalizeForcingGrid converts units and directions into u/v component fields', () => {
  const grid = normalizeForcingGrid(gridPayload());
  assert.deepEqual(grid.lats, [33.5]);
  assert.deepEqual(grid.lons, [-118.5]);
  assert.deepEqual(Array.from(grid.hoursMs), HOURS);
  // Current 3.6 km/h toward 90° → 1 m/s east at hour 0; 2 m/s at hour 1.
  assert.ok(Math.abs(grid.currentU[0] - 1) < 1e-9);
  assert.ok(Math.abs(grid.currentV[0]) < 1e-9);
  assert.ok(Math.abs(grid.currentU[1] - 2) < 1e-9);
  // Wind 10 m/s FROM 180° → blowing north: u≈0, v≈10.
  assert.ok(Math.abs(grid.windU[0]) < 1e-9);
  assert.ok(Math.abs(grid.windV[0] - 10) < 1e-9);
});

test('normalizeForcingGrid marks missing samples NaN and rejects malformed payloads', () => {
  const payload = gridPayload();
  payload.nodes[0].currentKmh[0] = null;
  const grid = normalizeForcingGrid(payload);
  assert.ok(Number.isNaN(grid.currentU[0]));
  assert.ok(Number.isFinite(grid.currentU[1]));

  assert.equal(normalizeForcingGrid(null), null);
  assert.equal(normalizeForcingGrid({ grid: { lats: [1], lons: [1] }, hoursMs: [], nodes: [] }), null);
  assert.equal(normalizeForcingGrid({ grid: { lats: [1], lons: [1] }, hoursMs: HOURS, nodes: [] }), null);
});

test('frameForTime clamps to the ensemble time range and picks the nearest frame', () => {
  const times = Float64Array.from([0, 600000, 1200000]);
  assert.equal(frameForTime(times, -5), 0);
  assert.equal(frameForTime(times, 250000), 0);
  assert.equal(frameForTime(times, 350000), 1);
  assert.equal(frameForTime(times, 9e12), 2);
  assert.equal(frameForTime(Float64Array.from([]), 0), -1);
});

function makeCollection() {
  const points = [];
  return {
    points,
    destroyCalls: 0,
    add(options) { const p = { ...options }; points.push(p); return p; },
    removeAll() { points.length = 0; },
    isDestroyed() { return Boolean(this.destroyed); },
    // Honor Cesium's contract: destroying a destroyed object throws
    // (DeveloperError from destroyObject) — the double must be as strict.
    destroy() {
      if (this.destroyed) throw new Error('This object was destroyed, i.e., destroy() was called.');
      this.destroyCalls += 1;
      this.destroyed = true;
    },
  };
}

function makeSeams() {
  const overlayCalls = [];
  const collection = makeCollection();
  const panel = { frames: [], frameArgs: [], summaries: [], destroyed: false };
  const seams = {
    overlayCalls,
    collection,
    panel,
    // Options the injected panelFactory last received (params/onRerun assertions).
    panelOptions: null,
    // Params the injected runEnsembleFn last received (landMask assertions).
    ensembleParams: null,
    // Total runEnsembleFn invocations (rerun assertions).
    ensembleRuns: 0,
    // Per-test ETOPO response; default 503 so the bitmask fallback engages.
    etopoResponse: async () => ({ ok: false, status: 503 }),
    options: {
      viewer: {
        scene: {
          primitives: {
            added: [],
            add(c) { this.added.push(c); return c; },
            // Honor Cesium's contract: PrimitiveCollection.remove DESTROYS the
            // primitive (destroyPrimitives defaults to true) — the real-app
            // re-run bug lived exactly in this divergence of the old double.
            remove(c) {
              const present = this.added.includes(c);
              this.added = this.added.filter((x) => x !== c);
              if (present && !c.destroyed) c.destroy();
            },
            raiseToTop() {},
          },
        },
      },
      overlayHost: {
        setEntries: (...args) => overlayCalls.push(['entries', ...args]),
        clearSource: (...args) => overlayCalls.push(['clear', ...args]),
      },
      fetchImpl: async (url) => {
        if (String(url).includes('/api/ocean/etopo')) return seams.etopoResponse();
        return { ok: true, json: async () => gridPayload() };
      },
      maskLoaderFn: async () => ({ width: 4, height: 2, data: new Uint8Array([0b01, 0]) }),
      runEnsembleFn: async (params) => {
        seams.ensembleParams = params;
        seams.ensembleRuns += 1;
        // Two frames, params.n particles, all at the seed. Backward runs
        // have DECREASING timesMs per the model contract.
        const n = params.n;
        const frames = new Float32Array(2 * n * 2);
        for (let t = 0; t < 2; t += 1) {
          for (let i = 0; i < n; i += 1) {
            frames[(t * n + i) * 2] = params.seedLon + t * 0.01;
            frames[(t * n + i) * 2 + 1] = params.seedLat;
          }
        }
        const timesMs = Float64Array.from(params.backward ? [HOURS[1], HOURS[0]] : HOURS);
        return { timesMs, frames, n, degraded: false };
      },
      collectionFactory: () => collection,
      panelFactory: (options) => {
        seams.panelOptions = options;
        return {
          setFrame: (i, offsetMs, beachedCount) => {
            panel.frames.push(i);
            panel.frameArgs.push([i, offsetMs, beachedCount]);
          },
          setPlaying: () => {},
          setSummary: (text) => panel.summaries.push(text),
          destroy: () => { panel.destroyed = true; },
        };
      },
    },
  };
  return seams;
}

test('start builds the particle cloud, publishes the SIMULATED banner, and setFrame scrubs it', async () => {
  const seams = makeSeams();
  const controller = createDriftController(seams.options);
  const result = await controller.start({ lat: 33.5, lon: -118.5, label: 'test seed', n: 16 });
  assert.equal(result.ok, true);

  assert.equal(seams.collection.points.length, 16);
  assert.equal(seams.options.viewer.scene.primitives.added.length, 1);

  const banner = seams.overlayCalls.find(([kind, sourceId]) => kind === 'entries' && sourceId === DRIFT_OVERLAY_SOURCE_ID);
  assert.ok(banner, 'drift banner published');
  assert.match(banner[2][0].title, /SIMULATED/i);

  const lonAtFrame0 = seams.collection.points[0].position;
  controller.setFrame(1);
  const lonAtFrame1 = seams.collection.points[0].position;
  assert.notDeepEqual(lonAtFrame1, lonAtFrame0, 'scrubbing moves the particles');

  controller.dispose();
  assert.equal(seams.collection.destroyed, true);
  assert.equal(seams.panel.destroyed, true);
  assert.ok(seams.overlayCalls.some(([kind, sourceId]) => kind === 'clear' && sourceId === DRIFT_OVERLAY_SOURCE_ID));
});

test('start reports failure when the forcing grid is unavailable', async () => {
  const seams = makeSeams();
  seams.options.fetchImpl = async () => ({ ok: false, status: 503 });
  const controller = createDriftController(seams.options);
  const result = await controller.start({ lat: 33.5, lon: -118.5, n: 8 });
  assert.equal(result.ok, false);
  assert.ok(result.reason);
  assert.equal(seams.options.viewer.scene.primitives.added.length, 0);
});

test('a second start disposes the first simulation', async () => {
  const seams = makeSeams();
  const first = makeCollection();
  const second = makeCollection();
  let call = 0;
  seams.options.collectionFactory = () => (call++ === 0 ? first : second);
  const controller = createDriftController(seams.options);
  await controller.start({ lat: 33.5, lon: -118.5, n: 4 });
  await controller.start({ lat: 34.0, lon: -119.0, n: 4 });
  assert.equal(first.destroyed, true);
  assert.equal(second.destroyed, undefined);
  controller.dispose();
});

test('start passes a bathy landMask to the ensemble when ETOPO succeeds', async () => {
  const seams = makeSeams();
  seams.etopoResponse = async () => ({
    ok: true,
    json: async () => ({ status: 'ok', lats: [33, 34], lons: [-119, -118], z: [-10, -5, 0, 3] }),
  });
  const controller = createDriftController(seams.options);
  const result = await controller.start({ lat: 33.5, lon: -118.5, n: 4 });
  assert.equal(result.ok, true);
  const mask = seams.ensembleParams.landMask;
  assert.equal(mask?.type, 'bathy');
  assert.deepEqual(mask.lats, [33, 34]);
  assert.deepEqual(mask.lons, [-119, -118]);
  assert.ok(mask.z instanceof Float32Array, 'z coerced to Float32Array');
  assert.deepEqual(Array.from(mask.z), [-10, -5, 0, 3]);
  controller.dispose();
});

test('start falls back to the bundled bitmask when ETOPO is unavailable', async () => {
  const seams = makeSeams(); // default etopoResponse is a 503
  const controller = createDriftController(seams.options);
  const result = await controller.start({ lat: 33.5, lon: -118.5, n: 4 });
  assert.equal(result.ok, true);
  const mask = seams.ensembleParams.landMask;
  assert.equal(mask?.type, 'mask');
  assert.equal(mask.width, 4);
  assert.equal(mask.height, 2);
  assert.ok(mask.data instanceof Uint8Array);
  controller.dispose();
});

test('start still succeeds with a null landMask when ETOPO and the bitmask both fail', async () => {
  const seams = makeSeams();
  seams.etopoResponse = async () => { throw new Error('network down'); };
  seams.options.maskLoaderFn = async () => { throw new Error('asset missing'); };
  const controller = createDriftController(seams.options);
  const result = await controller.start({ lat: 33.5, lon: -118.5, n: 4 });
  assert.equal(result.ok, true);
  assert.equal(seams.ensembleParams.landMask, null);
  controller.dispose();
});

/** Seams whose ensemble beaches particles 1 and 2 at frames 1 and 2 of 3. */
function beachingSeams() {
  const seams = makeSeams();
  seams.options.runEnsembleFn = async (params) => {
    seams.ensembleParams = params;
    const n = params.n;
    const frames = new Float32Array(3 * n * 2);
    for (let t = 0; t < 3; t += 1) {
      for (let i = 0; i < n; i += 1) {
        frames[(t * n + i) * 2] = params.seedLon;
        frames[(t * n + i) * 2 + 1] = params.seedLat;
      }
    }
    return {
      timesMs: Float64Array.from([0, 600000, 1200000]),
      frames,
      n,
      degraded: false,
      beachedAtFrame: Int32Array.from([-1, 1, 2, -1]),
    };
  };
  return seams;
}

test('setFrame recolors beached particles per-frame and reverts on back-scrub', async () => {
  const seams = beachingSeams();
  const controller = createDriftController(seams.options);
  await controller.start({ lat: 33.5, lon: -118.5, n: 4 });
  const points = seams.collection.points;
  const live = points[0].color;

  // Frame 0: nothing beached yet.
  assert.deepEqual(points[1].color, live);
  assert.deepEqual(points[2].color, live);

  controller.setFrame(1); // particle 1 beaches at frame 1
  assert.notDeepEqual(points[1].color, live);
  assert.deepEqual(points[2].color, live);

  controller.setFrame(2); // particle 2 beaches at frame 2
  assert.notDeepEqual(points[2].color, live);
  assert.deepEqual(points[1].color, points[2].color);
  assert.deepEqual(points[0].color, live);
  assert.deepEqual(points[3].color, live);

  controller.setFrame(0); // back-scrub restores the live color
  assert.deepEqual(points[1].color, live);
  assert.deepEqual(points[2].color, live);
  controller.dispose();
});

test('setFrame reports the beached count to the panel, frame-derived', async () => {
  const seams = beachingSeams();
  const calls = [];
  seams.options.panelFactory = () => ({
    setFrame: (i, offsetMs, beachedCount) => calls.push([i, beachedCount]),
    setPlaying: () => {},
    destroy: () => {},
  });
  const controller = createDriftController(seams.options);
  await controller.start({ lat: 33.5, lon: -118.5, n: 4 });
  assert.deepEqual(calls.at(-1), [0, 0]);
  controller.setFrame(1);
  assert.deepEqual(calls.at(-1), [1, 1]);
  controller.setFrame(2);
  assert.deepEqual(calls.at(-1), [2, 2]);
  controller.setFrame(0);
  assert.deepEqual(calls.at(-1), [0, 0]);
  controller.dispose();
});

test('the simulation can be re-run: start → start, and start → dispose → start', async () => {
  const seams = makeSeams();
  const collections = [];
  seams.options.collectionFactory = () => {
    const c = makeCollection();
    collections.push(c);
    return c;
  };
  const controller = createDriftController(seams.options);

  assert.equal((await controller.start({ lat: 33.5, lon: -118.5, n: 4 })).ok, true);
  assert.equal((await controller.start({ lat: 34.0, lon: -119.0, n: 4 })).ok, true, 'second start succeeds');
  assert.equal(collections[0].destroyCalls, 1, 'first collection destroyed exactly once');

  controller.dispose();
  assert.equal(collections[1].destroyCalls, 1, 'disposed collection destroyed exactly once');
  assert.equal((await controller.start({ lat: 33.5, lon: -118.5, n: 4 })).ok, true, 'start after dispose succeeds');
  controller.dispose();
});

test('defaults respect the frame-buffer memory budget', () => {
  // n · (60·horizonH/dtMin + 1) · 2 · 4 bytes — must stay ≈ tens of MB.
  const frames = DRIFT_DEFAULTS.n * (60 * DRIFT_DEFAULTS.horizonH / DRIFT_DEFAULTS.dtMin + 1) * 2 * 4;
  assert.ok(frames < 32 * 1024 * 1024, `frame buffer ${frames} bytes exceeds 32 MB`);
});

test('resolveDriftParams fills defaults and derives dtMin from the horizon', () => {
  const p = resolveDriftParams({});
  assert.equal(p.horizonH, DRIFT_DEFAULTS.horizonH);
  assert.equal(p.dtMin, 10);
  assert.equal(p.n, DRIFT_DEFAULTS.n);
  assert.equal(p.sigmaTurbMs, DRIFT_DEFAULTS.sigmaTurbMs);
  assert.equal(DRIFT_DEFAULTS.sigmaTurbMs, 0.05);
  assert.equal(p.backward, false);
  // dt auto-scaling: 20 min at 48 h keeps the frame count at 145; 10 min below.
  assert.equal(resolveDriftParams({ horizonH: 6 }).dtMin, 10);
  assert.equal(resolveDriftParams({ horizonH: 24 }).dtMin, 10);
  assert.equal(resolveDriftParams({ horizonH: 48 }).dtMin, 20);
});

test('resolveDriftParams clamps n and every offered combo stays inside the 32 MB budget', () => {
  assert.equal(resolveDriftParams({ n: 90000 }).n, 25000);
  // n · frames · 8 B (2 float32 per particle per frame); worst offered combo
  // 25000 · 145 · 8 = 29 MB < 32 MB.
  for (const horizonH of [6, 12, 24, 48]) {
    const p = resolveDriftParams({ horizonH, n: 25000 });
    const frameCount = 60 * p.horizonH / p.dtMin + 1;
    assert.ok(p.n * frameCount * 8 < 32 * 1024 * 1024,
      `horizon ${horizonH} h: ${p.n * frameCount * 8} bytes exceeds 32 MB`);
  }
});

test('start passes sigmaTurbMs and backward through to the ensemble runner', async () => {
  const seams = makeSeams();
  const controller = createDriftController(seams.options);
  await controller.start({ lat: 33.5, lon: -118.5, n: 8, sigmaTurbMs: 0.1, backward: true });
  assert.equal(seams.ensembleParams.sigmaTurbMs, 0.1);
  assert.equal(seams.ensembleParams.backward, true);
  controller.dispose();
});

test('rerun reuses the remembered seed with merged params and disposes the prior run', async () => {
  const seams = makeSeams();
  const collections = [];
  seams.options.collectionFactory = () => {
    const c = makeCollection();
    collections.push(c);
    return c;
  };
  const controller = createDriftController(seams.options);
  assert.equal((await controller.rerun()).ok, false, 'rerun before any start reports failure');

  await controller.start({ lat: 33.5, lon: -118.5, label: 'seed', n: 8, sigmaTurbMs: 0.1 });
  const result = await controller.rerun({ horizonH: 48, n: 4 });
  assert.equal(result.ok, true);
  assert.equal(seams.ensembleParams.seedLat, 33.5, 'seed remembered');
  assert.equal(seams.ensembleParams.seedLon, -118.5, 'seed remembered');
  assert.equal(seams.ensembleParams.horizonH, 48);
  assert.equal(seams.ensembleParams.dtMin, 20, 'dtMin re-derived for the new horizon');
  assert.equal(seams.ensembleParams.n, 4);
  assert.equal(seams.ensembleParams.sigmaTurbMs, 0.1, 'unoverridden params carry over');
  assert.equal(collections[0].destroyCalls, 1, 'prior collection destroyed exactly once');
  controller.dispose();
  assert.equal(collections[1].destroyCalls, 1);
});

test('the panel factory receives control-facing params and a working onRerun', async () => {
  const seams = makeSeams();
  const controller = createDriftController(seams.options);
  await controller.start({ lat: 33.5, lon: -118.5, n: 8 });
  assert.deepEqual(seams.panelOptions.params, {
    horizonH: DRIFT_DEFAULTS.horizonH,
    n: 8,
    sigmaTurbMs: DRIFT_DEFAULTS.sigmaTurbMs,
    posSigmaM: DRIFT_DEFAULTS.posSigmaM,
    backward: false,
  });
  assert.equal(typeof seams.panelOptions.onRerun, 'function');

  const runsBefore = seams.ensembleRuns;
  const result = await seams.panelOptions.onRerun({ horizonH: 12, n: 4, sigmaTurbMs: 0, backward: true });
  assert.equal(result.ok, true);
  assert.equal(seams.ensembleRuns, runsBefore + 1, 'onRerun triggers a second ensemble run');
  assert.equal(seams.ensembleParams.horizonH, 12);
  assert.equal(seams.ensembleParams.n, 4);
  assert.equal(seams.ensembleParams.sigmaTurbMs, 0);
  assert.equal(seams.ensembleParams.backward, true);
  controller.dispose();
});

test('setSummary receives a km summary when the result carries mean drift and spread', async () => {
  const seams = makeSeams();
  const base = seams.options.runEnsembleFn;
  seams.options.runEnsembleFn = async (params) => ({
    ...(await base(params)),
    meanEndLat: 33.5,
    // ≈ 10 km due east of the seed at 33.5°N → initial bearing ≈ 90°.
    meanEndLon: -118.392,
    spreadKm: 3.2,
  });
  const controller = createDriftController(seams.options);
  await controller.start({ lat: 33.5, lon: -118.5, n: 4 });
  const summary = seams.panel.summaries.at(-1);
  assert.equal(typeof summary, 'string');
  assert.match(summary, /km/);
  assert.match(summary, /@ 90°/);
  assert.match(summary, /± 3\.2 km/);
  controller.dispose();
});

test('setSummary receives null when the stub result carries no mean-drift fields', async () => {
  const seams = makeSeams();
  const controller = createDriftController(seams.options);
  await controller.start({ lat: 33.5, lon: -118.5, n: 4 });
  assert.equal(seams.panel.summaries.at(-1), null);
  controller.dispose();
});

test('a backward run labels the banner REVERSE and reports negative clock offsets', async () => {
  const seams = makeSeams();
  const controller = createDriftController(seams.options);
  await controller.start({ lat: 33.5, lon: -118.5, n: 4, backward: true });

  const banner = seams.overlayCalls.find(([kind, sourceId]) => kind === 'entries' && sourceId === DRIFT_OVERLAY_SOURCE_ID);
  assert.ok(banner, 'banner published');
  assert.match(banner[2][0].title, /SIMULATED DRIFT ENSEMBLE/);
  assert.ok(banner[2][0].details.some((line) => /REVERSE/.test(line)), 'details flag the reverse run');

  controller.setFrame(1);
  const [index, offsetMs] = seams.panel.frameArgs.at(-1);
  assert.equal(index, 1);
  assert.ok(offsetMs < 0, 'backward frames report negative offsets so the panel renders T−hh:mm');
  controller.dispose();
});

test('createDriftPanel headless stub keeps the full no-op shape including setSummary', () => {
  const stub = createDriftPanel({
    params: { horizonH: 24, n: 10000, sigmaTurbMs: 0.05, backward: false },
    onRerun: () => {},
  });
  for (const key of ['setFrame', 'setPlaying', 'setSummary', 'destroy']) {
    assert.equal(typeof stub[key], 'function', `stub exposes ${key}`);
  }
});

// ── Overlapping starts must not leak a run (the A3 defect) ──────────────────
// start() calls dispose() at entry, which is a no-op while _active is still
// null, then awaits 0.9–3.9 s of I/O and compute before it assigns _active.
// Two starts issued inside that window both built a collection and a panel, and
// only the second was ever reachable by dispose() — the first leaked its GPU
// collection and DOM panel for the session, and its orphaned panel's callbacks
// closed over the controller and drove the surviving run.
//
// The existing "a second start disposes the first" test AWAITS the first start,
// so it exercises the sequential path and structurally cannot see this.

test('two overlapping starts leave exactly one collection and one panel alive', async () => {
  const seams = makeSeams();
  const collections = [];
  const panels = [];
  let release;
  const gate = new Promise((resolve) => { release = resolve; });

  seams.options.collectionFactory = () => {
    const collection = makeCollection();
    collections.push(collection);
    return collection;
  };
  seams.options.panelFactory = () => {
    const panel = { destroyed: false, setFrame: () => {}, setPlaying: () => {}, setSummary: () => {},
      destroy() { this.destroyed = true; } };
    panels.push(panel);
    return panel;
  };
  const runEnsembleFn = seams.options.runEnsembleFn;
  seams.options.runEnsembleFn = async (params) => {
    await gate; // both starts are now past their fetches and inside the model
    return runEnsembleFn(params);
  };

  const controller = createDriftController(seams.options);
  const first = controller.start({ lat: 33.5, lon: -118.5, n: 4 });
  const second = controller.start({ lat: 34.0, lon: -119.0, n: 4 });
  release();
  const [firstResult, secondResult] = await Promise.all([first, second]);

  // The superseded run must bail rather than take ownership of the scene.
  assert.equal(firstResult.ok, false);
  assert.equal(firstResult.reason, 'superseded');
  assert.equal(secondResult.ok, true);

  // Exactly one of each was ever built, and the scene holds exactly one.
  assert.equal(collections.length, 1, 'superseded run must not build a collection');
  assert.equal(panels.length, 1, 'superseded run must not build a panel');
  assert.equal(seams.options.viewer.scene.primitives.added.length, 1);

  // And the survivor is fully disposable — nothing is orphaned.
  controller.dispose();
  assert.equal(collections[0].destroyed, true);
  assert.equal(panels[0].destroyed, true);
});

test('a superseded start never publishes its banner over the winning run', async () => {
  const seams = makeSeams();
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const runEnsembleFn = seams.options.runEnsembleFn;
  let calls = 0;
  seams.options.runEnsembleFn = async (params) => {
    if (calls++ === 0) await gate;
    return runEnsembleFn(params);
  };
  const controller = createDriftController(seams.options);
  const first = controller.start({ lat: 33.5, lon: -118.5, n: 4 });
  const second = controller.start({ lat: 34.0, lon: -119.0, n: 4 });
  release();
  await Promise.all([first, second]);

  const banners = seams.overlayCalls.filter(
    ([kind, sourceId]) => kind === 'entries' && sourceId === DRIFT_OVERLAY_SOURCE_ID,
  );
  assert.equal(banners.length, 1, 'only the winning run may publish a banner');
  controller.dispose();
});

// ── Last-known-position uncertainty is a physical parameter, not a knob ─────

test('posSigmaM defaults to the estimated band and reaches the model', async () => {
  const seams = makeSeams();
  let seen = null;
  const inner = seams.options.runEnsembleFn;
  seams.options.runEnsembleFn = (params) => { seen = params; return inner(params); };
  const controller = createDriftController(seams.options);
  await controller.start({ lat: 33.5, lon: -118.5, n: 8 });
  assert.equal(seen.posSigmaM, DRIFT_DEFAULTS.posSigmaM);
  assert.equal(DRIFT_DEFAULTS.posSigmaM, 1000, 'default is the estimated-position band');
  controller.dispose();
});

test('an explicit posSigmaM overrides the default and survives a rerun', async () => {
  const seams = makeSeams();
  const seen = [];
  const inner = seams.options.runEnsembleFn;
  seams.options.runEnsembleFn = (params) => { seen.push(params.posSigmaM); return inner(params); };
  const controller = createDriftController(seams.options);
  await controller.start({ lat: 33.5, lon: -118.5, n: 8, posSigmaM: 5000 });
  assert.equal(seen[0], 5000);
  // rerun() replays the REMEMBERED params, so the choice must persist.
  await controller.rerun({ horizonH: 12 });
  assert.equal(seen[1], 5000, 'a rerun must not silently revert to the default');
  controller.dispose();
});

test('resolveDriftParams clamps posSigmaM to a physically meaningful range', () => {
  assert.equal(resolveDriftParams({ posSigmaM: -5 }).posSigmaM, 0);
  assert.equal(resolveDriftParams({ posSigmaM: 1e9 }).posSigmaM, 20000,
    'a scatter wider than the forcing grid puts particles where the sampler clamps');
  assert.equal(resolveDriftParams({ posSigmaM: Number.NaN }).posSigmaM, 0);
  assert.equal(resolveDriftParams({ posSigmaM: 1000 }).posSigmaM, 1000);
});

test('the offered uncertainty bands span the real range and are ordered', () => {
  const bands = DRIFT_POSITION_UNCERTAINTY;
  assert.ok(bands.length >= 3);
  for (let i = 1; i < bands.length; i += 1) {
    assert.ok(bands[i].posSigmaM > bands[i - 1].posSigmaM, 'bands must ascend');
  }
  // Every band must be reachable through the clamp, or the control lies.
  for (const band of bands) {
    assert.equal(resolveDriftParams({ posSigmaM: band.posSigmaM }).posSigmaM, band.posSigmaM, band.id);
    assert.match(band.label, /\d/, 'the label must state the actual distance');
  }
  assert.ok(bands.some((b) => b.posSigmaM === DRIFT_DEFAULTS.posSigmaM),
    'the default must correspond to an offered band');
});

test('the panel offers exactly the controller’s uncertainty bands', async () => {
  // POSITION_CHOICES is declared inside driftPanel to avoid a cycle (the
  // controller imports the panel). This pins that the duplicate cannot drift:
  // a band offered in the UI that the physics clamps away, or a band the
  // physics supports that the UI hides, would both be silent.
  const { POSITION_CHOICES } = await import('./driftPanel.js');
  assert.deepEqual(
    POSITION_CHOICES.map((b) => b.posSigmaM),
    DRIFT_POSITION_UNCERTAINTY.map((b) => b.posSigmaM),
    'panel choices and controller bands must be the same values, in the same order',
  );
  assert.deepEqual(
    POSITION_CHOICES.map((b) => b.label),
    DRIFT_POSITION_UNCERTAINTY.map((b) => b.label),
    'labels must agree too — the panel is what the user reads',
  );
});
