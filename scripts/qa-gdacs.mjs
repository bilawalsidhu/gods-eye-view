#!/usr/bin/env node
/**
 * qa-gdacs.mjs — headless proof for the Disaster Alerts (GDACS) layer.
 *
 * Drives the REAL app in headless Chromium against a dev server (keyless).
 * The live section reads GDACS through `/api/gdacs`; the other sections stub
 * that route in the page so they are deterministic.
 *
 *   (i)   LIVE — the layer settles with no error, one entity and one row-list
 *         item per event, and legend counts that sum to the event count.
 *   (ii)  FIXTURE — a red cyclone, an orange flood and two green events (one
 *         on the far side of the globe) plus an invalid row: the invalid row
 *         is dropped, the list is most severe first, red and orange are
 *         labelled, the far-side point is hidden and a missing feed is named.
 *   (iii) SELECT — a real mouse click on a globe point selects it and shows
 *         the report chip; the chip opens the GDACS report; a click on empty
 *         space clears; a row-list click selects and flies the camera there.
 *   (iv)  FAILURE — the route stubbed to 502: stats.error is set, the events
 *         already on the globe are kept and the row says the refresh failed.
 *   (v)   DISABLE — the layer's data source is hidden and a GDACS-owned
 *         shared selection is released.
 *
 * Every selection and clear in (iii) and (v) is also checked on the shared
 * `gev:entity-selected` / `gev:entity-selection-cleared` lane: one normalized
 * record per selection, the centroid as a point, provenance and caveat.
 *
 * Visual proof saved to qa-shots/gdacs-*.png (gitignored).
 *
 * Run:  node scripts/qa-gdacs.mjs --url http://localhost:4173
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
const LAYER_ID = 'gdacs-alerts';
const REPORT = 'https://www.gdacs.org/report.aspx?eventtype=EQ&eventid=1003';

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

/** Open the Data Layers panel and bring the GDACS row into view. */
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
  await page.screenshot({ path: path.join(SHOTS_DIR, `gdacs-${name}.png`) });
}

/** The DOM of the GDACS row: list leads, chips, legend and info text. */
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

/** Page position of an event's point, or null when it is off screen. */
const eventOnScreen = (page, eventId) =>
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
    `${LAYER_ID}:${eventId}`,
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

const event = (type, eventId, level, lon, lat, extra = {}) => ({
  id: `${type}-${eventId}`,
  type,
  eventId,
  episodeId: 1,
  level,
  name: `${type} ${eventId}`,
  country: '',
  lon,
  lat,
  fromMs: Date.UTC(2026, 8, 24),
  toMs: Date.UTC(2026, 8, 29),
  modifiedMs: null,
  severity: '',
  current: true,
  reportUrl: `https://www.gdacs.org/report.aspx?eventtype=${type}&eventid=${eventId}`,
  ...extra,
});

/** Four valid events around the western Pacific and one on the far side. */
function fixturePayload() {
  return {
    fetchedAt: Date.now(),
    feeds: ['EQ', 'TC', 'FL', 'VO', 'DR', 'WF'].map((type) =>
      type === 'WF'
        ? { type, fetchedAt: null, stale: false, missing: true }
        : { type, fetchedAt: Date.now(), stale: false },
    ),
    events: [
      event('EQ', 1003, 'green', 142.5, 38, {
        name: 'M 5.4 off the east coast of Honshu',
        country: 'Japan',
        severity: 'Magnitude 5.4M, Depth:35km',
      }),
      event('DR', 1004, 'green', -60, -10, {
        name: 'Drought in Brazil',
        country: 'Brazil',
      }),
      event('TC', 1001, 'red', 128, 19, {
        name: 'Typhoon QA-26',
        country: 'Philippines',
        severity: 'Typhoon, 230 km/h',
      }),
      event('FL', 1002, 'orange', 110, 28, {
        name: 'Flood in China',
        country: 'China',
      }),
      // Unknown type: dropped by the client sanitizer.
      { ...event('EQ', 9, 'green', 0, 0), id: 'XX-9', type: 'XX' },
    ],
  };
}

async function main() {
  console.log('\nDisaster Alerts proof (qa-gdacs)');
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
    console.log('(i) LIVE — current GDACS events worldwide...');
    const live = await browser.newPage();
    await live.setViewport({ width: 1440, height: 900 });
    live.on('pageerror', (e) => errors.push(e.message));
    await boot(live, { lon: 60, lat: 20, height: 20_000_000 });
    const l = await enableAndSettle(live);
    const legendTotal = l.legend.reduce((sum, { count }) => sum + count, 0);
    record(
      'LIVE: no error, one entity and one list item per event',
      !l.stats.error &&
        l.entities === l.stats.count &&
        l.items === l.stats.count,
      `events=${l.stats.count} entities=${l.entities} items=${l.items} error=${JSON.stringify(l.stats.error)}`,
    );
    record('LIVE: GDACS returned current events', l.stats.count > 0, l.info);
    record(
      'LIVE: legend counts sum to the event count',
      legendTotal === l.stats.count,
      JSON.stringify(l.legend),
    );
    await shoot(live, 'live-world');
    await live.close();

    // ── (ii) FIXTURE ──────────────────────────────────────────────────────
    console.log('\n(ii) FIXTURE — stubbed events through the real layer...');
    const page = await browser.newPage();
    await page.setViewport({ width: 1440, height: 900 });
    page.on('pageerror', (e) => errors.push(e.message));
    // Stub the route in-page rather than with request interception: an
    // intercepted page stalls Cesium's workers, so the globe never settles.
    await page.evaluateOnNewDocument((payload) => {
      const realFetch = window.fetch.bind(window);
      window.__gdacsQaMode = 'fixture';
      window.__gdacsOpened = [];
      // The shared selection lane, as the rest of GEV hears it.
      window.__gdacsLane = [];
      for (const type of [
        'gev:entity-selected',
        'gev:entity-selection-cleared',
      ])
        window.addEventListener(type, (event) => {
          if (event.detail?.layerId !== 'gdacs-alerts') return;
          const { entity: _e, dataSource: _d, ...detail } = event.detail;
          window.__gdacsLane.push({ type, detail });
        });
      window.fetch = (input, init) => {
        const url = typeof input === 'string' ? input : input?.url || '';
        if (!url.includes('/api/gdacs')) return realFetch(input, init);
        const ok = window.__gdacsQaMode === 'fixture';
        const body = ok
          ? { ...payload, fetchedAt: Date.now() }
          : { error: 'gdacs_unavailable' };
        return Promise.resolve(
          new Response(JSON.stringify(body), {
            status: ok ? 200 : 502,
            headers: { 'Content-Type': 'application/json' },
          }),
        );
      };
    }, fixturePayload());
    await boot(page, { lon: 125, lat: 28, height: 9_000_000 });
    const f = await enableAndSettle(page);
    await showLayerRow(page);
    const dom = await rowDom(page);
    record(
      'FIXTURE: 4 events drawn, the unknown type dropped',
      f.stats.count === 4 && f.entities === 4,
      `events=${f.stats.count} entities=${f.entities}`,
    );
    record(
      'FIXTURE: list is most severe first',
      dom.leads.slice(0, 2).join(',') === 'RED,ORANGE' &&
        dom.leads.length === 4,
      JSON.stringify(dom.leads),
    );
    record(
      'FIXTURE: legend counts per level',
      JSON.stringify(f.legend.map(({ count }) => count)) === '[1,1,2]',
      JSON.stringify(dom.legend),
    );
    record(
      'FIXTURE: the missing feed and the GDACS caveat are shown in the row',
      /No data this refresh: Wildfire/.test(dom.info) &&
        /not official warnings/.test(dom.info),
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
      'FIXTURE: red and orange are labelled through the overlay host, green is not',
      drawn.labels.join() === 'TC-1001,FL-1002',
      JSON.stringify(drawn.labels),
    );
    record(
      'FIXTURE: the far-side point is hidden, the near ones shown',
      drawn['DR-1004']?.show === false &&
        drawn['TC-1001']?.show === true &&
        drawn['EQ-1003']?.show === true,
      JSON.stringify(drawn),
    );
    await shoot(page, 'fixture');

    // ── (iii) SELECT ──────────────────────────────────────────────────────
    console.log('\n(iii) SELECT — globe click, report chip, clear, list...');
    await page.evaluate(() => {
      window.open = (url) => {
        window.__gdacsOpened.push(url);
        return null;
      };
    });
    const lane = () => page.evaluate(() => window.__gdacsLane.splice(0));
    await lane();
    const point = await eventOnScreen(page, 'EQ-1003');
    if (point) await page.mouse.click(point.x, point.y);
    await sleep(500);
    const clicked = await rowDom(page);
    record(
      'SELECT: a globe click on a point selects it and offers the report',
      point !== null &&
        (await selectedId(page)) === 'EQ-1003' &&
        clicked.chips.includes('report') &&
        clicked.activeItems.join() === 'EQ-1003' &&
        clicked.info.startsWith('M 5.4 off the east coast of Honshu'),
      `point=${JSON.stringify(point)} chips=${JSON.stringify(clicked.chips)} info=${JSON.stringify(clicked.info)}`,
    );
    const picked = await lane();
    const [published] = picked;
    record(
      'SELECT: the globe pick publishes one normalized gev:entity-selected',
      picked.length === 1 &&
        published.type === 'gev:entity-selected' &&
        published.detail.id === 'gdacs-alerts:EQ-1003' &&
        published.detail.kind === 'disaster-alert' &&
        published.detail.geometryKind === 'point' &&
        published.detail.locationKind === 'centroid' &&
        published.detail.caveat ===
          'automatic estimate, not official warning' &&
        published.detail.provenance?.source === 'GDACS' &&
        published.detail.provenance?.reportUrl === REPORT &&
        published.detail.provenance?.alertLevel === 'green' &&
        published.detail.provenance?.eventType === 'EQ' &&
        Number.isFinite(published.detail.provenance?.fetchedAt) &&
        !/polygon|footprint|bbox|extent|affectedArea/i.test(
          JSON.stringify(published.detail),
        ),
      JSON.stringify(picked),
    );
    await page.click(`[data-layer-id="${LAYER_ID}"] [data-chip-id="report"]`);
    await sleep(200);
    const opened = await page.evaluate(() => window.__gdacsOpened);
    record(
      'SELECT: the report chip opens the GDACS report',
      opened.length === 1 && opened[0] === REPORT,
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
        !cleared.chips.includes('report'),
      `space=${JSON.stringify(space)} chips=${JSON.stringify(cleared.chips)}`,
    );
    const released = await lane();
    record(
      'SELECT: the clear is published once on gev:entity-selection-cleared',
      released.length === 1 &&
        released[0].type === 'gev:entity-selection-cleared',
      JSON.stringify(released),
    );
    await page.click(
      `[data-layer-id="${LAYER_ID}"] .data-row-list-item[data-list-item-id="TC-1001"]`,
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
      'SELECT: a list click selects the event and flies the camera there',
      (await selectedId(page)) === 'TC-1001' &&
        Math.abs(camera.lon - 128) < 1 &&
        Math.abs(camera.lat - 19) < 1 &&
        Math.abs(camera.height - 1_500_000) < 150_000,
      JSON.stringify(camera),
    );
    const rowLane = await lane();
    record(
      'SELECT: the list click publishes one gev:entity-selected',
      rowLane.length === 1 &&
        rowLane[0].type === 'gev:entity-selected' &&
        rowLane[0].detail.id === 'gdacs-alerts:TC-1001' &&
        rowLane[0].detail.geometryKind === 'point',
      JSON.stringify(rowLane),
    );
    await shoot(page, 'focus');

    // ── (iv) FAILURE ──────────────────────────────────────────────────────
    console.log('\n(iv) FAILURE — /api/gdacs stubbed to 502...');
    await page.evaluate(() => {
      window.__gdacsQaMode = 'error';
      window.__godsEyeView.dataManager.layers
        .get('gdacs-alerts')
        .module.setParams({ clear: true });
    });
    const e = await enableAndSettle(page, { refresh: true, timeoutS: 2 });
    await showLayerRow(page);
    const failed = await rowDom(page);
    record(
      'FAILURE: error surfaced, events kept, row says so',
      Boolean(e.stats.error) &&
        e.stats.count === 4 &&
        e.entities === 4 &&
        /Last refresh failed/.test(failed.info),
      `error=${JSON.stringify(e.stats.error)} events=${e.stats.count} info=${JSON.stringify(failed.info)}`,
    );

    // ── (v) DISABLE ───────────────────────────────────────────────────────
    console.log('\n(v) DISABLE...');
    await page.evaluate((id) => {
      window.__gdacsQaMode = 'fixture';
      window.__godsEyeView.dataManager.layers
        .get(id)
        .module.setParams({ eventId: 'TC-1001' });
    }, LAYER_ID);
    await lane();
    const shown = await page.evaluate(async (id) => {
      await window.__godsEyeView.dataManager.setEnabled(id, false);
      return window.__godsEyeView.viewer.dataSources.getByName(id)[0]?.show;
    }, LAYER_ID);
    record('DISABLE: data source hidden', shown === false, `show=${shown}`);
    const disabled = await lane();
    const shared = await page.evaluate(
      () => window.__gevContextStore?.selectedEntityId ?? null,
    );
    record(
      'DISABLE: the GDACS-owned shared selection is released',
      disabled.length === 1 &&
        disabled[0].type === 'gev:entity-selection-cleared' &&
        shared === null,
      `lane=${JSON.stringify(disabled)} selected=${JSON.stringify(shared)}`,
    );
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
  console.log(`  Shots : ${SHOTS_DIR}/gdacs-*.png`);
  console.log('─'.repeat(60) + '\n');
  process.exit(exitCode || (fail > 0 ? 1 : 0));
}

main().catch((e) => {
  console.error(e);
  process.exit(3);
});
