#!/usr/bin/env node
// Cesium-only probes: native primitive failure injection tests the Cesium paint path.
import { evaluateWithGeo } from './qa/geometry.mjs';
import { whenSettled, whenFramesDrawn, whenTilesLoaded } from './qa/ready.mjs';
/**
 * qa-ghostmaps.mjs — headless proof for the S2 Underground GhostMaps layer
 * (id `s2-ghostmaps`): S2's public KMZ intel products, kept current from
 * github.com/s2underground/GhostMaps.
 *
 * Drives the REAL app in headless Chromium against a dev server (keyless).
 *
 *   (i)   LIVE — enabling the layer loads the default products (Common
 *         Intelligence Picture and the 30-day kinetic pull) from the live
 *         repository through /api/ghostmaps, one drawn edition per product
 *         (its globe-contract sets),
 *         matching the proxy's catalog commit; the row shows one chip per
 *         catalog product with the defaults active, and the page holds an
 *         open event stream to /api/ghostmaps/events.
 *   (ii)  PICK — a Common Intelligence Picture marker at the screen centre
 *         picks as this layer's entity; clicking it paints its report card
 *         and clicking empty ground clears it.
 *   (iii) PUSH (synthetic) — the event stream is replaced in the page and a
 *         catalog naming a new edition of one product is pushed: only that
 *         product reloads (a new edition replaces the old one, no
 *         duplicates), the other keeps its edition. A catalog without a
 *         product removes it.
 *   (iv)  CHIPS — clicking an active product chip removes that product,
 *         clicking it again restores it; the choice survives a reload.
 *   (v)   DISABLE — every GhostMaps set leaves the globe.
 *   (vi)  VIEWPORT — at a 390x844 phone viewport the open row and its chips
 *         fit the panel width with no horizontal overflow.
 *   (vii) FAR SIDE — pins skip the depth test, so they are horizon-culled:
 *         seen from over the Indian Ocean no pin clearly behind the planet is
 *         shown; back over North America the near-side pins show again.
 *   (viii) AGE — seven days is the default; shorter/longer windows and All
 *         markers update the globe, and the age choice survives a reload.
 *
 * Screenshots go to qa-shots/ghostmaps-*.png (gitignored).
 *
 * Run:  node scripts/qa-ghostmaps.mjs --url http://localhost:4173
 * Optional: --timeout-ms 180000 for a slow boot, --shots <dir>.
 * Exits non-zero on any FAIL. Does not commit anything.
 */

import { launchBrowser, closeBrowser } from './qa/browser.mjs';
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

async function boot(page) {
  await page.goto(`${APP_URL}/?welcome=0`, {
    waitUntil: 'domcontentloaded',
    timeout: TIMEOUT_MS,
  });
  await page.waitForFunction(
    () => window.__godsEyeView?.engine && window.__godsEyeView?.dataManager,
    { timeout: TIMEOUT_MS },
  );
  await whenSettled(page);
  await whenFramesDrawn(page);
  await page.keyboard.press('Escape');
}

/**
 * GhostMaps product editions on the globe contract: one row per drawn
 * edition, as one data source per product used to be. The display
 * (render/display.js) gives each edition three sets named
 * `${prefix}${productId}:${edition}:{polygons,lines,pins}`; `count` sums their
 * items.
 */
function ghostSources(prefix) {
  const { engine } = window.__godsEyeView;
  const editions = new Map();
  for (const set of [...engine.ground.list(), ...engine.movers.list()]) {
    if (!set.id.startsWith(prefix)) continue;
    const [productId, edition] = set.id.slice(prefix.length).split(':');
    const key = `${productId}:${edition}`;
    const row = editions.get(key) || {
      name: `${prefix}${productId}`,
      edition: Number(edition),
      count: 0,
    };
    row.count += set.count;
    editions.set(key, row);
  }
  return [...editions.values()];
}

/**
 * The drawn placemarks of the GhostMaps sprite sets (`...:pins`), from the
 * Cesium engine's own billboards for those sets (the contract has no
 * per-instance read-back): { id, show, position } each.
 */
function ghostPins(prefix) {
  const gev = window.__godsEyeView;
  const counts = new Map(
    gev.engine.movers.list().map((set) => [set.id, set.count]),
  );
  const out = [];
  const walk = (collection, depth) => {
    for (let i = 0; i < (collection?.length || 0); i++) {
      const primitive = collection.get(i);
      const setId = primitive?.gevMoverSet;
      if (typeof setId === 'string') {
        if (!setId.startsWith(prefix) || !setId.endsWith(':pins')) continue;
        const count = Math.min(counts.get(setId) ?? 0, primitive.length);
        for (let j = 0; j < count; j++) {
          const billboard = primitive.get(j);
          out.push({
            set: setId,
            id: String(billboard.id),
            show: billboard.show,
            position: billboard.position,
          });
        }
      } else if (depth < 3 && typeof primitive?.get === 'function')
        walk(primitive, depth + 1);
    }
  };
  walk(gev.viewer.scene.primitives, 0);
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
// Installs ghostPins() in the page (the evaluate callbacks below call it).
const installPins = (page) =>
  page.evaluate(`window.__qaGhostPins = ${ghostPins}`);

async function showRow(page) {
  await page.evaluate((id) => {
    document
      .querySelector(`[data-layer-id="${id}"]`)
      ?.scrollIntoView({ block: 'center' });
  }, LAYER_ID);
  await whenFramesDrawn(page);
}

async function main() {
  fs.mkdirSync(SHOTS_DIR, { recursive: true });
  const browser = await launchBrowser({
    headless: true,
    args: ['--enable-unsafe-swiftshader'],
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

    const ageChips = await page.evaluate(
      (id) =>
        [
          ...document.querySelectorAll(
            `[data-layer-id="${id}"] [data-segmented-id="age"] [role="radio"]`,
          ),
        ].map((option) => ({
          id: option.dataset.chipId,
          active: option.getAttribute('aria-checked') === 'true',
        })),
      LAYER_ID,
    );
    record(
      'AGE: seven days is the default with an All markers option',
      live.ageDays === 7 &&
        ageChips.length === 6 &&
        ageChips
          .filter((chip) => chip.active)
          .map((chip) => chip.id)
          .join() === 'age-7' &&
        ageChips.some((chip) => chip.id === 'age-all'),
    );
    const selectAge = async (days) => {
      await showRow(page);
      const selector = `[data-layer-id="${LAYER_ID}"] [data-chip-id="age-${days ?? 'all'}"]`;
      await page.waitForSelector(selector, { timeout: 15000 });
      // Dispatch through the rendered button, matching the product-chip gate.
      await page.$eval(selector, (button) => button.click());
      await page.waitForFunction(
        (id, age) => {
          const s = window.__godsEyeView.dataManager.layers
            .get(id)
            .module.getStats();
          return s.ageDays === age && !s.loading;
        },
        { timeout: TIMEOUT_MS },
        LAYER_ID,
        days,
      );
      return stats(page);
    };
    const all = await selectAge(null);
    record(
      'AGE: All markers restores old events without duplicate data sources',
      all.count > live.count &&
        (await sources(page)).length === live.products.length,
      `${live.count} → ${all.count}`,
    );
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => window.__godsEyeView?.dataManager, {
      timeout: TIMEOUT_MS,
    });
    await whenSettled(page);
    await enableAndSettle(page);
    const persistedAge = await stats(page);
    record(
      'AGE: All markers survives a reload',
      persistedAge.ageDays === null && persistedAge.count === all.count,
    );
    const thirty = await selectAge(30);
    const one = await selectAge(1);
    const seven = await selectAge(7);
    record(
      'AGE: counts follow the window order and seven days restores the default',
      one.count <= live.count &&
        thirty.count >= live.count &&
        thirty.count <= all.count &&
        seven.count === live.count &&
        seven.ageDays === 7,
      `1d=${one.count}, 7d=${seven.count}, 30d=${thirty.count}, all=${all.count}`,
    );

    // ---- (ii) PICK ----------------------------------------------------------
    await installPins(page);
    const target = await evaluateWithGeo(
      page,
      async (qaGeo, id) => {
        const pin = window.__qaGhostPins(`${id}:cip:`)[0];
        const carto = qaGeo.cartographic.fromCartesian(pin.position);
        try {
          window.__godsEyeView.engine.camera.cancelFlight();
        } catch {
          /* no flight */
        }
        window.__godsEyeView.engine.camera.setView({
          destination: qaGeo.cartographic.toCartesian({
            longitude: carto.longitude,
            latitude: carto.latitude,
            height: 40000,
          }),
          orientation: { heading: 0, pitch: -Math.PI / 2, roll: 0 },
        });
        window.__godsEyeView.engine.render.request?.();
        return pin.id;
      },
      LAYER_ID,
    );
    await whenTilesLoaded(page, { timeoutMs: 30000 }).catch(() => {});
    await whenSettled(page);
    // The horizon cull reveals the pin on the frame after the camera moves.
    await page
      .waitForFunction(
        () => {
          const { engine } = window.__godsEyeView;
          window.__godsEyeView.engine.render.request?.();
          const c = window.__godsEyeView.engine.host.canvas;
          return engine.picker
            .drillPick({ x: c.clientWidth / 2, y: c.clientHeight / 2 }, 8)
            .some((p) => String(p?.id ?? '').startsWith('ghostmaps:cip:'));
        },
        { timeout: 15000, polling: 500 },
      )
      .catch(() => {});
    const probe = await page.evaluate(() => {
      const { engine } = window.__godsEyeView;
      const c = window.__godsEyeView.engine.host.canvas;
      const box = c.getBoundingClientRect();
      const centre = { x: c.clientWidth / 2, y: c.clientHeight / 2 };
      const picked = engine.picker.drillPick(centre, 8);
      // Empty ground: the first point below the marker (the card is drawn
      // above it) that picks nothing at all; markers can be dense in a city.
      let empty = null;
      for (let r = 120; r < 420 && !empty; r += 60)
        for (const a of [2, 1, 3, 0, 4]) {
          const p = {
            x: centre.x + r * Math.cos((a * Math.PI) / 4),
            y: centre.y + r * Math.sin((a * Math.PI) / 4),
          };
          if (engine.picker.pick(p)?.id == null) {
            empty = p;
            break;
          }
        }
      empty ||= { x: centre.x + 400, y: centre.y + 300 };
      return {
        ids: picked.map((p) => String(p?.id ?? '')),
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
      evaluateWithGeo(
        page,
        async (qaGeo, id, lo, la) => {
          const d2r = Math.PI / 180;
          try {
            window.__godsEyeView.engine.camera.cancelFlight();
          } catch {
            /* no flight */
          }
          window.__godsEyeView.engine.camera.setView({
            destination: qaGeo.cartographic.toCartesian({
              longitude: lo * d2r,
              latitude: la * d2r,
              height: 18_000_000,
            }),
            orientation: { heading: 0, pitch: -Math.PI / 2, roll: 0 },
          });
          window.__godsEyeView.engine.render.request?.();
          await new Promise((r) => setTimeout(r, 1200));
          const c = window.__godsEyeView.engine.camera.pose().position;
          const norm = (v) => Math.hypot(v.x, v.y, v.z);
          let far = 0;
          let nearShown = 0;
          for (const e of window.__qaGhostPins(`${id}:`)) {
            const p = e.position;
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
    await whenSettled(page);
    await whenFramesDrawn(page);
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
    await whenFramesDrawn(page);
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
    // Each product's drawn edition (its sets' sequence number): a reload
    // draws a new edition in place of the old one.
    const identity = async () => {
      const out = {};
      for (const row of await sources(push)) out[row.name] = row.edition;
      return out;
    };
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
    await whenFramesDrawn(page);
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
    await whenFramesDrawn(page);
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
    await closeBrowser(browser);
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
