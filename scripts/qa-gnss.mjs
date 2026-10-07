#!/usr/bin/env node
/**
 * qa-gnss.mjs — headless proof for the GNSS Integrity layer
 * (id `gnss-interference`): low navigation accuracy reported by ADS-B.
 *
 * Drives the REAL app in headless Chromium against a dev server (keyless).
 * The live section reads adsb.lol through `/api/gnss-integrity` (60 s server
 * cache, one upstream read per whole-degree anchor); the other sections
 * stub that route in the page so they are deterministic.
 *
 *   (i)   LIVE — over Poland and the southern Baltic the layer settles with no error,
 *         one entity per cell and legend band counts that sum to the cell
 *         count; cells are required only when the returned rows, binned
 *         with the layer's own rules, reach the per-cell minimum (live
 *         traffic varies by hour).
 *   (ii)  BANDS (synthetic) — a 10-aircraft cell with 5 degraded is high,
 *         a 30-aircraft cell with 2 degraded is medium, a 3-aircraft cell
 *         with 1 degraded is low (first bad discounted), a clean cell at sea
 *         is low, a 2-aircraft cell is withheld; `stale: true` reaches
 *         getStats. Every band is drawn and low is shown over land and sea.
 *         The row reads as low navigation accuracy, and stats carry the
 *         machine-readable provenance (GEV classifier, gpsjam bands, window).
 *   (iii) FAILURE — the route stubbed to 502: stats.error is set and the
 *         cells already on the globe are kept.
 *   (iv)  DISABLE — the layer's data source is hidden.
 *   (v)   KEYBOARD — the row's toggle button, focused, turns the layer on
 *         with Enter and off with Space, keeps focus and names its state.
 *   (vi)  VIEWPORT — at a 390x844 phone viewport the open row and its legend
 *         fit the panel width with no horizontal overflow.
 *   (vii) AGE (synthetic) — a fresh page whose stubbed proxy replays the same
 *         stale snapshot observed 31 minutes ago draws nothing and reports no
 *         error; observed 29 minutes ago it draws its cells. The replay keeps
 *         its observation time instead of restarting the 30-minute window.
 *
 * Screenshots wait until every cell's ground geometry is built and show the
 * open Data Layers row with its legend. Visual proof saved to
 * qa-shots/gnss-*.png (gitignored).
 *
 * Run:  node scripts/qa-gnss.mjs --url http://localhost:4173
 *       (also against a built preview: npm run build && npm run preview,
 *       then pass the preview URL)
 * Exits non-zero on any FAIL. Does not commit anything.
 */

import puppeteer from 'puppeteer';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  accumulateGnssObservations,
  binGnssCells,
} from '../src/layers/gnss/records.js';

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
      const rowControls = layer.getRowControls().legend;
      const legend = rowControls.map(({ label, count }) => ({ label, count }));
      const blurb = rowControls[0]?.blurb ?? '';
      const rowName =
        document.querySelector(`[data-layer-id="${id}"] .data-name`)
          ?.textContent ?? '';
      const ds = window.__godsEyeView.viewer.dataSources.getByName(id)[0];
      return {
        stats,
        legend,
        blurb,
        rowName,
        name: layer.name,
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

/** Answer /api/gnss-integrity in-page from `fixturePayload()`. */
async function stubRoute(page, { ageMs = 0 } = {}) {
  await page.evaluateOnNewDocument(
    (payload, age) => {
      window.__gnssQaAgeMs = age;
      const realFetch = window.fetch.bind(window);
      window.__gnssQaMode = 'fixture';
      window.fetch = (input, init) => {
        const url = typeof input === 'string' ? input : input?.url || '';
        if (!url.includes('/api/gnss-integrity')) return realFetch(input, init);
        const ok = window.__gnssQaMode === 'fixture';
        const body = ok
          ? {
              ...payload,
              fetchedAt: Date.now() - (window.__gnssQaAgeMs || 0),
              ageMs: window.__gnssQaAgeMs || 0,
            }
          : { error: 'gnss_integrity_unavailable' };
        return Promise.resolve(
          new Response(JSON.stringify(body), {
            status: ok ? 200 : 502,
            headers: { 'Content-Type': 'application/json' },
          }),
        );
      };
    },
    fixturePayload(),
    ageMs,
  );
}

/** Toggle button of the GNSS row, as the panel draws it. */
function toggleState(id) {
  const button = document.querySelector(
    `[data-layer-id="${id}"] .data-toggle-btn`,
  );
  const layer = window.__godsEyeView.dataManager.layers.get(id);
  return {
    focused: document.activeElement === button,
    label: button?.getAttribute('aria-label') ?? '',
    enabled: Boolean(layer?.enabled),
    count: layer?.module.getStats().count ?? -1,
  };
}

/** Press a key on the focused GNSS toggle and wait for the lifecycle to settle. */
async function pressToggle(page, key, wantEnabled) {
  await page.evaluate((id) => {
    document.querySelector(`[data-layer-id="${id}"] .data-toggle-btn`)?.focus();
  }, LAYER_ID);
  await page.keyboard.press(key);
  await page
    .waitForFunction(
      (id, want) => {
        const layer = window.__godsEyeView.dataManager.layers.get(id);
        return (
          Boolean(layer?.enabled) === want &&
          (!want || layer.module.getStats().count > 0)
        );
      },
      { timeout: 30000, polling: 250 },
      LAYER_ID,
      wantEnabled,
    )
    .catch(() => {});
  return page.evaluate(`(${toggleState})(${JSON.stringify(LAYER_ID)})`);
}

async function main() {
  console.log('\nGNSS Integrity proof (qa-gnss)');
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
        liveBodies.push(res.json().then((body) => body.rows ?? []));
    });
    await boot(live, { lon: 19.5, lat: 52.5, height: 1_100_000 });
    const l = await enableAndSettle(live);
    const legendTotal = l.legend.reduce((sum, { count }) => sum + count, 0);
    // Bin what adsb.lol actually returned with the layer's own rules: live
    // traffic varies by hour, so cells are required only when some cell
    // really reached the minimum aircraft count.
    const liveSnapshots = (await Promise.allSettled(liveBodies))
      .filter((r) => r.status === 'fulfilled')
      .map((r) => r.value);
    const liveRows = liveSnapshots.reduce((sum, rows) => sum + rows.length, 0);
    const expectedStore = new Map();
    for (const rows of liveSnapshots)
      accumulateGnssObservations(expectedStore, rows, Date.now());
    const expectedCells = binGnssCells(expectedStore).length;
    record(
      'LIVE: no error, one entity per cell',
      !l.stats.error && l.entities === l.stats.count,
      `cells=${l.stats.count} entities=${l.entities} error=${JSON.stringify(l.stats.error)}`,
    );
    if (expectedCells > 0) {
      record(
        'LIVE: a snapshot with a qualifying cell yields cells',
        l.stats.count > 0,
        `rows=${liveRows} expected=${expectedCells} cells=${l.stats.count}`,
      );
    } else {
      console.log(
        `  [info] ${liveRows} live rows, no cell reaches the minimum — cell count not asserted`,
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
    await stubRoute(page);
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
    const prov = f.stats.provenance;
    record(
      'PROVENANCE: GEV classifier, gpsjam bands and visited-view window are machine-readable',
      prov?.classifier?.id === 'gev-nic-nacp-v1' &&
        prov.classifier.definedBy === 'GEV' &&
        prov.classifier.validated === false &&
        prov.aggregation?.source === 'https://gpsjam.org/faq' &&
        JSON.stringify(prov.aggregation.bands) === '[0.02,0.1]' &&
        prov.window?.minutes === 30 &&
        prov.window.scope === 'visited-view' &&
        prov.interpretation?.validated === false,
      JSON.stringify(prov?.classifier),
    );
    record(
      'WORDING: the row leads with low navigation accuracy, interference only as the hedged reading',
      f.name === 'GNSS Integrity' &&
        f.rowName.includes('GNSS Integrity') &&
        !/interference/i.test(f.rowName) &&
        f.legend.every(({ label }) => label.endsWith('low accuracy')) &&
        f.blurb.startsWith(
          'Share of ADS-B aircraft reporting low navigation accuracy',
        ) &&
        /GEV threshold/.test(f.blurb) &&
        /Suspected jamming or spoofing is one possible cause/.test(f.blurb),
      `name=${JSON.stringify(f.name)}`,
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

    // ── (v) KEYBOARD ──────────────────────────────────────────────────────
    console.log('\n(v) KEYBOARD — the row toggle, from the keyboard...');
    await page.evaluate(() => {
      window.__gnssQaMode = 'fixture';
    });
    await showLayerRow(page);
    const on = await pressToggle(page, 'Enter', true);
    record(
      'KEYBOARD: Enter on the focused toggle enables the layer and keeps focus',
      on.enabled &&
        on.focused &&
        on.count === 4 &&
        /^GNSS Integrity: /.test(on.label) &&
        !/OFF$/.test(on.label),
      JSON.stringify(on),
    );
    const off = await pressToggle(page, ' ', false);
    record(
      'KEYBOARD: Space on the focused toggle disables it and the label says OFF',
      !off.enabled && off.focused && /^GNSS Integrity: OFF$/.test(off.label),
      JSON.stringify(off),
    );

    // ── (vi) VIEWPORT ─────────────────────────────────────────────────────
    console.log(
      '\n(vi) VIEWPORT — the open row on a 390x844 phone viewport...',
    );
    await page.close();
    // A fresh page: switching an open page to isMobile reloads it, which
    // would measure a half-booted app instead of the open row.
    const phone = await browser.newPage();
    await phone.setViewport({ width: 390, height: 844, isMobile: true });
    phone.on('pageerror', (e) => errors.push(e.message));
    await stubRoute(phone);
    await boot(phone, { lon: 18.6, lat: 54.6, height: 450_000 });
    await showLayerRow(phone);
    await pressToggle(phone, 'Enter', true);
    await showLayerRow(phone);
    const fit = await phone.evaluate((id) => {
      const row = document.querySelector(`[data-layer-id="${id}"]`);
      const legend = [...row.querySelectorAll('.data-toggle-legend-item')];
      const rect = row.getBoundingClientRect();
      return {
        width: window.innerWidth,
        rowLeft: Math.round(rect.left),
        rowRight: Math.round(rect.right),
        overflow: row.scrollWidth - row.clientWidth,
        legendItems: legend.length,
        legendInside: legend.every((item) => {
          const r = item.getBoundingClientRect();
          return (
            r.width > 0 && r.left >= rect.left - 1 && r.right <= rect.right + 1
          );
        }),
      };
    }, LAYER_ID);
    record(
      'VIEWPORT: row and legend fit a 390 px viewport without horizontal overflow',
      fit.rowLeft >= 0 &&
        fit.rowRight <= fit.width &&
        fit.overflow <= 0 &&
        fit.legendItems === 3 &&
        fit.legendInside,
      JSON.stringify(fit),
    );
    await phone.screenshot({ path: path.join(SHOTS_DIR, 'gnss-phone.png') });
    await phone.close();

    // ── (vii) AGE ─────────────────────────────────────────────────────────
    console.log(
      '\n(vii) AGE — a replayed stale snapshot keeps its observation time...',
    );
    const aged = await browser.newPage();
    await aged.setViewport({ width: 1440, height: 900 });
    aged.on('pageerror', (e) => errors.push(e.message));
    await stubRoute(aged, { ageMs: 31 * 60_000 });
    await boot(aged, { lon: 18.6, lat: 54.6, height: 450_000 });
    const old = await enableAndSettle(aged, { timeoutS: 5 });
    record(
      'AGE: a snapshot observed 31 min ago adds no cells and is not an error',
      old.stats.count === 0 && old.entities === 0 && !old.stats.error,
      `cells=${old.stats.count} entities=${old.entities} error=${JSON.stringify(old.stats.error)}`,
    );
    await aged.evaluate(() => {
      window.__gnssQaAgeMs = 29 * 60_000;
    });
    const recent = await enableAndSettle(aged, { refresh: true });
    record(
      'AGE: the same snapshot observed 29 min ago is still inside the window',
      recent.stats.count === 4 && recent.entities === 4,
      `cells=${recent.stats.count} entities=${recent.entities}`,
    );
    await aged.close();
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
