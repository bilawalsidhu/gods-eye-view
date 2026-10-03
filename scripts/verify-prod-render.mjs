// scripts/verify-prod-render.mjs
// Post-deploy render verification for the production alias (RUNBOOK step
// "verify"). Loads the deployed app headless, forces a render frame (the
// governor's requestRenderMode presents frames on demand and a headless
// session has no input events — a plain screenshot can capture a pre-tile
// stale frame), then asserts the photoreal tile stream and the Functions
// surface actually engaged. Not part of the QA matrix: RUNBOOK-only.
//
// Usage: node scripts/verify-prod-render.mjs [baseUrl]
import puppeteer from 'puppeteer';
import fs from 'node:fs';

const BASE_URL = process.argv[2] || 'https://globe-52p.pages.dev';
// The QA suites' convention (scripts/qa-a11y.mjs): Puppeteer's own Chrome for
// Testing, overridable via env. The system /usr/lib/chromium auto-updates
// under us and its newer protocol has left puppeteer's browser-level attach
// (Target.setDiscoverTargets) hanging at launch.
const executablePath = process.env.PUPPETEER_EXECUTABLE_PATH
  || (() => { try { return puppeteer.executablePath(); } catch { return null; } })();
if (!executablePath || !fs.existsSync(executablePath)) {
  throw new Error('Puppeteer Chrome for Testing is unavailable (set PUPPETEER_EXECUTABLE_PATH)');
}

const consoleErrors = [];
const failures = [];
const tally = (ok, label, detail) => {
  console.log(`${ok ? '✔' : '✘'} ${label}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failures.push(label);
};

const browser = await puppeteer.launch({
  executablePath,
  headless: 'new',
  // A loaded host can take the browser itself over 30 s to print its WS
  // endpoint, and the CDP handshake can lose the CPU scheduler's race long
  // after — give the launch the same generosity the boot waits below get.
  timeout: 180000,
  protocolTimeout: 600000,
  args: [
    '--no-sandbox',
    '--disable-dev-shm-usage',
    '--enable-unsafe-swiftshader',
    '--use-gl=angle',
    '--use-angle=swiftshader',
    '--window-size=1600,900',
  ],
});
try {
  const page = await browser.newPage();
  await page.setViewport({ width: 1600, height: 900 });
  page.on('console', (msg) => {
    if (msg.type() === 'error') consoleErrors.push(msg.text());
  });

  // Per-session first-run dismissal (src/firstRunExperience.js key), written
  // before any page script runs so init reads it and skips the mission-picker
  // modal — the verification wants the globe, not the dialog.
  await page.evaluateOnNewDocument(() => {
    try { sessionStorage.setItem('gev:first-run-mission-session:v1', 'dismissed'); } catch { /* private mode */ }
  });

  await page.goto(BASE_URL, { waitUntil: 'domcontentloaded', timeout: 120000 });

  // Boot: the app stamps the global once init finishes.
  await page.waitForFunction(() => Boolean(window.__godsEyeView?.viewer), {
    timeout: 180000,
    polling: 250,
  });
  tally(true, 'app boots and exposes __godsEyeView.viewer');

  // Let the boot fly-in and tile stream run, then put the camera somewhere
  // unambiguous (KAUS, as the RUNBOOK's 2026-09-14 run did) so the captured
  // frame is judged against a known place, then force a presented frame
  // before capturing (render-governor requestRenderMode — see RUNBOOK).
  await new Promise((r) => setTimeout(r, 20000));
  await page.evaluate(() => {
    // window.Cesium isn't exposed by the bundle; derive what we need from the
    // live instances (Cartographic ctor off the camera, ellipsoid off the
    // globe). Angles in radians; setView is instant.
    const { viewer } = window.__godsEyeView;
    const Carto = viewer.camera.positionCartographic.constructor;
    const dest = viewer.scene.globe.ellipsoid.cartographicToCartesian(
      new Carto(-97.66 * Math.PI / 180, 30.2 * Math.PI / 180, 2500),
    );
    viewer.camera.setView({
      destination: dest,
      orientation: { heading: 20 * Math.PI / 180, pitch: -35 * Math.PI / 180, roll: 0 },
    });
  });
  await new Promise((r) => setTimeout(r, 15000));
  await page.evaluate(() => {
    const { scene } = window.__godsEyeView.viewer;
    scene.requestRenderMode = false;
    setTimeout(() => { scene.requestRenderMode = true; }, 4000);
  });
  await new Promise((r) => setTimeout(r, 5000));

  const tileStats = await page.evaluate(() => {
    const entries = performance.getEntriesByType('resource');
    const tiles = entries.filter((e) => e.name.includes('googleapis.com'));
    const byStatus = {};
    for (const e of tiles) {
      const key = String(e.responseStatus);
      byStatus[key] = (byStatus[key] || 0) + 1;
    }
    return {
      tileRequests: tiles.length,
      tileOk: tiles.filter((e) => e.responseStatus === 200).length,
      byStatus,
      canvas: (() => {
        const c = document.querySelector('canvas');
        return c ? { w: c.clientWidth, h: c.clientHeight } : null;
      })(),
    };
  });
  tally(tileStats.canvas && tileStats.canvas.w > 800, 'Cesium canvas fills the viewport', JSON.stringify(tileStats.canvas));
  const globe = await page.evaluate(() => {
    const { viewer } = window.__godsEyeView;
    const carto = viewer.camera.positionCartographic;
    return {
      heightM: carto ? Math.round(carto.height) : null,
      tilesLoaded: viewer.scene.globe.tilesLoaded,
    };
  });
  tally(globe.heightM !== null && globe.heightM < 100000 && globe.tilesLoaded,
    'camera low over the target and the globe has its tiles', JSON.stringify(globe));
  // A CDN stream legitimately mixes in 304 revalidations; gate on the stream
  // being overwhelmingly 200 and non-trivial in volume, and surface the
  // histogram so a real failure mode is visible, not averaged away.
  tally(tileStats.tileRequests >= 50 && tileStats.tileOk / tileStats.tileRequests >= 0.95,
    'photoreal tile stream answers 200', `${tileStats.tileOk}/${tileStats.tileRequests} statuses ${JSON.stringify(tileStats.byStatus)}`);

  await page.screenshot({ path: 'qa-shots/prod-verify.png' });

  // Functions surface engaged from inside the running app (same-origin probes
  // the exact routes the client builders emit).
  const fn = await page.evaluate(async () => {
    const probe = async (url, init) => {
      try {
        const res = await fetch(url, init);
        return res.status;
      } catch { return 'network-error'; }
    };
    return {
      cctv: await probe('/api/cctv/sources'),
      // The endpoint's shape validation (both runtimes, Pages parity) rejects
      // a bodyless POST with 400 "record must be a JSON object" — send the
      // minimal valid record so this probes the real 204 write path.
      debugLog: await probe('/api/realtime/debug-log', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: '{}',
      }),
      regionalBrief: await probe('/api/regional-brief?latitude=30.201&longitude=-97.705'),
    };
  });
  tally(fn.cctv === 200, 'CCTV catalog answers 200', `status ${fn.cctv}`);
  tally(fn.debugLog === 204, 'realtime debug-log answers 204', `status ${fn.debugLog}`);
  tally(fn.regionalBrief === 200, 'regional-brief answers 200', `status ${fn.regionalBrief}`);

  const renderErrors = consoleErrors.filter((t) => !/favicon| trifork|Failed to load resource.*40[0-9]|net::ERR/i.test(t));
  tally(renderErrors.length === 0, 'no console errors at boot', renderErrors.slice(0, 3).join(' | '));
} finally {
  await browser.close();
}

if (failures.length > 0) {
  console.error(`PROD VERIFY FAILED (${failures.length}): ${failures.join('; ')}`);
  process.exit(1);
}
console.log('PROD VERIFY PASS');
