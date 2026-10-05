#!/usr/bin/env node
/**
 * qa-infra-lod — browser checks for the local-infrastructure LOD declutter.
 *
 * Datacenters and dams use a bounded active-stem set. Cables are loaded for
 * a representative combined view but use their own unchanged renderer.
 *
 * Two jobs:
 *  1. GATE — with datacenters + dams enabled:
 *       a. at a full-earth camera, each layer's getLodDiagnostics() reports
 *          computed===true, active<=budgetLimit, budgetLimit===INFRA_LOD_ACTIVE_MIN,
 *          and active<total (the declutter is actually engaged);
 *       b. flying to a city lifts budgetLimit to INFRA_LOD_ACTIVE_MAX and the
 *          active count grows (or pins to the in-view count);
 *       c. the selection does not churn between camera moves.
 *  2. MEASURE — actual postRender frame intervals over a ~10 s driven orbit at
 *     global zoom; --control disables infra. This is not a before/after test.
 *     Report the renderer; software-GL timings are relative-only evidence.
 *
 * Visual proof saved to qa-shots/ (gitignored).
 *
 * Usage: node scripts/qa-infra-lod.mjs [--url http://localhost:5180] [--control] [--headful]
 * Requires a running dev server with the bundled local_data present. Headless;
 * rAF throttling disabled so the frame clock is honest. Exits non-zero on any
 * FAIL. Commits nothing.
 */
import puppeteer from 'puppeteer';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  INFRA_LOD_ACTIVE_MIN,
  INFRA_LOD_ACTIVE_MAX,
} from '../src/data/localGeojsonLod.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..');
const SHOTS_DIR = process.env.QA_SHOTS_DIR || path.join(REPO_ROOT, 'qa-shots');

const argv = process.argv.slice(2);
const getOpt = (name, dflt) => {
  const i = argv.indexOf(name);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : dflt;
};
const APP_URL = getOpt('--url', 'http://localhost:5180');
const CONTROL = argv.includes('--control');
const HEADFUL = argv.includes('--headful');

const INFRA_LAYER_IDS = ['local-datacenters', 'local-dams'];
const CABLE_LAYER_ID = 'telegeography-submarine-cables';

const results = [];
function check(name, pass, detail) {
  results.push({ name, pass });
  const tag = pass ? 'PASS' : 'FAIL';
  console.log(`  [${tag}] ${name}${detail !== undefined ? ` — ${JSON.stringify(detail)}` : ''}`);
}
function report(name, detail) {
  console.log(`  [MEAS] ${name} — ${JSON.stringify(detail)}`);
}

const browser = await puppeteer.launch({
  headless: HEADFUL ? false : 'new',
  executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || undefined,
  protocolTimeout: 300_000,
  args: [
    '--no-sandbox',
    '--disable-setuid-sandbox',
    '--window-size=1440,900',
    '--disable-backgrounding-occluded-windows',
    '--disable-renderer-backgrounding',
    '--disable-background-timer-throttling',
  ],
});

try {
  const page = await browser.newPage();
  const pageErrors = [];
  page.on('pageerror', (error) => pageErrors.push(String(error.message).replace(/https?:\/\/\S+/g, '[URL]')));
  await page.setViewport({ width: 1440, height: 860 });
  const testUrl = new URL(APP_URL);
  testUrl.searchParams.set('welcome', '0');
  await page.goto(testUrl.href, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => window.__godsEyeView?.styleManager
    && document.getElementById('loading-screen')?.classList.contains('hidden'), { timeout: 90_000 });
  check('first-run chooser does not cover the test surface', await page.evaluate(() => (
    !document.querySelector('#first-run-launcher:not([hidden])')
  )));
  report('renderer', await page.evaluate(() => {
    const gl = window.__godsEyeView.viewer.scene.context._gl;
    const debug = gl.getExtension('WEBGL_debug_renderer_info');
    return debug ? gl.getParameter(debug.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER);
  }));

  // Park at a full-earth view and disable every layer so infra is measured
  // in isolation.
  await page.evaluate(async () => {
    const gev = window.__godsEyeView;
    const v = gev.viewer;
    v.camera.cancelFlight();
    const ell = v.scene.globe.ellipsoid;
    v.camera.setView({
      destination: ell.cartographicToCartesian({
        longitude: 0, latitude: 15 * Math.PI / 180, height: 24_000_000,
      }),
      orientation: { heading: 0, pitch: -Math.PI / 2, roll: 0 },
    });
    for (const [id, entry] of gev.dataManager.layers) {
      if (entry.enabled) {
        try { await gev.dataManager.setEnabled(id, false, { origin: 'user' }); } catch { /* measured via counts */ }
      }
    }
  });
  await new Promise((r) => setTimeout(r, 4_000));

  // Enable the infrastructure layers (skipped in --control so the orbit cost
  // measures the empty scene for attribution).
  if (!CONTROL) {
    const loaded = await page.evaluate(async (infraIds, cableId) => {
      const gev = window.__godsEyeView;
      const ids = [...infraIds, cableId];
      for (const id of ids) {
        try { await gev.dataManager.setEnabled(id, true, { origin: 'user' }); } catch { /* reported below */ }
      }
      const deadline = performance.now() + 60_000;
      const stat = (id) => gev.dataManager.layers.get(id)?.module?.getStats?.() || {};
      while (performance.now() < deadline) {
        // Every id, cables included. The cable layer's enable() only starts
        // `void load()`, and the manager's immediate update() returns early
        // because `_loading` is already true — so waiting on datacenters and
        // dams alone releases the measurement before ~2,600 cable references
        // exist, and the advertised three-layer frame cost underreports.
        const done = ids.every((id) => {
          const s = stat(id);
          return (s.count || 0) > 0 || s.error;
        });
        if (done) break;
        gev.viewer.scene.requestRender?.();
        await new Promise((r) => setTimeout(r, 200));
      }
      const out = {};
      for (const id of ids) out[id] = stat(id);
      return out;
    }, INFRA_LAYER_IDS, CABLE_LAYER_ID);
    report('layer load stats', loaded);
    for (const id of [...INFRA_LAYER_IDS, CABLE_LAYER_ID]) {
      check(`${id} loaded its bundled dataset`, (loaded[id]?.count || 0) > 0, loaded[id]);
    }
    // Nudge a render pass so the first post-enable LOD walk runs.
    await page.evaluate(() => window.__godsEyeView?.viewer?.scene?.requestRender?.());
    await new Promise((r) => setTimeout(r, 2_000));
  }

  // ── GATE a: full-earth budget engaged ─────────────────────────────────
  const readLod = (label) => page.evaluate((infraIds) => {
    const gev = window.__godsEyeView;
    const out = {};
    for (const id of infraIds) {
      out[id] = gev.dataManager.layers.get(id)?.module?.getLodDiagnostics?.() || null;
    }
    return out;
  }, INFRA_LAYER_IDS).then((lod) => { report(label, lod); return lod; });

  if (!CONTROL) {
    const globalLod = await readLod('getLodDiagnostics @ full-earth');
    for (const id of INFRA_LAYER_IDS) {
      const d = globalLod[id];
      check(`${id}: LOD selection has run`, !!d && d.computed === true, d);
      check(`${id}: active stems within the band budget`, !!d && d.active <= d.budgetLimit, d);
      check(`${id}: full-earth band budget is INFRA_LOD_ACTIVE_MIN`,
        !!d && d.budgetLimit === INFRA_LOD_ACTIVE_MIN, { got: d?.budgetLimit, want: INFRA_LOD_ACTIVE_MIN });
      // Every bound above is satisfied by an EMPTY active set: `computed` is
      // true, `0 <= budgetLimit`, and `0 < total`. A regressed candidate build
      // or occlusion test would therefore pass the gate while both layers
      // render nothing, so assert the selection is actually populated.
      check(`${id}: active set is non-empty`, !!d && d.active > 0, d);
      // "declutter engaged" only asserts when the dataset actually exceeds the
      // cap — a tiny dataset legitimately shows every feature. This fixture is
      // a full-earth view of a global dataset an order of magnitude past the
      // global band, so the only correct outcome is a cap-filled set.
      if (d && d.total > d.budgetLimit) {
        check(`${id}: declutter is engaged (active < total)`, d.active < d.total, d);
        check(`${id}: full-earth active set fills the band budget`,
          d.active === d.budgetLimit, { active: d.active, budgetLimit: d.budgetLimit });
      }
    }

    // ── GATE b: zoom in widens the budget ───────────────────────────────
    await page.evaluate(() => {
      const v = window.__godsEyeView.viewer;
      const ell = v.scene.globe.ellipsoid;
      v.camera.cancelFlight();
      v.camera.setView({
        destination: ell.cartographicToCartesian({
          longitude: -97.74 * Math.PI / 180, latitude: 30.27 * Math.PI / 180, height: 55_000,
        }),
        orientation: { heading: 0, pitch: -Math.PI / 3, roll: 0 },
      });
      // setView does not fire moveEnd; raise the LOD recompute trigger.
      v.camera.moveEnd.raiseEvent?.();
      v.scene.requestRender?.();
    });
    await new Promise((r) => setTimeout(r, 3_000));
    const regionalLod = await readLod('getLodDiagnostics @ city');
    for (const id of INFRA_LAYER_IDS) {
      const g = globalLod[id];
      const r = regionalLod[id];
      check(`${id}: city band lifts the budget to INFRA_LOD_ACTIVE_MAX`,
        !!r && r.budgetLimit === INFRA_LOD_ACTIVE_MAX, { got: r?.budgetLimit, want: INFRA_LOD_ACTIVE_MAX });
      // `>=` alone accepts 0 >= 0, so the non-shrink check needs a floor too.
      check(`${id}: active set did not shrink when zooming in`,
        !!r && !!g && r.active > 0 && r.active >= Math.min(g.active, r.total),
        { global: g?.active, regional: r?.active });
    }

    // ── GATE c: no churn between camera moves ───────────────────────────
    const churn = await page.evaluate(async (infraIds) => {
      const gev = window.__godsEyeView;
      const snap = () => infraIds.map((id) => {
        const visibleIds = [];
        for (let i = 0; i < gev.viewer.dataSources.length; i++) {
          for (const entity of gev.viewer.dataSources.get(i).entities.values) {
            if (entity.__localLayerId === id && entity.show) visibleIds.push(String(entity.id));
          }
        }
        return visibleIds.sort();
      });
      const before = snap();
      for (let i = 0; i < 5; i++) {
        gev.viewer.scene.requestRender?.();
        await new Promise((r) => setTimeout(r, 120));
      }
      return { before, after: snap() };
    }, INFRA_LAYER_IDS);
    check('the same visible IDs remain stable without a camera move',
      churn.before.every((ids) => ids.length > 0)
        && JSON.stringify(churn.before) === JSON.stringify(churn.after),
      { beforeCounts: churn.before.map((ids) => ids.length), afterCounts: churn.after.map((ids) => ids.length) });

    // Back to full-earth for the frame-cost measurement.
    await page.evaluate(() => {
      const v = window.__godsEyeView.viewer;
      const ell = v.scene.globe.ellipsoid;
      v.camera.setView({
        destination: ell.cartographicToCartesian({
          longitude: 0, latitude: 15 * Math.PI / 180, height: 24_000_000,
        }),
        orientation: { heading: 0, pitch: -Math.PI / 2, roll: 0 },
      });
      v.camera.moveEnd.raiseEvent?.();
      v.scene.requestRender?.();
    });
    await new Promise((r) => setTimeout(r, 3_000));
  }

  // Count actual rendered frames: scene.render() can return without drawing.
  const frameCost = await page.evaluate(() => new Promise((resolve) => {
    const v = window.__godsEyeView.viewer;
    const scene = v.scene;
    const durations = [];
    let frames = 0;
    let previous;
    const remove = scene.postRender.addEventListener(() => {
      const now = performance.now();
      if (previous !== undefined) durations.push(now - previous);
      previous = now;
      frames++;
    });
    const t0 = performance.now();
    const tick = () => {
      v.camera.rotateRight(0.0004);
      scene.requestRender();
      if (performance.now() - t0 < 10_000) requestAnimationFrame(tick);
      else {
        remove();
        const elapsedMs = performance.now() - t0;
        durations.sort((a, b) => a - b);
        const n = durations.length;
        const sum = durations.reduce((s, d) => s + d, 0);
        resolve({
          frames,
          elapsedMs: +elapsedMs.toFixed(1),
          meanMs: +(sum / Math.max(1, n)).toFixed(2),
          p50Ms: +(durations[Math.floor(n * 0.5)] || 0).toFixed(2),
          p95Ms: +(durations[Math.floor(n * 0.95)] || 0).toFixed(2),
          maxMs: +(durations[n - 1] || 0).toFixed(2),
          effectiveFps: +(frames * 1000 / elapsedMs).toFixed(1),
        });
      }
    };
    requestAnimationFrame(tick);
  }));
  report(CONTROL
    ? 'rendered-frame intervals, control (infra OFF), 10s orbit'
    : 'rendered-frame intervals, infra ON, 10s orbit', frameCost);

  // ── parked-idle honesty: the LOD walk must not force continuous render ─
  await new Promise((r) => setTimeout(r, 4_000));
  const idle = await page.evaluate(async () => {
    const { getRenderGovernorDiagnostics } = await import('/src/renderGovernor.js');
    return new Promise((resolve) => {
      const scene = window.__godsEyeView.viewer.scene;
      const startedAt = Date.now();
      const tilesLoadedBefore = scene.globe.tilesLoaded;
      let renders = 0;
      let framesWithPendingTiles = 0;
      const remove = scene.postRender.addEventListener(() => {
        renders += 1;
        if (!scene.globe.tilesLoaded) framesWithPendingTiles += 1;
      });
      setTimeout(() => {
        remove();
        const governor = getRenderGovernorDiagnostics();
        resolve({ renders, tilesLoadedBefore, tilesLoadedAfter: scene.globe.tilesLoaded,
          framesWithPendingTiles, mode: governor.mode, holds: governor.holds,
          requests: governor.recentRequests.filter(request => request.at >= startedAt) });
      }, 5_000);
    });
  });
  report(CONTROL
    ? 'parked idle, control (postRender fires / 5s)'
    : 'parked idle with infra ON (postRender fires / 5s)', idle);
  if (!CONTROL) {
    check('parked idle stays near zero (≤6 / 5s)', idle.renders <= 6, idle);
  }
  check('no uncaught application errors', pageErrors.length === 0, pageErrors);

  try {
    fs.mkdirSync(SHOTS_DIR, { recursive: true });
    const shot = path.join(SHOTS_DIR, CONTROL ? 'infra-lod-control.png' : 'infra-lod.png');
    await page.screenshot({ path: shot });
    console.log(`  [SHOT] ${shot}`);
  } catch (e) {
    console.log(`  [SHOT] skipped — ${e?.message || e}`);
  }
} finally {
  await browser.close();
}

const passed = results.filter((r) => r.pass).length;
console.log(`\nqa-infra-lod: ${passed}/${results.length} passed${CONTROL ? ' (control mode — gates skipped)' : ''}`);
console.log(`RESULT: ${passed} passed, ${results.length - passed} failed, 0 skipped`);
process.exit(passed === results.length ? 0 : 1);
