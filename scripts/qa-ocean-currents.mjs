#!/usr/bin/env node
/**
 * qa-ocean-currents.mjs: headless proof of the Ocean Currents layer at globe,
 * regional (Gulf Stream) and coastal (Monterey Bay, HF radar) scale.
 *
 * Records qa-shots/ocean-currents/clip.webm (the PR recording), one screenshot
 * per stop, and asserts the manifest tier and valid-cell count at each stop
 * from /api/ocean/currents/status plus the layer's own rendered state.
 *
 * Run:  node scripts/qa-ocean-currents.mjs --url http://localhost:4420
 * Exits non-zero on any FAIL. Needs ffmpeg on PATH for the webm
 * (`nix shell nixpkgs#ffmpeg --command node scripts/qa-ocean-currents.mjs`).
 * Pass --no-video to skip the recording.
 */
import puppeteer from 'puppeteer';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.join(path.resolve(__dirname, '..'), 'qa-shots', 'ocean-currents');
const argv = process.argv.slice(2);
const getOpt = (name, dflt) => {
  const i = argv.indexOf(name);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : dflt;
};
const APP_URL = getOpt('--url', 'http://localhost:4420');
const HOLD_MS = Number(getOpt('--hold', '6000'));
const VIDEO = !argv.includes('--no-video');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// lon, lat, camera height (m), the box the status probe asks for, expected tier.
const STOPS = [
  {
    name: 'globe',
    lon: -40,
    lat: 25,
    height: 18_000_000,
    box: { latMin: -60, latMax: 60, lonMin: -120, lonMax: 40 },
    tier: 'global',
  },
  {
    name: 'gulf-stream',
    lon: -70,
    lat: 36,
    height: 2_600_000,
    box: { latMin: 25, latMax: 47, lonMin: -82, lonMax: -58 },
    tier: 'regional',
  },
  {
    name: 'monterey-bay',
    lon: -122.1,
    lat: 36.8,
    height: 90_000,
    box: { latMin: 36.4, latMax: 37.2, lonMin: -122.6, lonMax: -121.7 },
    tier: 'regional',
  },
];

const results = [];
function record(name, ok, detail) {
  results.push({ name, ok, detail });
  const tag = ok ? '\x1b[32mPASS\x1b[0m' : '\x1b[31mFAIL\x1b[0m';
  console.log(`  [${tag}] ${name}${detail ? `  - ${detail}` : ''}`);
}

async function setView(page, lon, lat, height) {
  await page.evaluate(
    (lo, la, h) => {
      const gev = window.__godsEyeView;
      const ell = gev.viewer.scene.globe.ellipsoid;
      const d2r = Math.PI / 180;
      try {
        gev.viewer.camera.cancelFlight();
      } catch {
        /* no flight active */
      }
      gev.viewer.camera.setView({
        destination: ell.cartographicToCartesian({
          longitude: lo * d2r,
          latitude: la * d2r,
          height: h,
        }),
        orientation: { heading: 0, pitch: -Math.PI / 2, roll: 0 },
      });
      gev.viewer.scene.requestRender?.();
    },
    lon,
    lat,
    height,
  );
}

async function layerState(page) {
  return page.evaluate(() => {
    const entry = window.__godsEyeView.dataManager.layers.get('ocean-currents');
    const module = entry?.module;
    return {
      present: Boolean(entry),
      stats: module?.getStats?.() ?? null,
      diagnostics: module?.getDiagnostics?.() ?? null,
    };
  });
}

async function waitForField(page, { timeoutMs = 120_000 } = {}) {
  const deadline = Date.now() + timeoutMs;
  let state = null;
  while (Date.now() < deadline) {
    state = await layerState(page);
    const gpu = state.diagnostics?.gpu;
    const ready =
      state.diagnostics?.renderMode === 'canvas-fallback'
        ? state.diagnostics.particleCount > 0
        : Boolean(gpu?.ready && gpu.pathCount > 0);
    if (state.stats && !state.stats.loading && !state.stats.error && ready)
      return state;
    await page.evaluate(() =>
      window.__godsEyeView?.viewer?.scene?.requestRender?.(),
    );
    await sleep(500);
  }
  return state;
}

fs.mkdirSync(OUT, { recursive: true });
const browser = await puppeteer.launch({
  headless: true,
  // A system Chromium (PUPPETEER_EXECUTABLE_PATH) beats the bundled build on
  // hosts that lack its shared libraries, as qa-firms.mjs also allows.
  ...(process.env.PUPPETEER_EXECUTABLE_PATH
    ? { executablePath: process.env.PUPPETEER_EXECUTABLE_PATH }
    : {}),
  args: [
    '--use-angle=swiftshader',
    '--enable-unsafe-swiftshader',
    '--no-sandbox',
    '--window-size=1440,900',
  ],
});
try {
  const page = await browser.newPage();
  await page.setViewport({ width: 1440, height: 900 });
  // The first-run mission dialog would cover the globe in every frame.
  await page.evaluateOnNewDocument(() =>
    sessionStorage.setItem('gev:first-run-mission-session:v1', 'dismissed'),
  );
  page.on('pageerror', (error) => console.log('  [page error]', error.message));
  const url = new URL(APP_URL);
  url.searchParams.set('welcome', '0');
  await page.goto(url.href, { waitUntil: 'domcontentloaded', timeout: 60_000 });
  await page.waitForFunction(
    () =>
      window.__godsEyeView?.viewer &&
      window.__godsEyeView?.dataManager &&
      document.getElementById('loading-screen')?.classList.contains('hidden'),
    { timeout: 120_000 },
  );
  await page.keyboard.press('Escape');
  await sleep(500);
  await page.evaluate(async () => {
    await window.__godsEyeView.dataManager.setEnabled('ocean-currents', true);
  });
  const recorder = VIDEO
    ? await page.screencast({ path: path.join(OUT, 'clip.webm') })
    : null;
  for (const stop of STOPS) {
    await setView(page, stop.lon, stop.lat, stop.height);
    await page.evaluate(() => {
      const entry = window.__godsEyeView.dataManager.layers.get('ocean-currents');
      return entry?.module?.update?.(window.__godsEyeView.viewer);
    });
    const state = await waitForField(page);
    const query = new URLSearchParams(
      Object.entries(stop.box).map(([k, v]) => [k, String(v)]),
    );
    const status = await fetch(
      `${APP_URL}/api/ocean/currents/status?${query}`,
    ).then((r) => r.json());
    record(
      `${stop.name}: manifest tier ${stop.tier}`,
      status.tier === stop.tier && !status.unavailable,
      `tier=${status.tier} provenance=${status.provenance?.tier} reason=${status.reason ?? 'none'}`,
    );
    record(
      `${stop.name}: field has valid cells`,
      (status.speed?.validCells ?? 0) > 0,
      `validCells=${status.speed?.validCells} median=${status.speed?.medianMs?.toFixed?.(3)} p95=${status.speed?.p95Ms?.toFixed?.(3)}`,
    );
    const drawn =
      state?.diagnostics?.gpu?.pathCount ?? state?.diagnostics?.particleCount ?? 0;
    record(
      `${stop.name}: layer rendered`,
      Boolean(state?.stats) &&
        !state.stats.loading &&
        !state.stats.error &&
        state.stats.tier === stop.tier &&
        drawn > 0,
      `mode=${state?.diagnostics?.renderMode} paths=${state?.diagnostics?.gpu?.pathCount ?? state?.diagnostics?.particleCount} speedScale=${state?.diagnostics?.speedScale ?? state?.diagnostics?.gpu?.speedScale} tier=${state?.stats?.tier} error=${state?.stats?.error ?? 'none'}`,
    );
    await sleep(HOLD_MS);
    await page.screenshot({ path: path.join(OUT, `${stop.name}.png`) });
  }
  await recorder?.stop();
} finally {
  await browser.close();
}
fs.writeFileSync(
  path.join(OUT, 'result.json'),
  JSON.stringify({ appUrl: APP_URL, results, at: new Date().toISOString() }, null, 2),
);
const failed = results.filter((r) => !r.ok);
console.log(failed.length ? `\n${failed.length} FAIL` : '\nall PASS');
process.exit(failed.length ? 1 : 0);
