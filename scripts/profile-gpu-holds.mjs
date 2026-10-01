#!/usr/bin/env node
// scripts/profile-gpu-holds.mjs
//
// GPU-pegging audit (cycle 4, user report: "GPU at 99% on several machines").
//
// Cesium burns GPU only while it renders frames. The render governor flips
// the scene into `requestRenderMode` when no continuous-render hold is
// active, so the audit question is precise: WHICH holds keep continuous mode
// alive in a realistic session, at what effective frame rate, and what does
// each phase cost per frame?
//
// The instrument drives the real app through a scripted session and samples
// per second:
//   - renders/s: `scene.frameState.frameNumber` delta (the true GPU frame count)
//   - `scene.requestRenderMode`, governor diagnostics (mode, holds, fps, camera)
//   - rAF/s (main-thread wakeups), long tasks, heap
//   - per-frame GPU cost knobs: resolutionScale, FXAA, msaaSamples, dpr
//
// Headless caveat (see memory: settled scenes stop BeginFrames): each sample
// pumps a screenshot so Cesium's loop keeps receiving frames. Absolute fps is
// SwiftShader-software-GL and NOT comparable to hardware; the portable signal
// is WHICH holds are alive and whether renders/s matches the governor policy.
//
// Usage:
//   node scripts/profile-gpu-holds.mjs                 # full session
//   node scripts/profile-gpu-holds.mjs --json out.json # also write JSON

import fs from 'node:fs';
import puppeteer from 'puppeteer';

const BASE_URL = process.env.GEV_PROFILE_URL || 'http://localhost:4173/';
const JSON_OUT = process.argv.includes('--json')
  ? process.argv[process.argv.indexOf('--json') + 1]
  : null;
const FLIGHTS = !process.argv.includes('--no-flights');

const CHROME_EXECUTABLE_CANDIDATES = [
  process.env.CHROME_PATH,
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
  '/usr/bin/chromium-browser',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
].filter(Boolean);

function findChromeExecutable() {
  for (const candidate of CHROME_EXECUTABLE_CANDIDATES) {
    try {
      if (fs.existsSync(candidate)) return candidate;
    } catch { /* fall through to puppeteer's cache */ }
  }
  return null;
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** One-second sample: pump a frame, then read every render-cost counter. */
async function sampleOnce(page) {
  await page.screenshot({ type: 'jpeg', quality: 40 }); // BeginFrame pump
  return page.evaluate(() => {
    const v = window.__godsEyeView?.viewer;
    const scene = v?.scene;
    const gov = window.__godsEyeView?.getRenderGovernorDiagnostics?.();
    const fxaa = scene?.postProcessStages?.fxaa;
    return {
      t: Date.now(),
      frameNumber: scene?.frameState?.frameNumber ?? -1,
      requestRenderMode: scene?.requestRenderMode ?? null,
      targetFrameRate: v?.targetFrameRate ?? null,
      governor: gov
        ? { mode: gov.mode, holds: gov.holds, policy: gov.policy, cameraActive: gov.cameraActive }
        : null,
      resolutionScale: v?.resolutionScale ?? null,
      canvasW: scene?.canvas?.width ?? null,
      canvasH: scene?.canvas?.height ?? null,
      fxaaEnabled: fxaa ? fxaa.enabled : null,
      msaaSamples: scene?.msaaSamples ?? null,
      dpr: window.devicePixelRatio ?? null,
      rafPerSecBasis: performance.now(),
    };
  });
}

/** Sample `seconds` one-second buckets of {renders, raf} via installed counters. */
async function samplePhase(page, seconds, label) {
  const samples = [];
  const t0 = Date.now();
  let lastFrame = await page.evaluate(() => window.__godsEyeView?.viewer?.scene?.frameState?.frameNumber ?? -1);
  while (Date.now() - t0 < seconds * 1000) {
    await sleep(1_000);
    // Two pumps bracket the bucket: any render Cesium performed between them
    // advances frameState.frameNumber. Screenshots force BeginFrames so a
    // settled headless compositor cannot fake idle (see memory: rAF starvation).
    const snap = await sampleOnce(page);
    const nowFrame = snap.frameNumber;
    const renders = Math.max(0, nowFrame - lastFrame);
    lastFrame = nowFrame;
    samples.push({
      phase: label,
      elapsedS: Math.round((Date.now() - t0) / 1000),
      rendersPerSec: renders,
      ...snap,
      frameNumber: undefined,
    });
  }
  return samples;
}

/** Install a slow scripted orbit (keeps camera motion alive).
 *  Driven by a page-side interval on `camera.rotateRight` — the pattern
 *  qa-labels.mjs uses — so the app-module Cesium import is never needed:
 *  a `Cesium` reference here would throw (the app imports it as a module,
 *  there is no window.Cesium) and an uncaught throw inside Cesium's
 *  preRender chain kills the rAF loop for the rest of the session. */
async function startOrbit(page) {
  await page.evaluate(() => {
    const camera = window.__godsEyeView.viewer.camera;
    let last = performance.now();
    const id = setInterval(() => {
      const now = performance.now();
      camera.rotateRight((now - last) * 0.0000012);
      last = now;
    }, 16);
    window.__gevAuditOrbit = { remove: () => clearInterval(id) };
  });
}

async function stopOrbit(page) {
  await page.evaluate(() => {
    window.__gevAuditOrbit?.remove?.();
    window.__gevAuditOrbit = null;
  });
}

async function main() {
  const browser = await puppeteer.launch({
    headless: 'new',
    protocolTimeout: 300_000,
    ...(findChromeExecutable() ? { executablePath: findChromeExecutable() } : {}),
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--use-gl=angle',
      '--use-angle=swiftshader',
      '--disable-dev-shm-usage',
      '--disable-background-timer-throttling',
      '--disable-renderer-backgrounding',
    ],
  });
  const page = await browser.newPage();
  await page.setViewport({ width: 1440, height: 900, deviceScaleFactor: 1 });
  await page.evaluateOnNewDocument(`
    window.__gevProfile = { longTasks: [] };
    try {
      new PerformanceObserver((list) => {
        for (const entry of list.getEntries()) window.__gevProfile.longTasks.push(entry.duration);
      }).observe({ entryTypes: ['longtask'] });
    } catch {}
  `);

  const report = { url: BASE_URL, startedAt: new Date().toISOString(), phases: {} };

  // A loaded box (other sessions, dozens of Chromium processes) can take
  // minutes to reach domcontentloaded on this module graph; 60 s proved too
  // tight during the 2026-09-23 audit and 240 s timed out under load ~56 on
  // 2026-10-01, so navigate on a generous budget.
  await page.goto(BASE_URL, { waitUntil: 'domcontentloaded', timeout: 360_000 });
  await page.waitForFunction(
    () => window.__godsEyeView && window.__godsEyeView.viewer && window.__godsEyeView.dataManager,
    { timeout: 360_000, polling: 200 },
  );
  report.appReady = await page.evaluate(() => ({
    styleId: window.__godsEyeView.styleManager?.currentStyleId
      ?? window.__godsEyeView.styleManager?.activeStyleId
      ?? String(window.__godsEyeView.styleManager?.currentStyle ?? 'unknown'),
    detectionDebug: Boolean(new URLSearchParams(location.search).get('detectDebug')),
  }));

  // Phase 1: booted, default style, no extra layers, camera parked.
  await sleep(8_000);
  report.phases.bootIdle = await samplePhase(page, 15, 'boot-idle');

  // Phase 2: flights layer on, camera parked (the everyday case).
  if (FLIGHTS) {
    const enabled = await page.evaluate(async () => {
      const dm = window.__godsEyeView?.dataManager;
      if (!dm?.layers?.has('flights')) return 'missing';
      await dm.setEnabled('flights', true, { origin: 'programmatic' });
      return dm.isEffectivelyEnabled('flights') ? 'enabled' : 'not-enabled';
    });
    report.flightsEnable = enabled;
    await sleep(8_000); // first poll + tile settle
    report.phases.flightsIdle = await samplePhase(page, 15, 'flights-idle');

    // Phase 3: scripted orbit (camera moving + live fleet).
    await startOrbit(page);
    report.phases.orbit = await samplePhase(page, 12, 'orbit');
    await stopOrbit(page);

    // Phase 4: camera parked again — does anything keep continuous alive?
    await sleep(4_000);
    report.phases.restAfterOrbit = await samplePhase(page, 15, 'rest-after-orbit');
  }

  report.longTasks = await page.evaluate(() => window.__gevProfile.longTasks.length);
  report.heapMB = await page.evaluate(() => Math.round((performance.memory?.usedJSHeapSize ?? 0) / 1048576));

  // Summarize per phase: median renders/s + the hold set story.
  report.summary = {};
  for (const [phase, samples] of Object.entries(report.phases)) {
    const renders = samples.map((s) => s.rendersPerSec).sort((a, b) => a - b);
    const med = renders.at(Math.floor(renders.length / 2));
    const last = samples.at(-1);
    report.summary[phase] = {
      medianRendersPerSec: med,
      rendersPerSecTail: renders.slice(-5),
      requestRenderMode: last.requestRenderMode,
      targetFrameRate: last.targetFrameRate,
      holds: last.governor?.holds ?? null,
      cameraActive: last.governor?.cameraActive ?? null,
      resolutionScale: last.resolutionScale,
      fxaaEnabled: last.fxaaEnabled,
      msaaSamples: last.msaaSamples,
    };
  }

  console.log(JSON.stringify(report.summary, null, 2));
  if (JSON_OUT) fs.writeFileSync(JSON_OUT, `${JSON.stringify(report, null, 2)}\n`);
  await browser.close();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
