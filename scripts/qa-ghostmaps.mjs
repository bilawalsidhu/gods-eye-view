#!/usr/bin/env node
/**
 * qa-ghostmaps.mjs — headless proof for the S2 Underground GhostMaps layer
 * (id `s2-ghostmaps`): S2's public KMZ intel products, kept current from
 * github.com/s2underground/GhostMaps.
 *
 * Drives the REAL app in headless Chromium against a dev server (keyless).
 *
 *   (i)   LIVE — enabling the layer loads the default products (Common
 *         Intelligence Picture and the 30-day kinetic pull) from the live
 *         repository through /api/ghostmaps, one data source per product,
 *         matching the proxy's catalog commit; the row shows one chip per
 *         catalog product with the defaults active, and the page holds an
 *         open event stream to /api/ghostmaps/events.
 *   (ii)  PICK — a Common Intelligence Picture marker at the screen centre
 *         picks as this layer's entity; clicking it paints its report card
 *         and clicking empty ground clears it.
 *   (iii) PUSH (synthetic) — the event stream is replaced in the page and a
 *         catalog naming a new edition of one product is pushed: only that
 *         product reloads (a new data source replaces the old one, no
 *         duplicates), the other keeps its data source. A catalog without a
 *         product removes it.
 *   (iv)  CHIPS — clicking an active product chip removes that product,
 *         clicking it again restores it; the choice survives a reload.
 *   (v)   DISABLE — every GhostMaps data source leaves the viewer.
 *   (vi)  VIEWPORT — at a 390x844 phone viewport the open row and its chips
 *         fit the panel width with no horizontal overflow.
 *   (vii) FAR SIDE — pins skip the depth test, so they are horizon-culled:
 *         seen from over the Indian Ocean no pin clearly behind the planet is
 *         shown; back over North America the near-side pins show again.
 *
 * Screenshots go to qa-shots/ghostmaps-*.png (gitignored).
 *
 * Run:  node scripts/qa-ghostmaps.mjs --url http://localhost:4173
 * Optional: --timeout-ms 180000 for a slow boot, --shots <dir>.
 * Exits non-zero on any FAIL. Does not commit anything.
 */

import puppeteer from 'puppeteer';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const argv = process.argv.slice(2);
const getOpt = (name, dflt) => {
  const i = argv.indexOf(name);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : dflt;
};
const APP_URL = getOpt('--url', 'http://localhost:4173');
const HEADFUL = argv.includes('--headful');
const TIMEOUT_MS = Number(getOpt('--timeout-ms', '90000'));
const SHOTS_DIR = path.resolve(
  getOpt('--shots', path.join(__dirname, '..', 'qa-shots')),
);
const LAYER_ID = 's2-ghostmaps';

const results = [];
function record(name, ok, detail) {
  results.push({ name, ok, detail });
  const tag = ok ? '\x1b[32mPASS\x1b[0m' : '\x1b[31mFAIL\x1b[0m';
  console.log(`  [${tag}] ${name}${detail ? `  — ${detail}` : ''}`);
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function boot(page) {
  await page.goto(`${APP_URL}/?welcome=0`, {
    waitUntil: 'domcontentloaded',
    timeout: TIMEOUT_MS,
  });
  await page.waitForFunction(
    () => window.__godsEyeView?.viewer && window.__godsEyeView?.dataManager,
    { timeout: TIMEOUT_MS },
  );
  await sleep(5000);
  await page.keyboard.press('Escape');
}

/** GhostMaps data sources on the viewer: name → entity count. */
function ghostSources(prefix) {
  const { dataSources } = window.__godsEyeView.viewer;
  const out = [];
  for (let i = 0; i < dataSources.length; i++) {
    const ds = dataSources.get(i);
    if (ds.name?.startsWith(prefix))
      out.push({ name: ds.name, count: ds.entities.values.length });
  }
  return out;
}

function paintedOverlayPixels() {
  const canvas = document.getElementById('world-overlay-canvas');
  if (!canvas) return -1;
  const pixels = canvas
    .getContext('2d')
    .getImageData(0, 0, canvas.width, canvas.height).data;
  let count = 0;
  for (let i = 3; i < pixels.length; i += 4) if (pixels[i] > 0) count++;
  return count;
}

async function enableAndSettle(page) {
  await page.evaluate((id) => {
    const panel = document.getElementById('data-panel');
    if (panel?.classList.contains('collapsed'))
      panel.querySelector('[data-collapse-target="data-panel"]')?.click();
    return window.__godsEyeView.dataManager.setEnabled(id, true);
  }, LAYER_ID);
  await page.waitForFunction(
    (id) => {
      const stats = window.__godsEyeView.dataManager.layers
        .get(id)
        .module.getStats();
      return !stats.loading && stats.count > 0;
    },
    { timeout: TIMEOUT_MS, polling: 500 },
    LAYER_ID,
  );
}

const stats = (page) =>
  page.evaluate(
    (id) => window.__godsEyeView.dataManager.layers.get(id).module.getStats(),
    LAYER_ID,
  );
const sources = (page) =>
  page.evaluate(`(${ghostSources})(${JSON.stringify(`${LAYER_ID}:`)})`);

async function showRow(page) {
  await page.evaluate((id) => {
    document
      .querySelector(`[data-layer-id="${id}"]`)
      ?.scrollIntoView({ block: 'center' });
  }, LAYER_ID);
  await sleep(400);
}

async function main() {
  fs.mkdirSync(SHOTS_DIR, { recursive: true });
  const browser = await puppeteer.launch({
    headless: !HEADFUL,
    args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'],
    defaultViewport: { width: 1440, height: 900 },
  });
  try {
    // ---- (i) LIVE ---------------------------------------------------------
    const page = await browser.newPage();
    // Start clean once; a reload must keep what the page stored.
    await page.evaluateOnNewDocument(() => {
      try {
        if (sessionStorage.getItem('qa-ghostmaps-clean')) return;
        localStorage.clear();
        sessionStorage.setItem('qa-ghostmaps-clean', '1');
      } catch {
        /* sandboxed frames have no storage */
      }
    });
    page.on('pageerror', (error) =>
      console.log(`  [page error] ${error.message}`),
    );
    await boot(page);
    const catalog = await page.evaluate(() =>
      fetch('/api/ghostmaps/catalog').then((r) => r.json()),
    );
    record(
      'LIVE: proxy catalog names a commit and the default products',
      /^[0-9a-f]{40}$/.test(catalog.commit || '') &&
        ['cip', 'kinetic-30d'].every((id) =>
          catalog.products.some((p) => p.id === id && p.defaultOn),
        ),
      `${catalog.commit?.slice(0, 7)} "${catalog.message}", ${catalog.products.length} products`,
    );
    const t0 = Date.now();
    await enableAndSettle(page);
    const live = await stats(page);
    const liveSources = await sources(page);
    record(
      'LIVE: default products load as one data source each',
      liveSources.length === 2 &&
        liveSources.every((s) => s.count > 0) &&
        live.products.sort().join() === 'cip,kinetic-30d',
      `${liveSources.map((s) => `${s.name}=${s.count}`).join(', ')} in ${Date.now() - t0} ms`,
    );
    record(
      'LIVE: layer reports the proxy commit and no error',
      live.commit === catalog.commit && !live.error,
      `commit ${live.commit?.slice(0, 7)}, error ${live.error}`,
    );
    await showRow(page);
    const chips = await page.evaluate(
      (id) =>
        [
          ...document.querySelectorAll(
            `[data-layer-id="${id}"] .data-toggle-chip`,
          ),
        ].map((chip) => ({
          id: chip.dataset.chipId,
          active: chip.getAttribute('aria-pressed') === 'true',
        })),
      LAYER_ID,
    );
    record(
      'LIVE: one chip per product, defaults pressed',
      chips.length === catalog.products.length &&
        chips.every(
          (chip) =>
            chip.active ===
            catalog.products.find((p) => p.id === chip.id)?.defaultOn,
        ),
      chips.map((c) => `${c.id}${c.active ? '*' : ''}`).join(' '),
    );
    const stream = await page
      .waitForFunction(
        (id) =>
          window.__godsEyeView.dataManager.layers.get(id).module.getStats()
            .stream === 'open',
        { timeout: 15000, polling: 250 },
        LAYER_ID,
      )
      .then(
        () => true,
        () => false,
      );
    record('LIVE: the /api/ghostmaps/events stream is open', stream);
    await page.screenshot({ path: path.join(SHOTS_DIR, 'ghostmaps-live.png') });

    // ---- (ii) PICK ----------------------------------------------------------
    const target = await page.evaluate((id) => {
      const gev = window.__godsEyeView;
      const ds = [...Array(gev.viewer.dataSources.length).keys()]
        .map((i) => gev.viewer.dataSources.get(i))
        .find((item) => item.name === `${id}:cip`);
      const entity = ds.entities.values.find((e) => e.billboard);
      const carto = gev.viewer.scene.globe.ellipsoid.cartesianToCartographic(
        entity.position.getValue(gev.viewer.clock.currentTime),
      );
      try {
        gev.viewer.camera.cancelFlight();
      } catch {
        /* no flight */
      }
      gev.viewer.camera.setView({
        destination: gev.viewer.scene.globe.ellipsoid.cartographicToCartesian({
          longitude: carto.longitude,
          latitude: carto.latitude,
          height: 40000,
        }),
        orientation: { heading: 0, pitch: -Math.PI / 2, roll: 0 },
      });
      gev.viewer.scene.requestRender?.();
      return entity.id;
    }, LAYER_ID);
    await page
      .waitForFunction(
        () => window.__godsEyeView.viewer.scene.globe.tilesLoaded,
        { timeout: 30000 },
      )
      .catch(() => {});
    // The horizon cull reveals the pin on the frame after the camera moves.
    await page
      .waitForFunction(
        () => {
          const v = window.__godsEyeView.viewer;
          v.scene.requestRender?.();
          const c = v.scene.canvas;
          return v.scene
            .drillPick({ x: c.clientWidth / 2, y: c.clientHeight / 2 }, 8)
            .some((p) =>
              String(p?.id?.id ?? p?.id ?? '').startsWith('ghostmaps:cip:'),
            );
        },
        { timeout: 15000, polling: 500 },
      )
      .catch(() => {});
    const probe = await page.evaluate(() => {
      const v = window.__godsEyeView.viewer;
      const c = v.scene.canvas;
      const box = c.getBoundingClientRect();
      const centre = { x: c.clientWidth / 2, y: c.clientHeight / 2 };
      const picked = v.scene.drillPick(centre, 8);
      // Empty ground: the first point below the marker (the card is drawn
      // above it) that picks nothing at all; markers can be dense in a city.
      let empty = null;
      for (let r = 120; r < 420 && !empty; r += 60)
        for (const a of [2, 1, 3, 0, 4]) {
          const p = {
            x: centre.x + r * Math.cos((a * Math.PI) / 4),
            y: centre.y + r * Math.sin((a * Math.PI) / 4),
          };
          if (!v.scene.pick(p)) {
            empty = p;
            break;
          }
        }
      empty ||= { x: centre.x + 400, y: centre.y + 300 };
      return {
        ids: picked.map((p) => String(p?.id?.id ?? p?.id ?? '')),
        centre: { x: centre.x + box.left, y: centre.y + box.top },
        empty: { x: empty.x + box.left, y: empty.y + box.top },
      };
    });
    record(
      'PICK: the centred marker picks as a GhostMaps entity',
      probe.ids.some((id) => id.startsWith('ghostmaps:cip:')),
      `${target} → [${probe.ids.slice(0, 3).join(', ')}]`,
    );
    const before = await page.evaluate(paintedOverlayPixels);
    await page.mouse.click(probe.centre.x, probe.centre.y);
    const painted = await page
      .waitForFunction(`(${paintedOverlayPixels})() > ${before + 100}`, {
        timeout: 10000,
        polling: 250,
      })
      .then(
        () => true,
        () => false,
      );
    const after = await page.evaluate(paintedOverlayPixels);
    record(
      'PICK: clicking the marker paints its report card',
      painted,
      `${before} → ${after} pixels`,
    );
    await page.screenshot({ path: path.join(SHOTS_DIR, 'ghostmaps-card.png') });
    const cardState = () =>
      page.evaluate((id) => {
        const d = window.__gevWorldOverlay?.getDiagnostics?.();
        return {
          entries: d?.entriesBySource?.[id] ?? null,
          painted: d?.paintedBySource?.[id] ?? null,
        };
      }, LAYER_ID);
    const selectedState = await cardState();
    record(
      'PICK: the overlay host holds and paints exactly one card',
      selectedState.entries === 1 && selectedState.painted === 1,
      JSON.stringify(selectedState),
    );
    await page.mouse.click(probe.empty.x, probe.empty.y);
    // The overlay canvas is `desynchronized`, so headless read-back can
    // return a stale buffer; the host's own model is the authority here.
    const cleared = await page
      .waitForFunction(
        (id) => {
          const d = window.__gevWorldOverlay.getDiagnostics();
          return (
            d.entriesBySource?.[id] === 0 && !(d.paintedBySource?.[id] > 0)
          );
        },
        { timeout: 10000, polling: 250 },
        LAYER_ID,
      )
      .then(
        () => true,
        () => false,
      );
    record(
      'PICK: clicking empty ground clears the card',
      cleared,
      JSON.stringify(await cardState()),
    );

    // ---- (vii) FAR SIDE ---------------------------------------------------
    // Pins skip the depth test; with Google 3D tiles nothing else hides the
    // far side. A pin clearly behind the planet (sphere test with margin) must
    // be hidden, and pins facing the camera must still show.
    const horizonCounts = (lon, lat) =>
      page.evaluate(
        async (id, lo, la) => {
          const gev = window.__godsEyeView;
          const d2r = Math.PI / 180;
          try {
            gev.viewer.camera.cancelFlight();
          } catch {
            /* no flight */
          }
          gev.viewer.camera.setView({
            destination:
              gev.viewer.scene.globe.ellipsoid.cartographicToCartesian({
                longitude: lo * d2r,
                latitude: la * d2r,
                height: 18_000_000,
              }),
            orientation: { heading: 0, pitch: -Math.PI / 2, roll: 0 },
          });
          gev.viewer.scene.requestRender?.();
          await new Promise((r) => setTimeout(r, 1200));
          const c = gev.viewer.camera.positionWC;
          const norm = (v) => Math.hypot(v.x, v.y, v.z);
          let far = 0;
          let nearShown = 0;
          for (let i = 0; i < gev.viewer.dataSources.length; i++) {
            const ds = gev.viewer.dataSources.get(i);
            if (!ds.name?.startsWith(`${id}:`)) continue;
            for (const e of ds.entities.values) {
              if (!e.billboard) continue;
              const p = e.position.getValue(gev.viewer.clock.currentTime);
              // Angle from the camera's nadir to the pin, against the
              // geometric horizon angle; the cull's 1 km margin shows pins up
              // to about 1° past it, so "clearly behind" is beyond 2°.
              const angle = Math.acos(
                (p.x * c.x + p.y * c.y + p.z * c.z) / (norm(p) * norm(c)),
              );
              const horizon = Math.acos(norm(p) / norm(c));
              const margin = (2 * Math.PI) / 180;
              if (e.show && angle > horizon + margin) far++;
              if (e.show && angle < horizon - margin) nearShown++;
            }
          }
          return { far, nearShown };
        },
        LAYER_ID,
        lon,
        lat,
      );
    const fromIndianOcean = await horizonCounts(80, -30);
    record(
      'FAR SIDE: pins behind the planet are hidden',
      fromIndianOcean.far === 0,
      JSON.stringify(fromIndianOcean),
    );
    await page.screenshot({
      path: path.join(SHOTS_DIR, 'ghostmaps-far-side.png'),
    });
    const fromAmerica = await horizonCounts(-98, 39);
    record(
      'FAR SIDE: pins facing the camera show again',
      fromAmerica.far === 0 && fromAmerica.nearShown > 100,
      JSON.stringify(fromAmerica),
    );

    // ---- (iv) CHIPS -------------------------------------------------------
    const clickChip = async (id) => {
      // Row controls render on the next frame after the layer settles.
      await page.waitForSelector(
        `[data-layer-id="${LAYER_ID}"] .data-toggle-chip[data-chip-id="${id}"]`,
        { timeout: 15000 },
      );
      return page.evaluate(
        (layer, chip) =>
          document
            .querySelector(
              `[data-layer-id="${layer}"] .data-toggle-chip[data-chip-id="${chip}"]`,
            )
            ?.click(),
        LAYER_ID,
        id,
      );
    };
    await clickChip('kinetic-30d');
    await page.waitForFunction(
      (id) =>
        !window.__godsEyeView.dataManager.layers
          .get(id)
          .module.getStats()
          .products.includes('kinetic-30d'),
      { timeout: 15000 },
      LAYER_ID,
    );
    const without = await sources(page);
    record(
      'CHIPS: turning a product off removes only its data source',
      without.length === 1 && without[0].name === `${LAYER_ID}:cip`,
      without.map((s) => s.name).join(', '),
    );
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => window.__godsEyeView?.dataManager, {
      timeout: TIMEOUT_MS,
    });
    await sleep(3000);
    await enableAndSettle(page);
    const kept = await stats(page);
    record(
      'CHIPS: the product choice survives a reload',
      kept.products.join() === 'cip',
      kept.products.join(', '),
    );
    await showRow(page);
    await clickChip('kinetic-30d');
    await page.waitForFunction(
      (id) =>
        window.__godsEyeView.dataManager.layers
          .get(id)
          .module.getStats()
          .products.includes('kinetic-30d'),
      { timeout: 30000 },
      LAYER_ID,
    );
    record(
      'CHIPS: turning it back on restores it',
      (await sources(page)).length === 2,
    );

    // ---- (v) DISABLE ------------------------------------------------------
    await page.evaluate(
      (id) => window.__godsEyeView.dataManager.setEnabled(id, false),
      LAYER_ID,
    );
    await sleep(500);
    record(
      'DISABLE: every GhostMaps data source leaves the viewer',
      (await sources(page)).length === 0,
    );
    await page.close();

    // ---- (iii) PUSH (synthetic) ----------------------------------------------
    const push = await browser.newPage();
    await push.evaluateOnNewDocument(() => {
      localStorage.clear();
      // A controllable stand-in for the real stream.
      class QaEventSource {
        constructor(url) {
          this.url = url;
          this.listeners = new Set();
          (window.__qaStreams ||= []).push(this);
        }
        addEventListener(type, listener) {
          if (type === 'catalog') this.listeners.add(listener);
        }
        removeEventListener(type, listener) {
          this.listeners.delete(listener);
        }
        close() {
          this.closed = true;
        }
        emit(catalog) {
          for (const listener of this.listeners)
            listener({ data: JSON.stringify(catalog) });
        }
      }
      window.EventSource = QaEventSource;
    });
    await boot(push);
    await enableAndSettle(push);
    const identity = () =>
      push.evaluate((id) => {
        const { dataSources } = window.__godsEyeView.viewer;
        window.__qaIds ||= new WeakMap();
        window.__qaNext ||= 1;
        const out = {};
        for (let i = 0; i < dataSources.length; i++) {
          const ds = dataSources.get(i);
          if (!ds.name?.startsWith(`${id}:`)) continue;
          if (!window.__qaIds.has(ds))
            window.__qaIds.set(ds, window.__qaNext++);
          out[ds.name] = window.__qaIds.get(ds);
        }
        return out;
      }, LAYER_ID);
    const first = await identity();
    const pushed = Date.now();
    await push.evaluate(async (id) => {
      const catalog = await fetch('/api/ghostmaps/catalog').then((r) =>
        r.json(),
      );
      const kinetic = catalog.products.find((p) => p.id === 'kinetic-30d');
      kinetic.version = 'f'.repeat(40);
      catalog.message = 'QA push';
      window.__qaStreams
        .filter((s) => !s.closed)
        .forEach((s) => s.emit(catalog));
    }, LAYER_ID);
    await push.waitForFunction(
      (id) => {
        const layer = window.__godsEyeView.dataManager.layers.get(id).module;
        return (
          !layer.getStats().loading &&
          layer.getRowControls().info.includes('QA push')
        );
      },
      { timeout: 20000, polling: 100 },
      LAYER_ID,
    );
    await sleep(500);
    const second = await identity();
    record(
      'PUSH: a new edition reloads only that product',
      Object.keys(second).length === 2 &&
        second[`${LAYER_ID}:kinetic-30d`] !==
          first[`${LAYER_ID}:kinetic-30d`] &&
        second[`${LAYER_ID}:cip`] === first[`${LAYER_ID}:cip`],
      `${JSON.stringify(first)} → ${JSON.stringify(second)} in ${Date.now() - pushed} ms`,
    );
    await push.evaluate(async () => {
      const catalog = await fetch('/api/ghostmaps/catalog').then((r) =>
        r.json(),
      );
      catalog.products = catalog.products.filter((p) => p.id !== 'kinetic-30d');
      window.__qaStreams
        .filter((s) => !s.closed)
        .forEach((s) => s.emit(catalog));
    });
    await sleep(1000);
    const third = await identity();
    record(
      'PUSH: a product leaving the catalog leaves the globe',
      Object.keys(third).join() === `${LAYER_ID}:cip`,
      Object.keys(third).join(', '),
    );
    await push.close();

    // ---- (vi) VIEWPORT ----------------------------------------------------
    const phone = await browser.newPage();
    await phone.setViewport({ width: 390, height: 844, isMobile: true });
    await phone.evaluateOnNewDocument(() => localStorage.clear());
    await boot(phone);
    await enableAndSettle(phone);
    await showRow(phone);
    const fit = await phone.evaluate((id) => {
      const row = document.querySelector(`[data-layer-id="${id}"]`);
      const panel = document.getElementById('data-panel');
      const controls = row?.querySelector('.data-toggle-controls');
      return {
        row: Boolean(row),
        overflow: controls ? controls.scrollWidth - controls.clientWidth : -1,
        pageOverflow:
          document.documentElement.scrollWidth -
          document.documentElement.clientWidth,
        panelRight: panel?.getBoundingClientRect().right,
        width: window.innerWidth,
      };
    }, LAYER_ID);
    record(
      'VIEWPORT: chips fit the phone-width panel',
      fit.row && fit.overflow <= 1 && fit.pageOverflow <= 0,
      JSON.stringify(fit),
    );
    await phone.screenshot({
      path: path.join(SHOTS_DIR, 'ghostmaps-phone.png'),
    });
    await phone.close();
  } finally {
    await browser.close();
  }
  const failed = results.filter((r) => !r.ok);
  console.log(
    `\n${results.length - failed.length}/${results.length} passed. Screenshots: ${SHOTS_DIR}`,
  );
  process.exit(failed.length ? 1 : 0);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
