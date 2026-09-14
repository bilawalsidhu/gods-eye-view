import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_SPEED_SCALE } from './oceanFieldMath.js';
// Imported so the contract test checks the method name against the REAL reader
// rather than a hand-written list that can drift from it.
import { DataLayerManager } from './manager.js';

import {
  createRasterSampler,
  viewBoxDelta,
  fieldLegendText,
  createOceanFieldLayer,
  SCREEN_GRID_STEP_PX,
  solveSecondsPerFrame,
  TARGET_PX_PER_FRAME,
  buildLegendHtml,
  speedScaleFor,
} from './oceanField.js';

/* ------------------------------------------------------------------ *
 * Screen-space velocity raster
 * ------------------------------------------------------------------ */

/** A cols x rows raster whose per-node values come from a callback. */
function raster(cols, rows, at, step = SCREEN_GRID_STEP_PX) {
  const n = cols * rows;
  const vx = new Float32Array(n);
  const vy = new Float32Array(n);
  const speed = new Float32Array(n);
  const ok = new Uint8Array(n);
  for (let j = 0; j < rows; j += 1) {
    for (let i = 0; i < cols; i += 1) {
      const cell = at(i, j);
      const k = j * cols + i;
      if (!cell) continue;
      vx[k] = cell.vx;
      vy[k] = cell.vy;
      speed[k] = cell.speed ?? Math.hypot(cell.vx, cell.vy);
      ok[k] = 1;
    }
  }
  return { cols, rows, step, vx, vy, speed, ok };
}

test('createRasterSampler bilinearly interpolates a linear ramp exactly', () => {
  // vx = i, so along the top row a query at x = 1.5 nodes must read 1.5.
  const sampler = createRasterSampler(raster(4, 4, (i) => ({ vx: i, vy: 0, speed: i })));
  const step = SCREEN_GRID_STEP_PX;
  assert.equal(sampler(0, 0).vx, 0);
  assert.equal(sampler(step, 0).vx, 1);
  assert.ok(Math.abs(sampler(1.5 * step, 0).vx - 1.5) < 1e-6);
  // And in the other axis: vy = j.
  const s2 = createRasterSampler(raster(4, 4, (i, j) => ({ vx: 0, vy: j })));
  assert.ok(Math.abs(s2(0, 2.25 * step).vy - 2.25) < 1e-6);
});

test('createRasterSampler refuses any cell touching a no-data node', () => {
  // Hole at node (1,1). Every cell with that corner must be refused, so a
  // particle straddling the edge of coverage is retired, not advected on a
  // half-invented velocity.
  const sampler = createRasterSampler(
    raster(4, 4, (i, j) => ((i === 1 && j === 1) ? null : { vx: 1, vy: 1 })),
  );
  const step = SCREEN_GRID_STEP_PX;
  for (const [i, j] of [[0, 0], [1, 0], [0, 1], [1, 1]]) {
    assert.equal(sampler((i + 0.5) * step, (j + 0.5) * step).ok, false,
      `cell (${i},${j}) touches the hole and must be refused`);
  }
  // A cell clear of the hole still resolves.
  assert.equal(sampler(2.5 * step, 2.5 * step).ok, true);
});

test('createRasterSampler refuses queries outside the raster', () => {
  const sampler = createRasterSampler(raster(4, 4, () => ({ vx: 1, vy: 1 })));
  const step = SCREEN_GRID_STEP_PX;
  assert.equal(sampler(-1, 0).ok, false);
  assert.equal(sampler(0, -1).ok, false);
  // The last node row/column starts no cell, so it is out of range too.
  assert.equal(sampler(3 * step, 0).ok, false);
  assert.equal(sampler(Number.NaN, 0).ok, false);
});

test('createRasterSampler is allocation-free across calls', () => {
  const sampler = createRasterSampler(raster(4, 4, () => ({ vx: 1, vy: 2 })));
  const a = sampler(SCREEN_GRID_STEP_PX, SCREEN_GRID_STEP_PX);
  const b = sampler(SCREEN_GRID_STEP_PX, SCREEN_GRID_STEP_PX);
  assert.equal(a, b, 'the sampler must reuse one result object');
});

/* ------------------------------------------------------------------ *
 * Refetch policy
 * ------------------------------------------------------------------ */

test('viewBoxDelta is 0 for an unchanged view and grows with pan and zoom', () => {
  const box = { latMin: 36, latMax: 37, lonMin: -123, lonMax: -122 };
  assert.equal(viewBoxDelta(box, box), 0);
  // Half a box-width pan east.
  const panned = { latMin: 36, latMax: 37, lonMin: -122.5, lonMax: -121.5 };
  assert.ok(Math.abs(viewBoxDelta(box, panned) - 0.5) < 1e-9);
  // Doubling the span.
  const zoomed = { latMin: 35.5, latMax: 37.5, lonMin: -123.5, lonMax: -121.5 };
  assert.ok(Math.abs(viewBoxDelta(box, zoomed) - 1) < 1e-9);
});

test('viewBoxDelta refuses to compare against a missing or degenerate box', () => {
  const box = { latMin: 36, latMax: 37, lonMin: -123, lonMax: -122 };
  assert.equal(viewBoxDelta(null, box), Number.POSITIVE_INFINITY);
  assert.equal(viewBoxDelta(box, null), Number.POSITIVE_INFINITY);
  // A zero-height previous box would divide by zero; a refetch is the safe answer.
  assert.equal(viewBoxDelta({ latMin: 36, latMax: 36, lonMin: -123, lonMax: -122 }, box),
    Number.POSITIVE_INFINITY);
});

/* ------------------------------------------------------------------ *
 * Legend wording — the honesty surface
 * ------------------------------------------------------------------ */

test('the legend labels an HF-radar field OBSERVED and reports its holdout error', () => {
  const { lines } = fieldLegendText({
    status: 'ok',
    provenance: {
      tier: 'hfr',
      kind: 'observed',
      tierLabel: 'IOOS HF radar 2 km totals',
      ageLabel: '1 h old',
      resolutionKm: 2,
      coverage: 0.93,
      rmseMs: 0.069,
      holdoutCount: 75,
      caveats: [],
    },
  });
  const text = lines.join('\n');
  assert.match(text, /OBSERVED/);
  assert.match(text, /2 km/);
  assert.match(text, /1 h old/);
  assert.match(text, /Holdout RMSE 0\.069 m\/s over 75 withheld vectors/);
  assert.match(text, /93% of the water in view/);
});

test('the legend labels a blended global field MODELED, never OBSERVED', () => {
  const { lines, caveats } = fieldLegendText({
    status: 'ok',
    provenance: {
      tier: 'global',
      kind: 'derived',
      tierLabel: 'NOAA blended global surface currents',
      ageLabel: '2 days old',
      resolutionKm: 27.74,
      coverage: 0.95,
      caveats: ['Published with a multi-day lag: this analysis is 2 days old.'],
    },
  });
  const text = lines.join('\n');
  assert.match(text, /MODELED/);
  assert.doesNotMatch(text, /OBSERVED/,
    'a derived model field must never be labelled as an observation');
  assert.match(text, /2 days old/);
  assert.equal(caveats.length, 1);
});

test('a composite field names every source and its share', () => {
  const { lines } = fieldLegendText({
    status: 'ok',
    provenance: {
      tier: 'composite',
      kind: 'mixed',
      coverage: 0.98,
      sources: [
        { tier: 'hfr', kind: 'observed', label: 'IOOS HF radar 2 km', ageLabel: '1 h old', resolutionKm: 2, cellShare: 0.68 },
        { tier: 'global', kind: 'derived', label: 'NOAA blended global', ageLabel: '2 days old', resolutionKm: 27.74, cellShare: 0.32 },
      ],
      caveats: [],
    },
  });
  const text = lines.join('\n');
  assert.match(text, /68% · 2 km · OBSERVED · 1 h old/);
  assert.match(text, /32% · 27\.74 km · MODELED · 2 days old/);
});

test('the legend says why there is nothing rather than showing a calm ocean', () => {
  const unavailable = fieldLegendText({ status: 'unavailable', reason: 'no HF radar and no global coverage here' });
  assert.match(unavailable.lines.join(' '), /Unavailable — no HF radar and no global coverage here/);
  const missing = fieldLegendText(null);
  assert.match(missing.lines.join(' '), /No current field for this view/);
  assert.equal(missing.title, 'OCEAN CURRENTS');
});

/* ------------------------------------------------------------------ *
 * Layer contract
 * ------------------------------------------------------------------ */

test('the layer exposes the DataLayerManager contract with the registered id', () => {
  const layer = createOceanFieldLayer();
  assert.equal(layer.id, 'ocean-field');
  for (const method of ['init', 'enable', 'disable', 'update', 'getStats']) {
    assert.equal(typeof layer[method], 'function', `missing ${method}()`);
  }
  assert.equal(layer.getStats().count, 0);
});

test('the manager itself can read this layer\'s stats — the method name is checked against the real reader', () => {
  // A hand-written method list is not a contract check: this test used to
  // assert `getStatus`, the one name DataLayerManager never calls, so it
  // certified the broken wiring instead of catching it. `_moduleStats`
  // early-returns a {count: 0, lastUpdate: null} stub for any layer without
  // `getStats`, which is indistinguishable from a layer that has simply not
  // loaded yet — so the panel row read blank forever, errors included.
  const layer = createOceanFieldLayer();
  const reader = DataLayerManager.prototype._moduleStats;
  assert.equal(typeof reader, 'function', 'DataLayerManager._moduleStats is the stats reader');

  const stats = reader.call(
    { }, // `_moduleStats` touches nothing on `this`.
    { initialized: true, module: layer },
  );
  assert.notDeepStrictEqual(
    stats,
    { count: 0, lastUpdate: null },
    'the manager fell back to its zero stub — the layer is missing the method it reads',
  );
  assert.equal(stats.count, 0, 'no payload yet, but the layer answered rather than being stubbed');
  assert.equal(stats.lastUpdate, null);
  assert.ok('error' in stats, 'the manager receives the layer\'s own error slot');
});

test('refresh stores an ok payload and reports its tier through getStats', async () => {
  const payload = {
    status: 'ok',
    generatedAtMs: 1756700000000,
    grid: { lat0: 36, lon0: -123, dLat: 0.5, dLon: 0.5, nLat: 2, nLon: 2 },
    u: [0.1, 0.2, 0.3, 0.4],
    v: [0, 0, 0, 0],
    provenance: { tier: 'hfr', kind: 'observed', ageLabel: '1 h old', coverage: 1, caveats: [] },
  };
  const layer = createOceanFieldLayer({
    fetchImpl: async () => ({ ok: true, json: async () => payload }),
    particleCount: 8,
  });
  layer.init(fakeViewer());
  layer.enable(fakeViewer());
  const ok = await layer._refreshForTest();
  assert.equal(ok, true);
  assert.equal(layer.getStats().tier, 'hfr');
  assert.equal(layer.getStats().count, 4);
  assert.equal(layer.getStats().error, null);
  layer.disable();
});

test('an unavailable payload clears the sampler instead of drawing stale water', async () => {
  const layer = createOceanFieldLayer({
    fetchImpl: async () => ({ ok: true, json: async () => ({ status: 'unavailable', reason: 'out of coverage' }) }),
    particleCount: 8,
  });
  layer.init(fakeViewer());
  layer.enable(fakeViewer());
  assert.equal(await layer._refreshForTest(), false);
  const state = layer._stateForTest();
  assert.equal(state.stats, null);
  assert.equal(state.error, 'out of coverage');
  layer.disable();
});

test('an HTTP failure is reported without replacing the last good field', async () => {
  let response = { ok: true, json: async () => goodPayload() };
  const layer = createOceanFieldLayer({
    fetchImpl: async () => response,
    particleCount: 8,
  });
  layer.init(fakeViewer());
  layer.enable(fakeViewer());
  await layer._refreshForTest();
  assert.equal(layer._stateForTest().payload.status, 'ok');

  response = { ok: false, status: 503 };
  assert.equal(await layer._refreshForTest(), false);
  const state = layer._stateForTest();
  assert.match(state.error, /503/);
  assert.equal(state.payload.status, 'ok', 'the previous good field must survive a failed refresh');
  layer.disable();
});

function goodPayload() {
  return {
    status: 'ok',
    generatedAtMs: 1756700000000,
    grid: { lat0: 36, lon0: -123, dLat: 0.5, dLon: 0.5, nLat: 2, nLon: 2 },
    u: [0.1, 0.2, 0.3, 0.4],
    v: [0, 0, 0, 0],
    provenance: { tier: 'global', kind: 'derived', ageLabel: '2 days old', coverage: 1, caveats: [] },
  };
}

/**
 * A viewer stub exposing only what the layer touches outside the browser:
 * a camera with a computable view rectangle and no-op event hooks.
 */
function fakeViewer() {
  const listeners = { addEventListener() {}, removeEventListener() {} };
  return {
    camera: {
      changed: listeners,
      moveEnd: listeners,
      computeViewRectangle: () => ({
        south: 36 * Math.PI / 180,
        north: 37 * Math.PI / 180,
        west: -123 * Math.PI / 180,
        east: -122 * Math.PI / 180,
      }),
    },
    scene: { canvas: { clientWidth: 0, clientHeight: 0 }, globe: { ellipsoid: {} } },
  };
}

/* ------------------------------------------------------------------ *
 * Adaptive time compression
 * ------------------------------------------------------------------ */

test('solveSecondsPerFrame puts a median current at the target screen rate', () => {
  // Tolerances are RELATIVE because the raster stores Float32: 0.002 is not
  // exactly representable, so an absolute 1e-9 bound would test the float
  // format rather than the solver. 1e-6 relative is ~10x the Float32 epsilon.
  const near = (actual, expected) => Math.abs(actual - expected) / expected < 1e-6;

  // 2.4e-3 px/s: a 0.15 m/s current over a 100 km-wide view at 1600 px.
  const bay = raster(4, 4, () => ({ vx: 2.4e-3, vy: 0 }));
  const bayScale = solveSecondsPerFrame(bay);
  assert.ok(near(bay.vx[0] * bayScale, TARGET_PX_PER_FRAME),
    `bay view: ${bay.vx[0] * bayScale} px/frame`);

  // 6e-6 px/s: the SAME 0.15 m/s current over the whole Earth at 1600 px —
  // 400x slower on screen. It must still read at the same rate; that is the
  // entire reason the compression is solved rather than fixed.
  const globe = raster(4, 4, () => ({ vx: 6e-6, vy: 0 }));
  const globeScale = solveSecondsPerFrame(globe);
  assert.ok(near(globe.vx[0] * globeScale, TARGET_PX_PER_FRAME),
    `global view: ${globe.vx[0] * globeScale} px/frame`);
  assert.ok(globeScale > bayScale * 100, 'a wider view needs far more compression');
});

test('solveSecondsPerFrame uses the median so a fast jet cannot freeze the rest', () => {
  // 15 slow nodes and one 800x faster. A MEAN would be dragged ~50x high and
  // the slow field would stop moving; the median must ignore the outlier.
  let n = 0;
  const withJet = raster(4, 4, () => {
    n += 1;
    return { vx: n === 1 ? 2 : 2.4e-3, vy: 0 };
  });
  const scale = solveSecondsPerFrame(withJet);
  assert.ok(Math.abs(withJet.vx[1] * scale - TARGET_PX_PER_FRAME) / TARGET_PX_PER_FRAME < 1e-6);
});

test('solveSecondsPerFrame ignores empty ocean and survives an all-empty raster', () => {
  // No-data nodes must not count as zero-speed water and drag the median down.
  let n = 0;
  const sparse = raster(4, 4, () => {
    n += 1;
    return n % 3 === 0 ? { vx: 2.4e-3, vy: 0 } : null;
  });
  const scale = solveSecondsPerFrame(sparse);
  assert.ok(Math.abs(sparse.vx[2] * scale - TARGET_PX_PER_FRAME) / TARGET_PX_PER_FRAME < 1e-6);

  const empty = raster(4, 4, () => null);
  const spf = solveSecondsPerFrame(empty);
  assert.ok(Number.isFinite(spf) && spf > 0, 'must not return NaN or 0 for an empty raster');
});

/* ------------------------------------------------------------------ *
 * Legend markup — previously executed by nothing
 * ------------------------------------------------------------------ *
 * renderLegend() built this inline, where no test could reach it: the headless
 * harness has no `document`, so ensureCanvas() returns early and `_legend`
 * stays null. It shipped every swatch as `background:undefined`, because
 * speedLegendStops returns {t, speedMs, r, g, b} and the code read `.css`.
 */

function okPayload(provenance = {}) {
  return {
    status: 'ok',
    grid: { lat0: 36, lon0: -123, dLat: 0.5, dLon: 0.5, nLat: 2, nLon: 2 },
    u: [0.1, 0.2, 0.3, 0.4],
    v: [0, 0, 0, 0],
    provenance: {
      tier: 'hfr', kind: 'observed', tierLabel: 'IOOS HF radar 2 km totals',
      ageLabel: '1 h old', resolutionKm: 2, coverage: 0.93, caveats: [], ...provenance,
    },
  };
}

test('every legend swatch carries a real rgb() background', () => {
  const html = buildLegendHtml(okPayload(), 1.4);
  const backgrounds = [...html.matchAll(/background:([^";]+)/g)].map((m) => m[1]);
  assert.equal(backgrounds.length, 5, 'five ramp stops');
  assert.ok(!html.includes('undefined'), 'no undefined anywhere in the legend markup');
  for (const bg of backgrounds) {
    assert.match(bg, /^rgb\(\d{1,3}, \d{1,3}, \d{1,3}\)$/, `swatch background must be a colour, got "${bg}"`);
  }
  // And the swatches must not all be the same colour — that would mean the
  // ramp collapsed and the key conveys nothing.
  assert.ok(new Set(backgrounds).size >= 4, 'the ramp must actually vary across stops');
});

test('the legend escapes upstream-authored text', () => {
  const html = buildLegendHtml(okPayload({ tierLabel: 'evil <script>alert(1)</script>' }), 1.4);
  assert.ok(!html.includes('<script>'), 'a dataset title is not this app to trust');
  assert.ok(html.includes('&lt;script&gt;'));
});

test('an unavailable payload renders the reason and no colour ramp', () => {
  const html = buildLegendHtml({ status: 'unavailable', reason: 'out of coverage' }, 1.4);
  assert.match(html, /Unavailable — out of coverage/);
  assert.equal([...html.matchAll(/background:/g)].length, 0,
    'no ramp key when there is no field to key');
});

test('speedScaleFor uses p95 with a floor, and falls back when stats are absent', () => {
  assert.ok(Math.abs(speedScaleFor({ p95Ms: 0.8 }) - 1.0) < 1e-12);   // 0.8 * 1.25
  assert.equal(speedScaleFor({ p95Ms: 0.01 }), 0.2, 'floor keeps a slack field from amplifying noise');
  assert.equal(speedScaleFor(null), DEFAULT_SPEED_SCALE);
  assert.equal(speedScaleFor({ p95Ms: null }), DEFAULT_SPEED_SCALE);
});

/* ------------------------------------------------------------------ *
 * Lifecycle — the same bug classes this PR fixes in driftController
 * ------------------------------------------------------------------ */

/** A viewer whose camera events count their listeners. */
function countingViewer() {
  const counts = { changed: 0, moveEnd: 0 };
  const ev = (key) => ({
    addEventListener() { counts[key] += 1; },
    removeEventListener() { counts[key] -= 1; },
  });
  return {
    counts,
    camera: {
      changed: ev('changed'),
      moveEnd: ev('moveEnd'),
      computeViewRectangle: () => ({
        south: 36 * Math.PI / 180, north: 37 * Math.PI / 180,
        west: -123 * Math.PI / 180, east: -122 * Math.PI / 180,
      }),
    },
    scene: { canvas: { clientWidth: 0, clientHeight: 0 }, globe: { ellipsoid: {} } },
  };
}

test('enable() is idempotent: a second call adds no camera listeners', async () => {
  const viewer = countingViewer();
  const layer = createOceanFieldLayer({
    fetchImpl: async () => ({ ok: true, json: async () => goodPayload() }),
    particleCount: 8,
  });
  layer.init(viewer);
  layer.enable(viewer);
  assert.deepEqual(viewer.counts, { changed: 1, moveEnd: 1 });
  layer.enable(viewer);
  layer.enable(viewer);
  assert.deepEqual(viewer.counts, { changed: 1, moveEnd: 1 }, 'listeners must not accumulate');
  layer.disable();
  assert.deepEqual(viewer.counts, { changed: 0, moveEnd: 0 }, 'disable must remove exactly what enable added');
});

test('a superseded request does not overwrite a newer success with its failure', async () => {
  // The slow first request fails AFTER the fast second one has already
  // succeeded. Reporting its error would leave the layer showing a fault it had
  // recovered from — the driftController run-token bug, in the field layer.
  let call = 0;
  let releaseFirst;
  const firstGate = new Promise((resolve) => { releaseFirst = resolve; });
  const layer = createOceanFieldLayer({
    fetchImpl: async () => {
      call += 1;
      if (call === 1) { await firstGate; return { ok: false, status: 503 }; }
      return { ok: true, json: async () => goodPayload() };
    },
    particleCount: 8,
  });
  layer.init(fakeViewer());
  layer.enable(fakeViewer());

  const slow = layer._refreshForTest();
  const fast = layer._refreshForTest();
  assert.equal(await fast, true);
  releaseFirst();
  assert.equal(await slow, false);

  const state = layer._stateForTest();
  assert.equal(state.error, null, 'the stale 503 must not surface over the newer good field');
  assert.equal(state.payload.status, 'ok');
  layer.disable();
});

test('a malformed payload is refused instead of being reported as loaded', async () => {
  // createFieldSampler throws on a grid it cannot read. That used to happen
  // outside any try, rejecting refresh()'s promise unhandled.
  const layer = createOceanFieldLayer({
    fetchImpl: async () => ({
      ok: true,
      json: async () => ({ status: 'ok', grid: { nLat: 'not a number' }, u: [], v: [], provenance: {} }),
    }),
    particleCount: 8,
  });
  layer.init(fakeViewer());
  layer.enable(fakeViewer());
  assert.equal(await layer._refreshForTest(), false, 'must not reject, and must not claim success');
  const state = layer._stateForTest();
  assert.match(state.error, /payload unusable/);
  assert.equal(state.stats, null);
  assert.equal(state.payload, null, 'a payload we could not derive from must not be stored');
  layer.disable();
});
