#!/usr/bin/env node
/**
 * qa-gnss.mjs — headless proof for the GNSS Interference layer.
 *
 * Drives the REAL app in headless Chromium against a dev server (keyless).
 * The live section reads adsb.lol through `/api/gnss-integrity` (60 s server
 * cache, one upstream read per whole-degree anchor); the other sections
 * intercept that route so they are deterministic.
 *
 *   (i)   LIVE — over the southern Baltic the layer settles with cells,
 *         no error, and legend band counts that sum to the cell count.
 *   (ii)  BANDS (synthetic) — a 10-aircraft cell with 5 degraded is high,
 *         a 3-aircraft cell with 1 degraded is low (first bad discounted),
 *         a 2-aircraft cell is withheld; `stale: true` reaches getStats.
 *   (iii) FAILURE — the route intercepted to 502: stats.error is set and the
 *         cells already on the globe are kept.
 *   (iv)  DISABLE — the layer's data source is hidden.
 *
 * Visual proof saved to qa-shots/gnss-*.png (gitignored).
 *
 * Run:  node scripts/qa-gnss.mjs --url http://localhost:4173
 * Exits non-zero on any FAIL. Does not commit anything.
 */

import puppeteer from 'puppeteer';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..');
const SHOTS_DIR = path.join(REPO_ROOT, 'qa-shots');

const argv = process.argv.slice(2);
const getOpt = (name, dflt) => {
  const i = argv.indexOf(name);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : dflt;
};
const APP_URL = getOpt('--url', 'http://localhost:4173');
const HEADFUL = argv.includes('--headful');
const LAYER_ID = 'gnss-interference';

const results = [];
function record(name, ok, detail) {
  results.push({ name, ok, detail });
  const tag = ok ? '\x1b[32mPASS\x1b[0m' : '\x1b[31mFAIL\x1b[0m';
  console.log(`  [${tag}] ${name}${detail ? `  — ${detail}` : ''}`);
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Boot the app, dismiss the intro and place the camera straight down. */
async function boot(page, { lon, lat, height }) {
  await page.goto(`${APP_URL}/?welcome=0`, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.waitForFunction(
    () => window.__godsEyeView?.viewer && window.__godsEyeView?.dataManager,
    { timeout: 60000 },
  );
  await sleep(5000);
  await page.keyboard.press('Escape');
  await page.evaluate((lo, la, h) => {
    const gev = window.__godsEyeView;
    const d2r = Math.PI / 180;
    // The app's intro flyTo animation clobbers a setView issued mid-flight.
    try { gev.viewer.camera.cancelFlight(); } catch { /* no flight active */ }
    gev.viewer.camera.setView({
      destination: gev.viewer.scene.globe.ellipsoid.cartographicToCartesian({
        longitude: lo * d2r, latitude: la * d2r, height: h,
      }),
      orientation: { heading: 0, pitch: -Math.PI / 2, roll: 0 },
    });
    gev.viewer.scene.requestRender?.();
  }, lon, lat, height);
}

/** Enable (or refresh) the layer and poll until it settles. */
async function enableAndSettle(page, { timeoutS = 30, refresh = false } = {}) {
  return page.evaluate(async (id, tS, again) => {
    const dm = window.__godsEyeView.dataManager;
    const layer = dm.layers.get(id).module;
    if (again) await layer.update();
    else await dm.setEnabled(id, true);
    let stats = null;
    for (let i = 0; i < tS; i++) {
      stats = layer.getStats();
      if (stats.count > 0 || stats.error) break;
      await new Promise((r) => setTimeout(r, 1000));
    }
    const legend = layer.getRowControls().legend.map(({ label, count }) => ({ label, count }));
    const ds = window.__godsEyeView.viewer.dataSources.getByName(id)[0];
    return { stats, legend, entities: ds?.entities.values.length ?? -1, shown: ds?.show ?? null };
  }, LAYER_ID, timeoutS, refresh);
}

const fixtureRow = (hex, lat, lon, degraded) => ({
  hex, lat, lon, nic: degraded ? 0 : 8, nacp: degraded ? 0 : 10, gpsLost: false, degraded,
});

/** Three synthetic 0.5° cells: high (5/10 bad), low (1/3 bad), withheld (2 aircraft). */
function fixturePayload() {
  const rows = [];
  const hex = (prefix, i) => `${prefix}${i.toString(16).padStart(2, '0')}`;
  for (let i = 0; i < 10; i++) rows.push(fixtureRow(hex('a000', i), 55.1 + i * 0.01, 19.1, i < 5));
  for (let i = 0; i < 3; i++) rows.push(fixtureRow(hex('b000', i), 54.1 + i * 0.01, 18.1, i === 0));
  for (let i = 0; i < 2; i++) rows.push(fixtureRow(hex('c000', i), 53.1 + i * 0.01, 17.1, true));
  return { fetchedAt: Date.now(), anchor: { lat: 55, lon: 19 }, radiusNm: 250, rows, stale: true };
}

async function main() {
  console.log('\nGNSS Interference proof (qa-gnss)');
  console.log(`  App URL : ${APP_URL}\n`);
  try {
    const res = await fetch(APP_URL);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
  } catch (e) {
    console.error(`\x1b[31mDev server not reachable at ${APP_URL} (${e.message}).\x1b[0m`);
    process.exit(2);
  }
  fs.mkdirSync(SHOTS_DIR, { recursive: true });
  const executablePath = process.env.PUPPETEER_EXECUTABLE_PATH
    || (await puppeteer.executablePath().catch(() => null)) || undefined;
  const browser = await puppeteer.launch({
    headless: HEADFUL ? false : 'new',
    ...(executablePath && fs.existsSync(executablePath) ? { executablePath } : {}),
    args: [
      '--no-sandbox', '--disable-setuid-sandbox', '--use-gl=angle', '--use-angle=swiftshader',
      '--disable-dev-shm-usage', '--disable-background-timer-throttling',
      '--disable-renderer-backgrounding', '--window-size=1440,900',
    ],
  });

  let exitCode = 0;
  const errors = [];
  try {
    // ── (i) LIVE ──────────────────────────────────────────────────────────
    console.log('(i) LIVE — adsb.lol integrity snapshot over the southern Baltic...');
    const live = await browser.newPage();
    await live.setViewport({ width: 1440, height: 900 });
    live.on('pageerror', (e) => errors.push(e.message));
    await boot(live, { lon: 19.5, lat: 55.0, height: 1_600_000 });
    const l = await enableAndSettle(live);
    const legendTotal = l.legend.reduce((sum, { count }) => sum + count, 0);
    record('LIVE: cells drawn, no error',
      l.stats.count > 0 && !l.stats.error && l.entities === l.stats.count,
      `cells=${l.stats.count} entities=${l.entities} error=${JSON.stringify(l.stats.error)}`);
    record('LIVE: legend band counts sum to the cell count', legendTotal === l.stats.count,
      JSON.stringify(l.legend));
    await sleep(3000);
    await live.screenshot({ path: path.join(SHOTS_DIR, 'gnss-live-baltic.png') });
    await live.close();

    // ── (ii) BANDS ────────────────────────────────────────────────────────
    console.log('\n(ii) BANDS — synthetic integrity rows through the real layer...');
    const page = await browser.newPage();
    await page.setViewport({ width: 1440, height: 900 });
    page.on('pageerror', (e) => errors.push(e.message));
    await page.setRequestInterception(true);
    let mode = 'fixture';
    page.on('request', (req) => {
      if (!req.url().includes('/api/gnss-integrity')) { req.continue(); return; }
      if (mode === 'fixture') {
        req.respond({ status: 200, contentType: 'application/json', body: JSON.stringify(fixturePayload()) });
      } else {
        req.respond({ status: 502, contentType: 'application/json',
          body: JSON.stringify({ error: 'gnss_integrity_unavailable' }) });
      }
    });
    await boot(page, { lon: 18.6, lat: 54.6, height: 450_000 });
    const f = await enableAndSettle(page);
    const band = (prefix) => f.legend.find(({ label }) => label.startsWith(prefix))?.count;
    record('BANDS: 2 cells shown, the 2-aircraft cell withheld',
      f.stats.count === 2 && f.entities === 2, `cells=${f.stats.count} entities=${f.entities}`);
    record('BANDS: 5/10 degraded is high, 1/3 degraded is low',
      band('Over') === 1 && band('Under') === 1 && band('2') === 0, JSON.stringify(f.legend));
    record('BANDS: stale snapshot is reported', f.stats.stale === true, `stale=${f.stats.stale}`);
    await page.waitForFunction(() => window.__godsEyeView.viewer.scene.globe.tilesLoaded,
      { timeout: 60000 }).catch(() => {});
    await sleep(2000);
    await page.screenshot({ path: path.join(SHOTS_DIR, 'gnss-synthetic-bands.png') });

    // ── (iii) FAILURE ─────────────────────────────────────────────────────
    console.log('\n(iii) FAILURE — /api/gnss-integrity intercepted to 502...');
    mode = 'error';
    const e = await enableAndSettle(page, { refresh: true, timeoutS: 1 });
    record('FAILURE: error surfaced, cells kept',
      Boolean(e.stats.error) && e.stats.count === 2 && e.entities === 2,
      `error=${JSON.stringify(e.stats.error)} cells=${e.stats.count}`);

    // ── (iv) DISABLE ──────────────────────────────────────────────────────
    console.log('\n(iv) DISABLE...');
    const shown = await page.evaluate(async (id) => {
      await window.__godsEyeView.dataManager.setEnabled(id, false);
      return window.__godsEyeView.viewer.dataSources.getByName(id)[0]?.show;
    }, LAYER_ID);
    record('DISABLE: data source hidden', shown === false, `show=${shown}`);
    record('no uncaught browser errors', errors.length === 0, errors.slice(0, 3).join(' | '));
  } catch (err) {
    console.error('\x1b[31mHarness error:\x1b[0m', err);
    exitCode = 3;
  } finally {
    await browser.close();
  }

  const pass = results.filter((r) => r.ok).length;
  const fail = results.length - pass;
  console.log('\n' + '─'.repeat(60));
  console.log(`  RESULT: ${pass} passed, ${fail} failed`);
  console.log(`  Shots : ${SHOTS_DIR}/gnss-*.png`);
  console.log('─'.repeat(60) + '\n');
  process.exit(exitCode || (fail > 0 ? 1 : 0));
}

main().catch((e) => { console.error(e); process.exit(3); });
