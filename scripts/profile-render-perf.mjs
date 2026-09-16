#!/usr/bin/env node
/**
 * profile-render-perf.mjs — before/after instrument for the render-perf five
 * (docs/PLAN.md, issue #8). Companion to profile-runtime.mjs: where that
 * script profiles whole scenes, this one measures the FIVE specific render
 * costs the plan item names, so each fix lands with a number:
 *
 *   1. webgl     — context attributes actually in effect
 *                  (`getContextAttributes().preserveDrawingBuffer`,
 *                  `getParameter(SAMPLES)`) + drawing-buffer memory.
 *   2. backdrop  — census of every element whose computed backdrop-filter is
 *                  active over the boot viewport: count, total blurred area,
 *                  ranked surfaces. The compositor must read + blur the WebGL
 *                  canvas beneath each of these every rendered frame.
 *   3. overlay   — world-overlay backing stores once a paint lane is live
 *                  (detection enabled over flights), at the browser's real
 *                  devicePixelRatio: backing WxH and bytes for both canvases.
 *   4. compass   — cockpit compass tape churn under a continuous heading
 *                  sweep: childList mutations (innerHTML rebuilds) and style
 *                  writes on #cockpit-compass-tape, driven through the REAL
 *                  CockpitViewController.update() on a tracked flight with a
 *                  synthetic turning track. Also samples rendered tape labels
 *                  at cardinal headings as a functional equality check.
 *   5. capture   — the voice-vision capture pattern (requestRender →
 *                  postRender → drawImage → pixel sample) with the context's
 *                  CURRENT preserveDrawingBuffer value. Proves the pattern
 *                  stays black-frame-safe after the attribute flips off.
 *
 * Usage:
 *   node scripts/profile-render-perf.mjs                     # default server
 *   node scripts/profile-render-perf.mjs --url http://...    # other server
 *   node scripts/profile-render-perf.mjs --json out.json     # machine dump
 *
 * Run at devicePixelRatio 2 (the interesting case for the overlay cap):
 *   PUPPETEER_DSF=2 node scripts/profile-render-perf.mjs
 *
 * Headless caveats, stated plainly (same policy as profile-runtime.mjs):
 *   - SwiftShader numbers are for A/B comparison on ONE machine, never
 *     absolute GPU truth. Byte arithmetic (overlay, drawing buffer) and DOM
 *     op counts (backdrop, compass) ARE portable.
 *   - Sections that need live data (flights for the compass sweep) report
 *     SKIP with the reason instead of failing — a quiet feed is not a
 *     regression.
 */

import fs from 'node:fs';
import path from 'node:path';
import puppeteer from 'puppeteer';
import { webglLaunchArgs } from './lib/webglLaunchArgs.mjs';

const args = process.argv.slice(2);
function argValue(flag, fallback) {
  const i = args.indexOf(flag);
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
}
const BASE_URL = argValue('--url', process.env.QA_BASE_URL || 'http://[::1]:4173');
const JSON_OUT = argValue('--json', null);
const DSF = Number(process.env.PUPPETEER_DSF || 2);

const CHROME_EXECUTABLE_CANDIDATES = [
  process.env.PUPPETEER_EXECUTABLE_PATH,
  process.env.CHROME_PATH,
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
  '/usr/bin/chromium-browser',
].filter(Boolean);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const report = {};
const section = (name, value) => {
  report[name] = value;
  console.log(`PERF ${name.padEnd(9)} ${JSON.stringify(value)}`);
};

const browser = await puppeteer.launch({
  headless: true,
  protocolTimeout: 300_000,
  executablePath: CHROME_EXECUTABLE_CANDIDATES[0] || undefined,
  args: [
    ...webglLaunchArgs(),
    '--no-sandbox',
    `--force-device-scale-factor=${DSF}`,
  ],
});
const page = await browser.newPage();
await page.setViewport({ width: 1440, height: 900, deviceScaleFactor: DSF });
page.on('pageerror', (e) => console.log('PAGEERROR', e.message));

try {
  await page.goto(BASE_URL, { waitUntil: 'domcontentloaded', timeout: 90_000 });
  await page.waitForFunction(() => Boolean(window.__godsEyeView?.viewer), { timeout: 120_000 });
  // Let boot layers settle before the backdrop census so transient boot
  // chrome (loading status, first-run launcher if keyed) doesn't skew it.
  await sleep(8_000);

  // ── 1. webgl context attributes ────────────────────────────────────────
  section('webgl', await page.evaluate(() => {
    const canvas = document.querySelector('#cesiumContainer canvas') || document.querySelector('canvas');
    const gl = canvas.getContext('webgl2') || canvas.getContext('webgl');
    if (!gl) return { error: 'no webgl context reachable' };
    const attrs = gl.getContextAttributes();
    const w = gl.drawingBufferWidth;
    const h = gl.drawingBufferHeight;
    const samples = gl.getParameter(gl.SAMPLES);
    // gl.SAMPLES on the DEFAULT framebuffer reflects the browser's
    // `antialias` pick, not Cesium's multisample render target — the scene
    // property is what the Viewer's msaaSamples option actually controls.
    const sceneSamples = window.__godsEyeView?.viewer?.scene?.msaaSamples;
    const effectiveSamples = Number.isFinite(sceneSamples) ? sceneSamples : samples;
    return {
      preserveDrawingBuffer: Boolean(attrs.preserveDrawingBuffer),
      antialias: Boolean(attrs.antialias),
      samples: effectiveSamples,
      defaultFramebufferSamples: samples,
      drawingBuffer: [w, h],
      drawingBufferMiB: Math.round((w * h * 4) / 1048576 * 10) / 10,
      msaaBufferMiB: effectiveSamples > 1
        ? Math.round((w * h * 4 * effectiveSamples) / 1048576 * 10) / 10
        : 0,
      devicePixelRatio: window.devicePixelRatio,
    };
  }));

  // ── 2. backdrop-filter census over the boot viewport ───────────────────
  section('backdrop', await page.evaluate(() => {
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const hits = [];
    for (const el of document.querySelectorAll('*')) {
      const filter = getComputedStyle(el).backdropFilter;
      if (!filter || filter === 'none') continue;
      const rect = el.getBoundingClientRect();
      const area = Math.max(0, Math.min(rect.width, vw - rect.left)) *
        Math.max(0, Math.min(rect.height, vh - rect.top));
      if (area <= 0) continue;
      const label = el.id ? `#${el.id}` : `.${String(el.className).split(/\s+/).slice(0, 2).join('.')}`;
      hits.push({ label, filter, area: Math.round(area) });
    }
    hits.sort((a, b) => b.area - a.area);
    return {
      devicePixelRatio: window.devicePixelRatio,
      viewport: [vw, vh],
      activeSurfaces: hits.length,
      blurredMiBPerFrame: Math.round(
        hits.reduce((sum, s) => sum + s.area * window.devicePixelRatio * window.devicePixelRatio * 4, 0) / 1048576 * 10,
      ) / 10,
      surfaces: hits.slice(0, 12),
    };
  }));

  // ── 3. world-overlay backing stores (needs a live paint lane) ──────────
  const detectionState = await page.evaluate(async () => {
    const control = window.__godsEyeView.styleManager.setDetection({
      enabled: true,
      densityPct: 50,
    });
    if (!control?.ok) return { skip: `detection control failed (${control?.error || 'unknown'})` };
    return { ok: true };
  });
  if (detectionState.skip) {
    section('overlay', { skip: detectionState.skip });
  } else {
    await sleep(6_000); // detection candidate solve + first paint allocates
    section('overlay', await page.evaluate(() => {
      const read = (id) => {
        const c = document.getElementById(id);
        return c ? { w: c.width, h: c.height } : null;
      };
      const shared = read('world-overlay-canvas');
      const detection = read('world-overlay-detection-surface');
      if (!shared?.w) return { skip: 'overlay host never painted (no backing store)' };
      const bytes = (shared.w * shared.h + (detection ? detection.w * detection.h : 0)) * 4;
      return {
        devicePixelRatio: window.devicePixelRatio,
        shared, detection,
        backingMiB: Math.round(bytes / 1048576 * 10) / 10,
      };
    }));
  }

  // ── 4. compass tape churn under a heading sweep ────────────────────────
  const compass = await page.evaluate(async () => {
    const manager = window.__godsEyeView.dataManager;
    const styleManager = window.__godsEyeView.styleManager;
    const controller = styleManager.cockpitView;
    if (!controller) return { skip: 'no cockpit controller' };
    if (!manager.isEnabled('flights')) await manager.toggle('flights');
    if (!manager.isEnabled('military')) await manager.toggle('military');
    // Contacts mode fuses flights + military; both feeds must be initialized
    // before the mode transition will stick.
    for (let waited = 0; waited < 20_000; waited += 1_000) {
      const states = ['flights', 'military'].map((id) => manager.layers.get(id));
      if (states.every((s) => s?.initialized)) break;
      await new Promise((r) => setTimeout(r, 1_000));
    }
    // Cockpit entry is gated by the contacts context mode (the same gate the
    // real entry chip uses), so arm it exactly like an operator would.
    const contacts = await styleManager.setContextMode('contacts', { origin: 'user' });
    if (!contacts?.ok) return { skip: `contacts activation failed`, control: contacts };
    const flights = manager.layers.get('flights')?.module;
    // The flights poll needs a fetch round trip after enable — wait for the
    // first populated position set rather than racing it.
    let airborne = null;
    for (let waited = 0; waited < 40_000 && !airborne; waited += 2_000) {
      await new Promise((r) => setTimeout(r, 2_000));
      airborne = (flights?.getAllPositions?.(500) || []).find((c) => c.altitudeM > 1_000);
    }
    if (!airborne) return { skip: 'no tracked-candidate flight within 40 s (quiet feed)' };
    flights.trackById?.(airborne.id);
    // The layer publishes the tracked entity to the viewer on a rendered
    // frame; under the idle render governor that needs an explicit request.
    const viewer = window.__godsEyeView.viewer;
    let tracked = false;
    for (let waited = 0; waited < 12_000 && !tracked; waited += 1_000) {
      await new Promise((r) => setTimeout(r, 1_000));
      viewer.scene.requestRender?.();
      tracked = Boolean(viewer.trackedEntity?.position);
    }
    if (!tracked) return { skip: 'tracked entity never reached the viewer' };
    if (controller.enter() !== true) return { skip: 'cockpit refused entry' };

    const tape = document.getElementById('cockpit-compass-tape');
    if (!tape) return { skip: 'no compass tape element' };
    let childMutations = 0;
    let attrMutations = 0;
    const observer = new MutationObserver((records) => {
      for (const record of records) {
        if (record.type === 'childList') childMutations += record.addedNodes.length + record.removedNodes.length;
        if (record.type === 'attributes') attrMutations += 1;
      }
    });
    observer.observe(tape, { childList: true, attributes: true, attributeFilter: ['style'] });

    // Synthetic turning track: stub the info provider so update() slews the
    // cockpit heading through 720°, crossing every 30° tape division twice.
    const realInfo = controller.readAircraftInfo.bind(controller);
    let sweepHeading = 0;
    const labelsAt = {};
    controller.readAircraftInfo = () => ({
      ...realInfo(),
      track: sweepHeading,
      stale: false,
      velocityMps: 220,
    });

    // Drive synchronously (no rAF waits): under SwiftShader a rendered frame
    // costs hundreds of ms, and the measurement is DOM churn per heading
    // progress, not frame pacing. Each update() call slews the cockpit
    // heading by one full step (28 dps × a forced 100 ms frame delta).
    const STEP = 2.8;
    const drive = (degrees, captureAt) => {
      let covered = 0;
      let guard = 0;
      while (covered < degrees && guard++ < 5_000) {
        sweepHeading = (sweepHeading + STEP) % 360;
        covered += STEP;
        controller.lastCameraUpdateMs = 0; // bypass the camera cadence gate
        controller.lastHudUpdateMs = 0; // bypass the HUD/compass cadence gate
        controller.lastFrameMs = performance.now() - 100; // full slew step
        controller.update(); // wrapped with error counting below
        if (captureAt?.includes(Math.round(sweepHeading))) {
          labelsAt[Math.round(sweepHeading)] = Array.from(tape.querySelectorAll('span'))
            .map((s) => s.textContent).join('|');
        }
      }
    };

    const updateErrors = { count: 0 };
    const realUpdate = controller.update.bind(controller);
    controller.update = () => {
      try { realUpdate(); } catch { updateErrors.count += 1; }
    };
    drive(360, [8, 92, 182, 272]);
    drive(360, null);
    // The sweep above is synchronous, so the MutationObserver callbacks have
    // not delivered yet — yield once so the record queue flushes BEFORE
    // disconnect() (disconnect drops queued records).
    await new Promise((r) => setTimeout(r, 0));
    controller.readAircraftInfo = realInfo;
    controller.update = realUpdate;
    observer.disconnect();
    controller.exit({ restoreTracking: false });
    return {
      childMutations,
      attrMutations,
      spans: tape.querySelectorAll('span').length,
      labelsAt,
      updateErrors: updateErrors.count,
    };
  });
  section('compass', compass);

  // ── 5. capture-pattern safety (voice-vision snapshot path) ─────────────
  section('capture', await page.evaluate(async () => {
    const viewer = window.__godsEyeView.viewer;
    const canvas = viewer.canvas;
    const gl = canvas.getContext('webgl2') || canvas.getContext('webgl');
    const preserved = Boolean(gl.getContextAttributes().preserveDrawingBuffer);
    // Exactly the production pattern (gevRealtime.renderFreshCesiumFrame +
    // the drawImage that follows it): request a render, await postRender,
    // then blit in the continuation — same task, before compositing.
    const rendered = new Promise((resolve) => {
      const remove = viewer.scene.postRender.addEventListener(() => { remove(); resolve(true); });
      setTimeout(() => { remove(); resolve(false); }, 2_000);
    });
    viewer.scene.requestRender?.();
    const fresh = await rendered;
    if (!fresh) return { skip: 'scene did not render within 2 s' };
    const w = 96; const h = 64;
    const probe = document.createElement('canvas');
    probe.width = w; probe.height = h;
    const ctx = probe.getContext('2d', { willReadFrequently: true });
    ctx.drawImage(canvas, 0, 0, w, h);
    const pixels = ctx.getImageData(0, 0, w, h).data;
    let lit = 0;
    for (let i = 0; i < pixels.length; i += 4) {
      if (pixels[i] + pixels[i + 1] + pixels[i + 2] > 24) lit += 1;
    }
    return {
      preserveDrawingBuffer: preserved,
      blitSameTask: true,
      sampledPixels: w * h,
      litPixels: lit,
      litFraction: Math.round((lit / (w * h)) * 1000) / 1000,
      verdict: lit / (w * h) > 0.05 ? 'FRAME-CAPTURED' : 'BLACK-FRAME',
    };
  }));

  // ── 6. frame cadence during a continuous orbit (A/B context) ───────────
  section('cadence', await page.evaluate(async () => {
    const viewer = window.__godsEyeView.viewer;
    const camera = viewer.camera;
    const start = performance.now();
    const deltas = [];
    let last = start;
    const orbitMs = 6_000;
    const listener = viewer.scene.preUpdate.addEventListener(() => {
      const now = performance.now();
      const dt = now - last;
      last = now;
      camera.rotateRight(dt * 0.00004);
    });
    // The idle render governor parks the scene when nothing needs frames —
    // sample CONTINUOUS cadence by requesting each frame explicitly, which
    // is what the on-screen costs (MSAA + backdrop blur + overlay backing)
    // are actually paid on.
    while (performance.now() - start < orbitMs) {
      await new Promise((r) => requestAnimationFrame(r));
      viewer.scene.requestRender?.();
      const now = performance.now();
      deltas.push(now - last);
      last = now;
    }
    listener();
    deltas.sort((a, b) => a - b);
    const pick = (p) => Math.round(deltas[Math.floor(deltas.length * p)] * 10) / 10;
    return {
      frames: deltas.length,
      meanMs: Math.round(deltas.reduce((s, d) => s + d, 0) / deltas.length * 10) / 10,
      p50Ms: pick(0.5),
      p95Ms: pick(0.95),
    };
  }));
} finally {
  if (JSON_OUT) {
    fs.mkdirSync(path.dirname(JSON_OUT), { recursive: true });
    fs.writeFileSync(JSON_OUT, `${JSON.stringify(report, null, 2)}\n`);
    console.log(`WROTE ${JSON_OUT}`);
  }
  await browser.close();
}
