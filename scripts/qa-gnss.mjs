#!/usr/bin/env node
/**
 * qa-gnss.mjs — headless proof for the GNSS Interference layer.
 *
 * Drives the REAL app in headless Chromium against a dev server (keyless).
 * The live section reads adsb.lol through `/api/gnss-integrity` (60 s server
 * cache, one upstream read per whole-degree anchor); the other sections
 * stub that route in the page so they are deterministic.
 *
 *   (i)   LIVE — over Poland and the southern Baltic the layer settles with no error,
 *         one entity per cell and legend band counts that sum to the cell
 *         count; cells are required only when adsb.lol actually returned
 *         enough aircraft (live traffic varies by hour).
 *   (ii)  BANDS (synthetic) — a 10-aircraft cell with 5 degraded is high,
 *         a 30-aircraft cell with 2 degraded is medium, a 3-aircraft cell
 *         with 1 degraded is low (first bad discounted), a clean cell at sea
 *         is low, a 2-aircraft cell is withheld; `stale: true` reaches
 *         getStats. Every band is drawn and low is shown over land and sea.
 *   (iii) FAILURE — the route stubbed to 502: stats.error is set and the
 *         cells already on the globe are kept.
 *   (iv)  DISABLE — the layer's data source is hidden.
 *
 * Screenshots wait until every cell's ground geometry is built and show the
 * open Data Layers row with its legend. Visual proof saved to
 * qa-shots/gnss-*.png (gitignored).
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
/** Live rows below this cannot reliably fill a 3-aircraft cell. */
const LIVE_MIN_ROWS = 30;

const results = [];
function record(name, ok, detail) {
  results.push({ name, ok, detail });
  const tag = ok ? '\x1b[32mPASS\x1b[0m' : '\x1b[31mFAIL\x1b[0m';
  console.log(`  [${tag}] ${name}${detail ? `  — ${detail}` : ''}`);
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Boot the app, dismiss the intro and place the camera straight down. */
async function boot(page, { lon, lat, height }) {
  await page.goto(`${APP_URL}/?welcome=0`, {
    waitUntil: 'domcontentloaded',
    timeout: 60000,
  });
  await page.waitForFunction(
    () => window.__godsEyeView?.viewer && window.__godsEyeView?.dataManager,
    { timeout: 60000 },
  );
  await sleep(5000);
  await page.keyboard.press('Escape');
  await page.evaluate(
    (lo, la, h) => {
      const gev = window.__godsEyeView;
      const d2r = Math.PI / 180;
      // The app's intro flyTo animation clobbers a setView issued mid-flight.
      try {
        gev.viewer.camera.cancelFlight();
      } catch {
        /* no flight active */
      }
      gev.viewer.camera.setView({
        destination: gev.viewer.scene.globe.ellipsoid.cartographicToCartesian({
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

/** Enable (or refresh) the layer and poll until it settles. */
async function enableAndSettle(page, { timeoutS = 30, refresh = false } = {}) {
  return page.evaluate(
    async (id, tS, again) => {
      const dm = window.__godsEyeView.dataManager;
      const layer = dm.layers.get(id).module;
      if (again) await dm.refreshLayer(id);
      else await dm.setEnabled(id, true);
      let stats = null;
      for (let i = 0; i < tS; i++) {
        stats = layer.getStats();
        if (stats.count > 0 || stats.error) break;
        await new Promise((r) => setTimeout(r, 1000));
      }
      const legend = layer
        .getRowControls()
        .legend.map(({ label, count }) => ({ label, count }));
      const ds = window.__godsEyeView.viewer.dataSources.getByName(id)[0];
      return {
        stats,
        legend,
        entities: ds?.entities.values.length ?? -1,
        shown: ds?.show ?? null,
      };
    },
    LAYER_ID,
    timeoutS,
    refresh,
  );
}

/** Open the Data Layers panel and bring the GNSS row into view. */
async function showLayerRow(page) {
  await page.evaluate((id) => {
    const panel = document.getElementById('data-panel');
    if (panel.classList.contains('collapsed'))
      panel.querySelector('[data-collapse-target="data-panel"]').click();
    document
      .querySelector(`[data-layer-id="${id}"]`)
      ?.scrollIntoView({ block: 'center' });
  }, LAYER_ID);
  await sleep(800);
}

async function shoot(page, name) {
  await page
    .waitForFunction(
      () => window.__godsEyeView.viewer.scene.globe.tilesLoaded,
      { timeout: 60000 },
    )
    .catch(() => {});
  await showLayerRow(page);
  await page.screenshot({ path: path.join(SHOTS_DIR, `gnss-${name}.png`) });
}

/** Bounding-sphere state of every GNSS cell: DONE = 0, PENDING = 1, FAILED = 2. */
function cellStates(id) {
  const { viewer } = window.__godsEyeView;
  const ds = viewer.dataSources.getByName(id)[0];
  const sphere = {};
  return ds.entities.values.map((entity) => {
    try {
      return viewer.dataSourceDisplay.getBoundingSphere(entity, false, sphere);
    } catch {
      return 1; // not yet seen by the geometry visualizer
    }
  });
}

/** Wait until every GNSS cell's ground rectangle has finished building. */
async function waitForBuiltCells(page, timeoutMs = 60000) {
  const built = await page
    .waitForFunction(
      `(${cellStates})(${JSON.stringify(LAYER_ID)}).every((state) => state === 0)`,
      { timeout: timeoutMs, polling: 250 },
    )
    .then(
      () => true,
      () => false,
    );
  const states = await page.evaluate(
    `(${cellStates})(${JSON.stringify(LAYER_ID)})`,
  );
  return { built, detail: `states=${JSON.stringify(states)}` };
}

const fixtureRow = (hex, lat, lon, degraded) => ({
  hex,
  lat,
  lon,
  nic: degraded ? 0 : 8,
  nacp: degraded ? 0 : 10,
  gpsLost: false,
  degraded,
});

/**
 * Synthetic 0.5° cells: high at sea (5/10 bad), medium on land (2/30 bad),
 * low on land (1/3 bad), low at sea (0/4 bad), withheld (2 aircraft).
 */
function fixturePayload() {
  const rows = [];
  const hex = (prefix, i) => `${prefix}${i.toString(16).padStart(2, '0')}`;
  for (let i = 0; i < 10; i++)
    rows.push(fixtureRow(hex('a000', i), 55.1 + i * 0.01, 19.1, i < 5));
  for (let i = 0; i < 30; i++)
    rows.push(fixtureRow(hex('d000', i), 54.1 + i * 0.01, 19.6, i < 2));
  for (let i = 0; i < 3; i++)
    rows.push(fixtureRow(hex('b000', i), 54.1 + i * 0.01, 18.1, i === 0));
  for (let i = 0; i < 4; i++)
    rows.push(fixtureRow(hex('e000', i), 55.1 + i * 0.01, 18.1, false));
  for (let i = 0; i < 2; i++)
    rows.push(fixtureRow(hex('c000', i), 53.1 + i * 0.01, 17.1, true));
  return {
    fetchedAt: Date.now(),
    anchor: { lat: 55, lon: 19 },
    radiusNm: 250,
    rows,
    stale: true,
  };
}

async function main() {
  console.log('\nGNSS Interference proof (qa-gnss)');
  console.log(`  App URL : ${APP_URL}\n`);
  try {
    const res = await fetch(APP_URL);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
  } catch (e) {
    console.error(
      `\x1b[31mDev server not reachable at ${APP_URL} (${e.message}).\x1b[0m`,
    );
    process.exit(2);
  }
  fs.mkdirSync(SHOTS_DIR, { recursive: true });
  const executablePath =
    process.env.PUPPETEER_EXECUTABLE_PATH ||
    (await puppeteer.executablePath().catch(() => null)) ||
    undefined;
  const browser = await puppeteer.launch({
    headless: HEADFUL ? false : 'new',
    ...(executablePath && fs.existsSync(executablePath)
      ? { executablePath }
      : {}),
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--use-gl=angle',
      '--use-angle=swiftshader',
      '--disable-dev-shm-usage',
      '--disable-background-timer-throttling',
      '--disable-renderer-backgrounding',
      '--window-size=1440,900',
    ],
  });

  let exitCode = 0;
  const errors = [];
  try {
    // ── (i) LIVE ──────────────────────────────────────────────────────────
    console.log(
      '(i) LIVE — adsb.lol integrity snapshot over Poland and the southern Baltic...',
    );
    const live = await browser.newPage();
    await live.setViewport({ width: 1440, height: 900 });
    live.on('pageerror', (e) => errors.push(e.message));
    const liveBodies = [];
    live.on('response', (res) => {
      if (res.url().includes('/api/gnss-integrity') && res.ok())
        liveBodies.push(res.json().then((body) => body.rows?.length ?? 0));
    });
    await boot(live, { lon: 19.5, lat: 52.5, height: 1_100_000 });
    const l = await enableAndSettle(live);
    const legendTotal = l.legend.reduce((sum, { count }) => sum + count, 0);
    const liveRows = Math.max(
      0,
      ...(await Promise.allSettled(liveBodies))
        .filter((r) => r.status === 'fulfilled')
        .map((r) => r.value),
    );
    record(
      'LIVE: no error, one entity per cell',
      !l.stats.error && l.entities === l.stats.count,
      `cells=${l.stats.count} entities=${l.entities} error=${JSON.stringify(l.stats.error)}`,
    );
    if (liveRows >= LIVE_MIN_ROWS) {
      record(
        'LIVE: a busy snapshot yields cells',
        l.stats.count > 0,
        `rows=${liveRows} cells=${l.stats.count}`,
      );
    } else {
      console.log(
        `  [info] only ${liveRows} live rows — cell count not asserted`,
      );
    }
    record(
      'LIVE: legend band counts sum to the cell count',
      legendTotal === l.stats.count,
      JSON.stringify(l.legend),
    );
    const liveBuilt = await waitForBuiltCells(live);
    record(
      'LIVE: every cell rectangle is built on a parked camera',
      liveBuilt.built,
      liveBuilt.detail,
    );
    await shoot(live, 'live-poland-baltic');
    await live.close();

    // ── (ii) BANDS ────────────────────────────────────────────────────────
    console.log(
      '\n(ii) BANDS — synthetic integrity rows through the real layer...',
    );
    const page = await browser.newPage();
    await page.setViewport({ width: 1440, height: 900 });
    page.on('pageerror', (e) => errors.push(e.message));
    // Stub the route in-page rather than with request interception: an
    // intercepted page stalls Cesium's geometry workers, so ground rectangles
    // never finish building and the screenshot would not show real behaviour.
    await page.evaluateOnNewDocument((payload) => {
      const realFetch = window.fetch.bind(window);
      window.__gnssQaMode = 'fixture';
      window.fetch = (input, init) => {
        const url = typeof input === 'string' ? input : input?.url || '';
        if (!url.includes('/api/gnss-integrity')) return realFetch(input, init);
        const ok = window.__gnssQaMode === 'fixture';
        const body = ok
          ? { ...payload, fetchedAt: Date.now() }
          : { error: 'gnss_integrity_unavailable' };
        return Promise.resolve(
          new Response(JSON.stringify(body), {
            status: ok ? 200 : 502,
            headers: { 'Content-Type': 'application/json' },
          }),
        );
      };
    }, fixturePayload());
    await boot(page, { lon: 18.6, lat: 54.6, height: 450_000 });
    const f = await enableAndSettle(page);
    const band = (prefix) =>
      f.legend.find(({ label }) => label.startsWith(prefix))?.count;
    record(
      'BANDS: 4 cells shown, the 2-aircraft cell withheld',
      f.stats.count === 4 && f.entities === 4,
      `cells=${f.stats.count} entities=${f.entities}`,
    );
    record(
      'BANDS: 5/10 is high, 2/30 is medium, 1/3 and 0/4 are low',
      band('Over') === 1 && band('2') === 1 && band('Under') === 2,
      JSON.stringify(f.legend),
    );
    record(
      'BANDS: stale snapshot is reported',
      f.stats.stale === true,
      `stale=${f.stats.stale}`,
    );
    const bandsBuilt = await waitForBuiltCells(page);
    record(
      'BANDS: every cell rectangle is built on a parked camera',
      bandsBuilt.built,
      bandsBuilt.detail,
    );
    await shoot(page, 'synthetic-bands');

    // ── (iii) FAILURE ─────────────────────────────────────────────────────
    console.log('\n(iii) FAILURE — /api/gnss-integrity stubbed to 502...');
    await page.evaluate(() => {
      window.__gnssQaMode = 'error';
    });
    const e = await enableAndSettle(page, { refresh: true, timeoutS: 1 });
    record(
      'FAILURE: error surfaced, cells kept',
      Boolean(e.stats.error) && e.stats.count === 4 && e.entities === 4,
      `error=${JSON.stringify(e.stats.error)} cells=${e.stats.count}`,
    );
    await shoot(page, 'failure');

    // ── (iv) DISABLE ──────────────────────────────────────────────────────
    console.log('\n(iv) DISABLE...');
    const shown = await page.evaluate(async (id) => {
      await window.__godsEyeView.dataManager.setEnabled(id, false);
      return window.__godsEyeView.viewer.dataSources.getByName(id)[0]?.show;
    }, LAYER_ID);
    record('DISABLE: data source hidden', shown === false, `show=${shown}`);
    await shoot(page, 'disabled');
    record(
      'no uncaught browser errors',
      errors.length === 0,
      errors.slice(0, 3).join(' | '),
    );
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

main().catch((e) => {
  console.error(e);
  process.exit(3);
});
