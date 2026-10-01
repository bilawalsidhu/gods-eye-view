#!/usr/bin/env node
/**
 * qa-wildlife.mjs — headless proof for the Wildlife (Movebank) layer.
 *
 * Drives the REAL app in headless Chromium against a dev server (keyless).
 * The live section reads the curated studies through `/api/wildlife`, which
 * walks Movebank one study at a time (several minutes from a cold cache); the
 * other sections stub that route in the page so they are deterministic.
 *
 *   (i)   LIVE — the proxy finishes its walk, most curated studies answer,
 *         the layer draws glyphs and paths, and the row cites Movebank / CC0.
 *         A study is chosen from the list and one of its animals picked.
 *   (ii)  FIXTURE — animals over the Low Countries and one on the far side of
 *         the globe: the far-side glyph is hidden, an eastbound animal's arrow
 *         points right with the camera looking north, a real click on a glyph
 *         names species, study, owner and last fix, the window chips change
 *         what is drawn, the DOI chip opens the dataset, a pending study
 *         is named, and a withdrawn study is listed as no longer public with
 *         its animal never drawn.
 *   (iii) FAILURE — the route stubbed to 502: stats.error is set, the glyphs
 *         already on the globe are kept and the row says the refresh failed.
 *   (iv)  DISABLE — the data source is hidden and the selection released.
 *
 * Visual proof saved to qa-shots/wildlife-*.png (gitignored).
 *
 * Run:  node scripts/qa-wildlife.mjs --url http://localhost:4173
 *       [--live-timeout 600]   seconds to wait for the Movebank walk
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
const LIVE_TIMEOUT_S = Number(getOpt('--live-timeout', '600'));
const HEADFUL = argv.includes('--headful');
const LAYER_ID = 'wildlife';
const GULLS = 1258895879;
const STORKS = 21231406;
const SPOONBILLS = 2313947453;
/** Stubbed as withdrawn from Movebank: its animal must never be drawn. */
const WITHDRAWN = 1609400843;
const CURATED = 7;

const results = [];
function record(name, ok, detail) {
  results.push({ name, ok, detail });
  const tag = ok ? '\x1b[32mPASS\x1b[0m' : '\x1b[31mFAIL\x1b[0m';
  console.log(`  [${tag}] ${name}${detail ? `  — ${detail}` : ''}`);
}
function note(name, detail) {
  console.log(
    `  [\x1b[36mNOTE\x1b[0m] ${name}${detail ? `  — ${detail}` : ''}`,
  );
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
async function enableAndSettle(page, { timeoutS = 60, refresh = false } = {}) {
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
      const ds = window.__godsEyeView.viewer.dataSources.getByName(id)[0];
      return {
        stats,
        diagnostics: layer.getDiagnostics(),
        entities: ds?.entities.values.length ?? -1,
        shown: ds?.show ?? null,
      };
    },
    LAYER_ID,
    timeoutS,
    refresh,
  );
}

/** Open the Data Layers panel and bring the Wildlife row into view. */
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
    path: path.join(SHOTS_DIR, `wildlife-${name}.png`),
  });
}

/** The DOM of the Wildlife row. */
const rowDom = (page) =>
  page.evaluate((id) => {
    const row = document.querySelector(`[data-layer-id="${id}"]`);
    const all = (selector) => [...(row?.querySelectorAll(selector) || [])];
    return {
      items: all('.data-row-list-item').map((node) => node.dataset.listItemId),
      itemText: Object.fromEntries(
        all('.data-row-list-item').map((node) => [
          node.dataset.listItemId,
          node.textContent.trim(),
        ]),
      ),
      activeItems: all('.data-row-list-item.active').map(
        (node) => node.dataset.listItemId,
      ),
      chips: all('.data-toggle-chip').map((node) => node.dataset.chipId),
      pressed: Object.fromEntries(
        all('.data-toggle-chip').map((node) => [
          node.dataset.chipId,
          node.getAttribute('aria-pressed'),
        ]),
      ),
      info: row?.querySelector('.data-toggle-controls-info')?.textContent || '',
      legend: all('.data-toggle-legend-item').map((node) =>
        node.textContent.trim(),
      ),
    };
  }, LAYER_ID);

const diagnostics = (page) =>
  page.evaluate(
    (id) =>
      window.__godsEyeView.dataManager.layers.get(id).module.getDiagnostics(),
    LAYER_ID,
  );

/** Per animal glyph: shown, and billboard rotation in radians. */
const glyphs = (page) =>
  page.evaluate((id) => {
    const { viewer } = window.__godsEyeView;
    const ds = viewer.dataSources.getByName(id)[0];
    const out = {};
    for (const entity of ds?.entities.values || []) {
      if (entity.id.split(':').length !== 3) continue;
      out[entity.id.split(':')[2]] = {
        show: entity.show,
        rotation: entity.billboard.rotation.getValue(viewer.clock.currentTime),
      };
    }
    return out;
  }, LAYER_ID);

/** Page position of an animal's glyph, or null when it is off screen. */
const glyphOnScreen = (page, animalId) =>
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
    `${LAYER_ID}:${animalId}`,
  );

const clickRow = (page, selector) =>
  page.click(`[data-layer-id="${LAYER_ID}"] ${selector}`);

/** A path of `fixes` hourly fixes ending `ageH` hours ago at lon/lat. */
function animal(
  study,
  name,
  taxon,
  ageH,
  lon,
  lat,
  { dLon = 0.08, dLat = 0, fixes = 8 } = {},
) {
  const now = Date.now();
  return {
    id: `${study}:${name}`,
    study,
    name,
    taxon,
    track: Array.from({ length: fixes }, (_, i) => {
      const back = fixes - 1 - i;
      return [
        Math.round((lon - back * dLon) * 1e5) / 1e5,
        Math.round((lat - back * dLat) * 1e5) / 1e5,
        now - (ageH + back) * 3_600_000,
      ];
    }),
  };
}

function fixture() {
  return {
    studies: [
      { id: GULLS, status: 'fresh', fetchedAt: Date.now() },
      { id: STORKS, status: 'fresh', fetchedAt: Date.now() },
      { id: SPOONBILLS, status: 'fresh', fetchedAt: Date.now() },
      { id: 2298738353, status: 'pending', fetchedAt: null },
      // Withdrawn: a (misbehaving) proxy still sending its animal.
      { id: WITHDRAWN, status: 'withdrawn', fetchedAt: null },
      // Not curated: dropped by the client sanitizer.
      { id: 16615296, status: 'fresh', fetchedAt: Date.now() },
    ],
    animals: [
      // Eastbound along the Scheldt estuary.
      animal(GULLS, 'EAST', 'Larus argentatus', 1, 4.2, 51.6),
      // Northbound.
      animal(GULLS, 'NORTH', 'Larus fuscus', 30, 3.3, 51.9, {
        dLon: 0,
        dLat: 0.06,
      }),
      // One fix only: a dot, not an arrow.
      animal(STORKS, 'AU057', 'Ciconia ciconia', 5, 8.4, 48.3, { fixes: 1 }),
      // The far side of the globe from a camera above Belgium.
      animal(GULLS, 'FAR', 'Larus argentatus', 2, -175, -40),
      // Belongs to the withdrawn study: the client drops it (fail closed).
      animal(WITHDRAWN, 'GONE', 'Larus argentatus', 1, 4.6, 51.4),
      // Outside the default one-year window.
      animal(SPOONBILLS, 'OLD', 'Platalea leucorodia', 400 * 24, 4.4, 51.2),
    ],
  };
}

/** Wait for the proxy's Movebank walk to finish, polling from Node. */
async function waitForWalk() {
  const started = Date.now();
  let body = null;
  while ((Date.now() - started) / 1000 < LIVE_TIMEOUT_S) {
    const response = await fetch(`${APP_URL}/api/wildlife`);
    body = await response.json();
    if (response.ok && body.pending.length === 0) break;
    await sleep(15_000);
  }
  return { body, seconds: Math.round((Date.now() - started) / 1000) };
}

async function main() {
  console.log('\nWildlife proof (qa-wildlife)');
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
    console.log('(i) LIVE — curated Movebank studies through /api/wildlife...');
    const walk = await waitForWalk();
    const ok = walk.body.studies.filter(({ status }) => status === 'fresh');
    record(
      'LIVE: the proxy walked every curated study, most answered',
      walk.body.studies.length === CURATED &&
        walk.body.pending.length === 0 &&
        ok.length >= CURATED - 2 &&
        walk.body.animals.length > 100,
      `after ${walk.seconds}s: served=${ok.length}/${walk.body.studies.length} animals=${walk.body.animals.length} statuses=${JSON.stringify(walk.body.studies.map(({ id, status }) => [id, status]))}`,
    );
    const newest = Math.max(
      ...walk.body.animals.map(({ track }) => track.at(-1)[2]),
    );
    note(
      'LIVE: newest public fix',
      `${new Date(newest).toISOString()} (${Math.round((Date.now() - newest) / 3_600_000)} h ago)`,
    );
    const live = await browser.newPage();
    await live.setViewport({ width: 1440, height: 900 });
    live.on('pageerror', (e) => errors.push(e.message));
    await boot(live, { lon: 5, lat: 47, height: 5_500_000 });
    const l = await enableAndSettle(live);
    const liveRow = await rowDom(live);
    record(
      'LIVE: glyphs and paths drawn for the last year, every study listed',
      !l.stats.error &&
        l.diagnostics.animals > 0 &&
        l.diagnostics.tracks > 0 &&
        liveRow.items.length === CURATED &&
        liveRow.pressed['window-year'] === 'true',
      `animals=${l.diagnostics.animals} tracks=${l.diagnostics.tracks} items=${liveRow.items.length} error=${JSON.stringify(l.stats.error)}`,
    );
    record(
      'LIVE: the row states the CC0 licence and a species legend',
      /CC0 · fixes may lag hours/.test(liveRow.info) &&
        liveRow.legend.length > 0 &&
        liveRow.chips[0] === 'movebank',
      `${liveRow.info} | legend=${JSON.stringify(liveRow.legend)}`,
    );
    await shoot(live, 'live-europe');
    await clickRow(live, `.data-row-list-item[data-list-item-id="${GULLS}"]`);
    await sleep(3000);
    const study = await rowDom(live);
    const firstAnimal = study.items[0];
    if (firstAnimal)
      await clickRow(
        live,
        `.data-row-list-item[data-list-item-id="${firstAnimal}"]`,
      );
    await sleep(4000);
    const picked = await rowDom(live);
    record(
      'LIVE: a study lists its animals and choosing one names it',
      Boolean(firstAnimal) &&
        study.chips.includes('doi') &&
        (await diagnostics(live)).selectedAnimal === firstAnimal &&
        /gull \S+ · .+ ago \(\d{4}-\d{2}-\d{2} \d{2}:\d{2} UTC\) · Gulls · Neeltje Jans · INBO/.test(
          picked.info,
        ),
      picked.info,
    );
    await shoot(live, 'live-animal');
    await live.close();

    // ── (ii) FIXTURE ──────────────────────────────────────────────────────
    console.log('\n(ii) FIXTURE — stubbed tracks through the real layer...');
    const page = await browser.newPage();
    await page.setViewport({ width: 1440, height: 900 });
    page.on('pageerror', (e) => errors.push(e.message));
    // Stub the route in-page rather than with request interception: an
    // intercepted page stalls Cesium's workers, so the globe never settles.
    await page.evaluateOnNewDocument((payload) => {
      const realFetch = window.fetch.bind(window);
      window.__wildlifeQaMode = 'fixture';
      window.__wildlifeQaOpened = [];
      window.open = (url) => {
        window.__wildlifeQaOpened.push(url);
        return null;
      };
      window.fetch = (input, init) => {
        const url = typeof input === 'string' ? input : input?.url || '';
        if (!url.includes('/api/wildlife')) return realFetch(input, init);
        const ok = window.__wildlifeQaMode === 'fixture';
        return Promise.resolve(
          new Response(
            JSON.stringify(
              ok
                ? { fetchedAt: Date.now(), ...payload, pending: [2298738353] }
                : { error: 'wildlife_unavailable' },
            ),
            {
              status: ok ? 200 : 502,
              headers: { 'Content-Type': 'application/json' },
            },
          ),
        );
      };
    }, fixture());
    await boot(page, { lon: 4.5, lat: 50.5, height: 1_600_000 });
    const f = await enableAndSettle(page);
    await sleep(1500);
    const drawn = await glyphs(page);
    record(
      'FIXTURE: 4 animals in the last year drawn, the old one, the withdrawn study and the uncurated study left off',
      f.diagnostics.animals === 4 &&
        !('OLD' in drawn) &&
        !('GONE' in drawn) &&
        f.diagnostics.studies.length === 5,
      `animals=${f.diagnostics.animals} glyphs=${Object.keys(drawn)} studies=${f.diagnostics.studies.length}`,
    );
    const listed = await rowDom(page);
    record(
      'FIXTURE: a withdrawn study is listed as no longer public, not as current',
      /no longer public$/.test(listed.itemText[String(WITHDRAWN)] || ''),
      JSON.stringify(listed.itemText[String(WITHDRAWN)]),
    );
    record(
      'FIXTURE: the far-side glyph is hidden, the near ones shown',
      drawn.FAR?.show === false &&
        drawn.EAST?.show === true &&
        drawn.NORTH?.show === true,
      JSON.stringify(drawn),
    );
    record(
      'FIXTURE: arrows point along the last move (east → right, north → up)',
      Math.abs(drawn.EAST?.rotation + Math.PI / 2) < 0.15 &&
        Math.abs(drawn.NORTH?.rotation) < 0.15 &&
        drawn.AU057?.rotation === 0,
      `east=${drawn.EAST?.rotation?.toFixed(3)} north=${drawn.NORTH?.rotation?.toFixed(3)} dot=${drawn.AU057?.rotation}`,
    );
    const pending = await rowDom(page);
    record(
      'FIXTURE: a study still on its way from Movebank is named',
      /Fetching 1 study from Movebank/.test(pending.info),
      pending.info,
    );
    await shoot(page, 'fixture');

    const glyph = await glyphOnScreen(page, `${GULLS}:EAST`);
    if (glyph) await page.mouse.click(glyph.x, glyph.y);
    await sleep(800);
    const chosen = await rowDom(page);
    record(
      'FIXTURE: a globe click on a glyph names species, study, owner and last fix',
      glyph !== null &&
        (await diagnostics(page)).selectedAnimal === `${GULLS}:EAST` &&
        /^Herring gull EAST · 1 h ago \(.+ UTC\) · Gulls · Neeltje Jans · INBO/.test(
          chosen.info,
        ) &&
        chosen.activeItems.join() === `${GULLS}:EAST`,
      `glyph=${JSON.stringify(glyph)} info=${JSON.stringify(chosen.info)}`,
    );
    await shoot(page, 'selected');
    await clickRow(page, '[data-chip-id="doi"]');
    await sleep(200);
    const opened = await page.evaluate(() => window.__wildlifeQaOpened);
    record(
      'FIXTURE: the DOI chip opens the published dataset',
      opened.at(-1) === 'https://doi.org/10.5281/zenodo.10209520',
      JSON.stringify(opened),
    );
    await clickRow(page, '[data-chip-id="studies"]');
    await clickRow(page, '[data-chip-id="window-all"]');
    await sleep(500);
    const all = await diagnostics(page);
    await clickRow(page, '[data-chip-id="window-month"]');
    await sleep(500);
    const month = await diagnostics(page);
    const monthRow = await rowDom(page);
    record(
      'FIXTURE: All time adds the old animal; 30 days keeps the recent ones',
      all.animals === 5 &&
        month.animals === 4 &&
        monthRow.pressed['window-month'] === 'true' &&
        monthRow.pressed['window-year'] === 'false',
      `all=${all.animals} month=${month.animals}`,
    );

    // ── (iii) FAILURE ─────────────────────────────────────────────────────
    console.log('\n(iii) FAILURE — /api/wildlife stubbed to 502...');
    await page.evaluate(() => {
      window.__wildlifeQaMode = 'error';
    });
    const e = await enableAndSettle(page, { refresh: true, timeoutS: 3 });
    const broken = await rowDom(page);
    record(
      'FAILURE: error surfaced, glyphs kept, row says so',
      Boolean(e.stats.error) &&
        e.diagnostics.animals === 4 &&
        /Refresh failed: Tracking proxy error \(HTTP 502\)/.test(broken.info),
      `error=${JSON.stringify(e.stats.error)} animals=${e.diagnostics.animals} info=${JSON.stringify(broken.info)}`,
    );

    // ── (iv) DISABLE ──────────────────────────────────────────────────────
    console.log('\n(iv) DISABLE...');
    await page.evaluate((id) => {
      window.__wildlifeQaMode = 'fixture';
      window.__godsEyeView.dataManager.layers
        .get(id)
        .module.setParams({ animal: `${1258895879}:EAST` });
    }, LAYER_ID);
    const shown = await page.evaluate(async (id) => {
      await window.__godsEyeView.dataManager.setEnabled(id, false);
      return window.__godsEyeView.viewer.dataSources.getByName(id)[0]?.show;
    }, LAYER_ID);
    const off = await diagnostics(page);
    record(
      'DISABLE: data source hidden, selection and selection handler released',
      shown === false &&
        off.selectedAnimal === null &&
        !off.selectionActive &&
        !off.horizonCulling,
      `show=${shown} ${JSON.stringify(off)}`,
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
  console.log(`  Shots : ${SHOTS_DIR}/wildlife-*.png`);
  console.log('─'.repeat(60) + '\n');
  process.exit(exitCode || (fail > 0 ? 1 : 0));
}

main().catch((e) => {
  console.error(e);
  process.exit(3);
});
