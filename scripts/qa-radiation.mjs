#!/usr/bin/env node
/**
 * qa-radiation.mjs — headless proof for the Radiation (BfS ODL + Safecast) layer.
 *
 * Drives the REAL app in headless Chromium against a dev server (keyless).
 * The live section reads both feeds through `/api/radiation`; the other
 * sections stub that route in the page so they are deterministic.
 *
 *   (i)   LIVE — the layer settles with no error, one entity per reading, a
 *         list capped at 25, and legend counts that sum to the reading count.
 *   (ii)  FIXTURE — a high and a raised Safecast reading in Fukushima, a
 *         typical one in Taiwan, a BfS station on the far side of the globe
 *         and an invalid row: the invalid row is dropped, the list is highest
 *         first, high and raised are labelled, the far-side point is hidden
 *         and the cached feed is named.
 *   (iii) SELECT — a real mouse click on a globe point selects it and shows
 *         the source chip; the chip opens the Safecast map; a click on empty
 *         space clears; a row-list click selects and flies the camera there.
 *   (iv)  FAILURE — the route stubbed to 502: stats.error is set, the readings
 *         already on the globe are kept and the row says the refresh failed.
 *   (v)   DISABLE — the layer's data source is hidden.
 *
 * Visual proof saved to qa-shots/radiation-*.png (gitignored).
 *
 * Run:  node scripts/qa-radiation.mjs --url http://localhost:4173
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
const LAYER_ID = 'radiation';
const SOURCE_PAGE = 'https://map.safecast.org/';

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
async function enableAndSettle(page, { timeoutS = 45, refresh = false } = {}) {
  return page.evaluate(
    async (id, tS, again) => {
      const dm = window.__godsEyeView.dataManager;
      const layer = dm.layers.get(id).module;
      const before = layer.getStats().lastUpdate;
      if (again) await dm.refreshLayer(id);
      else await dm.setEnabled(id, true);
      let stats = null;
      for (let i = 0; i < tS; i++) {
        stats = layer.getStats();
        if (stats.error || (stats.lastUpdate && stats.lastUpdate !== before))
          break;
        await new Promise((r) => setTimeout(r, 1000));
      }
      const controls = layer.getRowControls();
      const ds = window.__godsEyeView.viewer.dataSources.getByName(id)[0];
      return {
        stats,
        legend: controls.legend.map(({ label, count }) => ({ label, count })),
        items: controls.list.items.length,
        info: controls.info,
        entities: ds?.entities.values.length ?? -1,
        shown: ds?.show ?? null,
      };
    },
    LAYER_ID,
    timeoutS,
    refresh,
  );
}

/** Open the Data Layers panel and bring the Radiation row into view. */
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
  await page.screenshot({
    path: path.join(SHOTS_DIR, `radiation-${name}.png`),
  });
}

/** The DOM of the Radiation row: list leads, chips, legend and info text. */
const rowDom = (page) =>
  page.evaluate((id) => {
    const row = document.querySelector(`[data-layer-id="${id}"]`);
    const all = (selector) => [...(row?.querySelectorAll(selector) || [])];
    return {
      leads: all('.data-row-list-lead').map((node) => node.textContent),
      activeItems: all('.data-row-list-item.active').map(
        (node) => node.dataset.listItemId,
      ),
      chips: all('.data-toggle-chip').map((node) => node.dataset.chipId),
      legend: all('.data-toggle-legend-item').map((node) => node.textContent),
      info: row?.querySelector('.data-toggle-controls-info')?.textContent || '',
    };
  }, LAYER_ID);

/** Page position of a reading's point, or null when it is off screen. */
const readingOnScreen = (page, readingId) =>
  page.evaluate(
    (id, entityId) => {
      const { viewer } = window.__godsEyeView;
      const ds = viewer.dataSources.getByName(id)[0];
      const entity = ds?.entities.getById(entityId);
      const world = entity?.position?.getValue(viewer.clock.currentTime);
      const win = world && viewer.scene.cartesianToCanvasCoordinates(world);
      if (!win || !Number.isFinite(win.x)) return null;
      const rect = viewer.scene.canvas.getBoundingClientRect();
      const x = rect.left + win.x;
      const y = rect.top + win.y;
      return document.elementFromPoint(x, y) === viewer.scene.canvas
        ? { x, y }
        : null;
    },
    LAYER_ID,
    `${LAYER_ID}:${readingId}`,
  );

/** A page position over the canvas that shows space, not the globe. */
const emptySpaceOnScreen = (page) =>
  page.evaluate(() => {
    const { viewer } = window.__godsEyeView;
    const canvas = viewer.scene.canvas;
    const rect = canvas.getBoundingClientRect();
    for (let y = rect.top + 20; y < rect.bottom - 20; y += 20) {
      for (let x = rect.left + 20; x < rect.right - 20; x += 20) {
        if (document.elementFromPoint(x, y) !== canvas) continue;
        const position = { x: x - rect.left, y: y - rect.top };
        if (
          !viewer.camera.pickEllipsoid(position) &&
          !viewer.scene.pick(position)
        )
          return { x, y };
      }
    }
    return null;
  });

const selectedId = (page) =>
  page.evaluate(
    (id) =>
      window.__godsEyeView.dataManager.layers.get(id).module.getDiagnostics()
        .selectedId,
    LAYER_ID,
  );

const reading = (id, usvh, lon, lat, extra = {}) => ({
  id,
  source: id.split('-')[0],
  name: `Station ${id}`,
  country: 'JP',
  lon,
  lat,
  usvh,
  cpm: id.startsWith('safecast-') ? Math.round(usvh * 334) : null,
  atMs: Date.now() - 30 * 60_000,
  ...extra,
});

/** Three Safecast readings in East Asia, a far-side BfS station and a bad row. */
function fixturePayload() {
  return {
    fetchedAt: Date.now(),
    feeds: [
      { source: 'bfs', fetchedAt: Date.now() - 3_600_000, stale: true },
      { source: 'safecast', fetchedAt: Date.now(), stale: false },
    ],
    stale: true,
    readings: [
      reading('bfs-DEZ2240', 0.1, 9.18, 49.45, {
        name: 'Limbach',
        country: 'DE',
      }),
      reading('safecast-1001', 2.728, 140.9, 37.4, { name: 'Namie' }),
      reading('safecast-1002', 0.6, 140.37, 37.36, { name: 'Kōriyama' }),
      reading('safecast-1003', 0.08, 121.5, 25.05, {
        name: 'Taipei',
        country: 'TW',
      }),
      // Unknown source: dropped by the client sanitizer.
      reading('nope-9', 0.1, 130, 30),
    ],
  };
}

async function main() {
  console.log('\nRadiation proof (qa-radiation)');
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
    console.log('(i) LIVE — current BfS ODL and Safecast readings...');
    const live = await browser.newPage();
    await live.setViewport({ width: 1440, height: 900 });
    live.on('pageerror', (e) => errors.push(e.message));
    await boot(live, { lon: 10, lat: 50, height: 12_000_000 });
    const l = await enableAndSettle(live);
    const legendTotal = l.legend.reduce((sum, { count }) => sum + count, 0);
    record(
      'LIVE: no error, one entity per reading, the list capped at 25',
      !l.stats.error &&
        l.entities === l.stats.count &&
        l.items === Math.min(25, l.stats.count),
      `readings=${l.stats.count} entities=${l.entities} items=${l.items} error=${JSON.stringify(l.stats.error)}`,
    );
    record(
      'LIVE: both feeds returned current readings',
      l.stats.count > 0 &&
        /BfS ODL/.test(l.info) &&
        !/No data this refresh/.test(l.info),
      l.info,
    );
    record(
      'LIVE: legend counts sum to the reading count',
      legendTotal === l.stats.count,
      JSON.stringify(l.legend),
    );
    await shoot(live, 'live-world');
    await live.close();

    // ── (ii) FIXTURE ──────────────────────────────────────────────────────
    console.log('\n(ii) FIXTURE — stubbed readings through the real layer...');
    const page = await browser.newPage();
    await page.setViewport({ width: 1440, height: 900 });
    page.on('pageerror', (e) => errors.push(e.message));
    // Stub the route in-page rather than with request interception: an
    // intercepted page stalls Cesium's workers, so the globe never settles.
    await page.evaluateOnNewDocument((payload) => {
      const realFetch = window.fetch.bind(window);
      window.__radiationQaMode = 'fixture';
      window.__radiationOpened = [];
      window.fetch = (input, init) => {
        const url = typeof input === 'string' ? input : input?.url || '';
        if (!url.includes('/api/radiation')) return realFetch(input, init);
        const ok = window.__radiationQaMode === 'fixture';
        const body = ok
          ? { ...payload, fetchedAt: Date.now() }
          : { error: 'radiation_unavailable' };
        return Promise.resolve(
          new Response(JSON.stringify(body), {
            status: ok ? 200 : 502,
            headers: { 'Content-Type': 'application/json' },
          }),
        );
      };
    }, fixturePayload());
    await boot(page, { lon: 132, lat: 32, height: 7_000_000 });
    const f = await enableAndSettle(page);
    await showLayerRow(page);
    const dom = await rowDom(page);
    record(
      'FIXTURE: 4 readings drawn, the unknown source dropped',
      f.stats.count === 4 && f.entities === 4,
      `readings=${f.stats.count} entities=${f.entities}`,
    );
    record(
      'FIXTURE: list is highest dose rate first',
      dom.leads.join(',') === '2.73,0.600,0.100,0.080',
      JSON.stringify(dom.leads),
    );
    record(
      'FIXTURE: legend counts per band',
      JSON.stringify(f.legend.map(({ count }) => count)) === '[1,1,0,2]',
      JSON.stringify(dom.legend),
    );
    record(
      'FIXTURE: the cached feed and the caveat are shown in the row',
      /Some feeds are cached copies/.test(dom.info) &&
        /not an official warning/.test(dom.info),
      dom.info,
    );
    await sleep(1000);
    const drawn = await page.evaluate((id) => {
      const { viewer, dataManager } = window.__godsEyeView;
      return {
        labels: dataManager.layers.get(id).module.getDiagnostics().labels,
        ...Object.fromEntries(
          viewer.dataSources
            .getByName(id)[0]
            .entities.values.map((entity) => [
              entity.id.split(':')[1],
              { show: entity.show },
            ]),
        ),
      };
    }, LAYER_ID);
    record(
      'FIXTURE: high and raised are labelled through the overlay host, typical is not',
      drawn.labels.join() === 'safecast-1001,safecast-1002',
      JSON.stringify(drawn.labels),
    );
    record(
      'FIXTURE: the far-side point is hidden, the near ones shown',
      drawn['bfs-DEZ2240']?.show === false &&
        drawn['safecast-1001']?.show === true &&
        drawn['safecast-1003']?.show === true,
      JSON.stringify(drawn),
    );
    await shoot(page, 'fixture');

    // ── (iii) SELECT ──────────────────────────────────────────────────────
    console.log('\n(iii) SELECT — globe click, source chip, clear, list...');
    await page.evaluate(() => {
      window.open = (url) => {
        window.__radiationOpened.push(url);
        return null;
      };
    });
    const point = await readingOnScreen(page, 'safecast-1003');
    if (point) await page.mouse.click(point.x, point.y);
    await sleep(500);
    const clicked = await rowDom(page);
    record(
      'SELECT: a globe click on a point selects it and offers the source',
      point !== null &&
        (await selectedId(page)) === 'safecast-1003' &&
        clicked.chips.includes('source') &&
        clicked.activeItems.join() === 'safecast-1003' &&
        clicked.info.startsWith('Taipei (TW)'),
      `point=${JSON.stringify(point)} chips=${JSON.stringify(clicked.chips)} info=${JSON.stringify(clicked.info)}`,
    );
    await page.click(`[data-layer-id="${LAYER_ID}"] [data-chip-id="source"]`);
    await sleep(200);
    const opened = await page.evaluate(() => window.__radiationOpened);
    record(
      'SELECT: the source chip opens the Safecast map',
      opened.length === 1 && opened[0] === SOURCE_PAGE,
      JSON.stringify(opened),
    );
    await shoot(page, 'selected');
    const space = await emptySpaceOnScreen(page);
    if (space) await page.mouse.click(space.x, space.y);
    await sleep(500);
    const cleared = await rowDom(page);
    record(
      'SELECT: a click on empty space clears the selection',
      space !== null &&
        (await selectedId(page)) === null &&
        !cleared.chips.includes('source'),
      `space=${JSON.stringify(space)} chips=${JSON.stringify(cleared.chips)}`,
    );
    await page.click(
      `[data-layer-id="${LAYER_ID}"] .data-row-list-item[data-list-item-id="safecast-1002"]`,
    );
    await sleep(3000);
    const camera = await page.evaluate(() => {
      const c = window.__godsEyeView.viewer.camera.positionCartographic;
      return {
        lon: (c.longitude * 180) / Math.PI,
        lat: (c.latitude * 180) / Math.PI,
        height: c.height,
      };
    });
    record(
      'SELECT: a list click selects the reading and flies the camera there',
      (await selectedId(page)) === 'safecast-1002' &&
        Math.abs(camera.lon - 140.37) < 1 &&
        Math.abs(camera.lat - 37.36) < 1 &&
        Math.abs(camera.height - 300_000) < 30_000,
      JSON.stringify(camera),
    );
    await shoot(page, 'focus');

    // ── (iv) FAILURE ──────────────────────────────────────────────────────
    console.log('\n(iv) FAILURE — /api/radiation stubbed to 502...');
    await page.evaluate(() => {
      window.__radiationQaMode = 'error';
      window.__godsEyeView.dataManager.layers
        .get('radiation')
        .module.setParams({ clear: true });
    });
    const e = await enableAndSettle(page, { refresh: true, timeoutS: 2 });
    await showLayerRow(page);
    const failed = await rowDom(page);
    record(
      'FAILURE: error surfaced, readings kept, row says so',
      Boolean(e.stats.error) &&
        e.stats.count === 4 &&
        e.entities === 4 &&
        /Last refresh failed/.test(failed.info),
      `error=${JSON.stringify(e.stats.error)} readings=${e.stats.count} info=${JSON.stringify(failed.info)}`,
    );

    // ── (v) DISABLE ───────────────────────────────────────────────────────
    console.log('\n(v) DISABLE...');
    const shown = await page.evaluate(async (id) => {
      await window.__godsEyeView.dataManager.setEnabled(id, false);
      return window.__godsEyeView.viewer.dataSources.getByName(id)[0]?.show;
    }, LAYER_ID);
    record('DISABLE: data source hidden', shown === false, `show=${shown}`);
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
  console.log(`  Shots : ${SHOTS_DIR}/radiation-*.png`);
  console.log('─'.repeat(60) + '\n');
  process.exit(exitCode || (fail > 0 ? 1 : 0));
}

main().catch((e) => {
  console.error(e);
  process.exit(3);
});
