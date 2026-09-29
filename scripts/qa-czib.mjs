#!/usr/bin/env node
/**
 * qa-czib.mjs — headless proof for the Conflict Zones (EASA CZIB)
 * layer.
 *
 * Drives the REAL app in headless Chromium against a dev server (keyless).
 * The live section reads EASA through `/api/czib`; the other sections stub
 * that route in the page so they are deterministic.
 *
 *   (i)   LIVE — the layer settles with no error, lists one item per active
 *         bulletin, draws every one of them from the bundled boundaries, and
 *         the legend counts sum to the bulletin count.
 *   (ii)  FIXTURE — Mali (whole), Pakistan (part), a five-country Gulf
 *         bulletin, an unknown country, a withdrawn bulletin and an invalid
 *         row: the invalid row is dropped, the withdrawn one is not drawn,
 *         the partial one is dashed, and the unknown country is named as
 *         not drawn.
 *   (iii) SELECT — a real mouse click inside Mali selects its bulletin and
 *         shows the bulletin chip; the chip opens the EASA page; a click on
 *         empty space clears; a row-list click selects and flies the camera.
 *   (iv)  FAILURE — the route stubbed to 502: stats.error is set, the
 *         shading already on the globe is kept and the row says so.
 *   (v)   DISABLE — the layer's data source is hidden.
 *
 * Visual proof saved to qa-shots/czib-*.png (gitignored).
 *
 * Run:  node scripts/qa-czib.mjs --url http://localhost:4173
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
const LAYER_ID = 'easa-czib';
const LIST = 'https://www.easa.europa.eu/en/domains/air-operations/czibs';

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

/** Open the Data Layers panel and bring the CZIB row into view. */
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
  await page.screenshot({ path: path.join(SHOTS_DIR, `czib-${name}.png`) });
}

/** The DOM of the CZIB row: list leads, chips, legend and info text. */
const rowDom = (page) =>
  page.evaluate((id) => {
    const row = document.querySelector(`[data-layer-id="${id}"]`);
    const all = (selector) => [...(row?.querySelectorAll(selector) || [])];
    return {
      leads: all('.data-row-list-text').map((node) => node.textContent),
      activeItems: all('.data-row-list-item.active').map(
        (node) => node.dataset.listItemId,
      ),
      chips: all('.data-toggle-chip').map((node) => node.dataset.chipId),
      legend: all('.data-toggle-legend-item').map((node) => node.textContent),
      info: row?.querySelector('.data-toggle-controls-info')?.textContent || '',
    };
  }, LAYER_ID);

/** Page position of a lon/lat on the globe, or null when it is off screen. */
const placeOnScreen = (page, lon, lat) =>
  page.evaluate(
    (lo, la) => {
      const { viewer } = window.__godsEyeView;
      const d2r = Math.PI / 180;
      const world = viewer.scene.globe.ellipsoid.cartographicToCartesian({
        longitude: lo * d2r,
        latitude: la * d2r,
        height: 0,
      });
      const win = viewer.scene.cartesianToCanvasCoordinates(world);
      if (!win || !Number.isFinite(win.x)) return null;
      const rect = viewer.scene.canvas.getBoundingClientRect();
      const x = rect.left + win.x;
      const y = rect.top + win.y;
      return document.elementFromPoint(x, y) === viewer.scene.canvas
        ? { x, y }
        : null;
    },
    lon,
    lat,
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

const bulletin = (id, number, title, countries, extra = {}) => ({
  id,
  number,
  title,
  area: title.replace(/^Airspace of (?:the )?/, ''),
  partial: false,
  status: 'active',
  countries,
  issuedMs: Date.UTC(2026, 6, 1),
  revisedMs: Date.UTC(2026, 8, 1) + Number(id) * 3_600_000,
  validUntilMs: Date.UTC(2026, 11, 31),
  validity: '31/12/2026, unless reviewed earlier.',
  url: `${LIST}/${number.toLowerCase()}`,
  ...extra,
});

/** Four active bulletins, one withdrawn, one invalid. */
function fixturePayload() {
  return {
    fetchedAt: Date.now(),
    bulletins: [
      bulletin('14', 'CZIB-2017-01R20', 'Airspace of Mali', ['Mali']),
      bulletin(
        '13',
        'CZIB-2018-02R21',
        'Airspace of Pakistan – Baluchistan and Khyber Pakhtunkhwa provinces',
        ['Pakistan'],
        { partial: true },
      ),
      bulletin(
        '12',
        'CZIB-2026-07R2',
        'Airspace of the Persian Gulf and Gulf of Oman',
        ['Bahrain', 'Kuwait', 'Qatar', 'Oman', 'United Arab Emirates'],
      ),
      bulletin('11', 'CZIB-2099-01', 'Airspace of Atlantis', ['Atlantis']),
      bulletin('10', 'CZIB-2016-01R4', 'Airspace of Kenya', ['Kenya'], {
        status: 'withdrawn',
      }),
      // Invalid id: dropped by the client sanitizer.
      bulletin('x', 'CZIB-2026-99', 'Airspace of Nowhere', ['Chad']),
    ],
  };
}

/** Per-bulletin drawn parts and dash style, plus the published labels. */
const drawnState = (page) =>
  page.evaluate((id) => {
    const { viewer, dataManager } = window.__godsEyeView;
    const byBulletin = {};
    for (const entity of viewer.dataSources.getByName(id)[0].entities.values) {
      const [, bulletinId] = entity.id.split(':');
      byBulletin[bulletinId] ??= {
        parts: 0,
        dashed: entity.polyline.material.constructor.name.includes('Dash'),
      };
      byBulletin[bulletinId].parts += 1;
    }
    const diagnostics = dataManager.layers.get(id).module.getDiagnostics();
    return { byBulletin, labels: diagnostics.labels, zones: diagnostics.zones };
  }, LAYER_ID);

async function main() {
  console.log('\nConflict Zones proof (qa-czib)');
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
    console.log('(i) LIVE — current EASA bulletins...');
    const live = await browser.newPage();
    await live.setViewport({ width: 1440, height: 900 });
    live.on('pageerror', (e) => errors.push(e.message));
    await boot(live, { lon: 35, lat: 28, height: 16_000_000 });
    const l = await enableAndSettle(live);
    const liveDrawn = await drawnState(live);
    const legendTotal = l.legend.reduce((sum, { count }) => sum + count, 0);
    record(
      'LIVE: no error, one list item per active bulletin',
      !l.stats.error && l.items === l.stats.count,
      `bulletins=${l.stats.count} items=${l.items} error=${JSON.stringify(l.stats.error)}`,
    );
    record(
      'LIVE: EASA returned active bulletins and every one is drawn',
      l.stats.count > 0 && liveDrawn.zones === l.stats.count && l.entities > 0,
      `drawn=${liveDrawn.zones} entities=${l.entities} info=${JSON.stringify(l.info)}`,
    );
    record(
      'LIVE: legend counts sum to the bulletin count',
      legendTotal === l.stats.count,
      JSON.stringify(l.legend),
    );
    await shoot(live, 'live-world');
    await live.close();

    // ── (ii) FIXTURE ──────────────────────────────────────────────────────
    console.log('\n(ii) FIXTURE — stubbed bulletins through the real layer...');
    const page = await browser.newPage();
    await page.setViewport({ width: 1440, height: 900 });
    page.on('pageerror', (e) => errors.push(e.message));
    // Stub the route in-page rather than with request interception: an
    // intercepted page stalls Cesium's workers, so the globe never settles.
    await page.evaluateOnNewDocument((payload) => {
      const realFetch = window.fetch.bind(window);
      window.__czibQaMode = 'fixture';
      window.__czibOpened = [];
      window.fetch = (input, init) => {
        const url = typeof input === 'string' ? input : input?.url || '';
        if (!url.includes('/api/czib')) return realFetch(input, init);
        const ok = window.__czibQaMode === 'fixture';
        const body = ok
          ? { ...payload, fetchedAt: Date.now() }
          : { error: 'czib_unavailable' };
        return Promise.resolve(
          new Response(JSON.stringify(body), {
            status: ok ? 200 : 502,
            headers: { 'Content-Type': 'application/json' },
          }),
        );
      };
    }, fixturePayload());
    await boot(page, { lon: 20, lat: 22, height: 11_000_000 });
    const f = await enableAndSettle(page);
    await showLayerRow(page);
    const dom = await rowDom(page);
    const drawn = await drawnState(page);
    record(
      'FIXTURE: 4 active bulletins listed; the withdrawn and invalid ones are not',
      f.stats.count === 4 && dom.leads.length === 4,
      `bulletins=${f.stats.count} leads=${JSON.stringify(dom.leads)}`,
    );
    record(
      'FIXTURE: Mali, Pakistan and the five Gulf states are drawn; Atlantis is not',
      drawn.zones === 3 &&
        drawn.byBulletin['14']?.parts >= 1 &&
        drawn.byBulletin['13']?.parts >= 1 &&
        drawn.byBulletin['12']?.parts >= 5 &&
        !drawn.byBulletin['11'] &&
        !drawn.byBulletin['10'],
      JSON.stringify(drawn.byBulletin),
    );
    record(
      'FIXTURE: only the part-country bulletin is dashed',
      drawn.byBulletin['13']?.dashed === true &&
        drawn.byBulletin['14']?.dashed === false &&
        drawn.byBulletin['12']?.dashed === false,
      JSON.stringify(drawn.byBulletin),
    );
    record(
      'FIXTURE: drawn bulletins are labelled through the overlay host',
      drawn.labels.slice().sort().join() === '12,13,14',
      JSON.stringify(drawn.labels),
    );
    record(
      'FIXTURE: legend counts whole vs part',
      JSON.stringify(f.legend.map(({ count }) => count)) === '[3,1]',
      JSON.stringify(dom.legend),
    );
    record(
      'FIXTURE: the undrawn country and the airspace caveat are in the row',
      /Not drawn: Atlantis/.test(dom.info) &&
        /not the exact airspace/.test(dom.info),
      dom.info,
    );
    await shoot(page, 'fixture');

    // ── (iii) SELECT ──────────────────────────────────────────────────────
    console.log('\n(iii) SELECT — globe click, bulletin chip, clear, list...');
    await page.evaluate(() => {
      window.open = (url) => {
        window.__czibOpened.push(url);
        return null;
      };
    });
    // Central Mali, well inside the country outline.
    const point = await placeOnScreen(page, -2, 17);
    if (point) await page.mouse.click(point.x, point.y);
    await sleep(500);
    const clicked = await rowDom(page);
    record(
      'SELECT: a globe click inside Mali selects its bulletin and offers the bulletin',
      point !== null &&
        (await selectedId(page)) === '14' &&
        clicked.chips.includes('bulletin') &&
        clicked.activeItems.join() === '14' &&
        clicked.info.startsWith('Airspace of Mali · CZIB-2017-01R20'),
      `point=${JSON.stringify(point)} chips=${JSON.stringify(clicked.chips)} info=${JSON.stringify(clicked.info)}`,
    );
    await page.click(`[data-layer-id="${LAYER_ID}"] [data-chip-id="bulletin"]`);
    await sleep(200);
    const opened = await page.evaluate(() => window.__czibOpened);
    record(
      'SELECT: the chip opens the bulletin on the EASA website',
      opened.length === 1 && opened[0] === `${LIST}/czib-2017-01r20`,
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
        !cleared.chips.includes('bulletin'),
      `space=${JSON.stringify(space)} chips=${JSON.stringify(cleared.chips)}`,
    );
    // Inside Baluchistan: a part-country zone keeps only a faint fill, which
    // must still take real picks.
    const partPoint = await placeOnScreen(page, 66, 28);
    if (partPoint) await page.mouse.click(partPoint.x, partPoint.y);
    await sleep(500);
    const partClicked = await rowDom(page);
    record(
      'SELECT: a globe click inside the faint part-country fill selects Pakistan',
      partPoint !== null &&
        (await selectedId(page)) === '13' &&
        partClicked.activeItems.join() === '13',
      `point=${JSON.stringify(partPoint)} active=${JSON.stringify(partClicked.activeItems)}`,
    );
    await page.click(
      `[data-layer-id="${LAYER_ID}"] .data-row-list-item[data-list-item-id="12"]`,
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
      'SELECT: a list click selects the bulletin and flies over the Gulf',
      (await selectedId(page)) === '12' &&
        camera.lon > 47 &&
        camera.lon < 60 &&
        camera.lat > 18 &&
        camera.lat < 30 &&
        camera.height >= 1_150_000 &&
        camera.height <= 9_100_000,
      JSON.stringify(camera),
    );
    await shoot(page, 'focus');

    // ── (iv) FAILURE ──────────────────────────────────────────────────────
    console.log('\n(iv) FAILURE — /api/czib stubbed to 502...');
    await page.evaluate((id) => {
      window.__czibQaMode = 'error';
      window.__godsEyeView.dataManager.layers
        .get(id)
        .module.setParams({ clear: true });
    }, LAYER_ID);
    const e = await enableAndSettle(page, { refresh: true, timeoutS: 2 });
    await showLayerRow(page);
    const failed = await rowDom(page);
    record(
      'FAILURE: error surfaced, shading kept, row says so',
      Boolean(e.stats.error) &&
        e.stats.count === 4 &&
        e.entities === f.entities &&
        /Last refresh failed/.test(failed.info),
      `error=${JSON.stringify(e.stats.error)} bulletins=${e.stats.count} info=${JSON.stringify(failed.info)}`,
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
  console.log(`  Shots : ${SHOTS_DIR}/czib-*.png`);
  console.log('─'.repeat(60) + '\n');
  process.exit(exitCode || (fail > 0 ? 1 : 0));
}

main().catch((e) => {
  console.error(e);
  process.exit(3);
});
