#!/usr/bin/env node
/**
 * qa-gravity.mjs — headless proof for the Mass Change (GRACE) layer
 * (id `gravity`) and its MASS CHANGE rail card.
 *
 * Drives the REAL app in headless Chromium against a dev server (keyless).
 * The live sections read CSR's GRACE/GRACE-FO mascons through
 * `/api/gravity`; a fresh server downloads and converts the record (about
 * 115 MB) and CSR's land mask on first use, so the gate waits for
 * `/api/gravity/index` to answer 200 before it starts.
 *
 *   (i)   LIVE — the layer draws the latest solution, the MASS CHANGE card
 *         appears naming that month, land only is the default and draws
 *         through the served 0.25° land mask.
 *   (ii)  MONTHS — ‹ steps to the previous solution and Latest returns;
 *         Play replays from the first solution, advancing, and Pause stops.
 *   (iii) PROBE — a click on open ground over northern India reads that cell,
 *         and the card charts its whole record, broken at the 2017-2018
 *         mission gap; Clear removes it.
 *   (iv)  AREA — Land + ocean draws every cell; Land restores the mask.
 *   (v)   FAILURE (stubbed) — the index answering 503 GRAVITY_LOADING is
 *         reported as "Preparing the gravity record", not thrown.
 *   (vi)  VIEWPORT — at a 390x844 phone viewport the card fits with no
 *         horizontal overflow.
 *   (vii) DISABLE — the card hides and the shell is removed.
 *
 * Visual proof saved to qa-shots/gravity-*.png (gitignored).
 *
 * Run:  node scripts/qa-gravity.mjs --url http://localhost:4173
 *       (also against a built preview: npm run build && npm run preview,
 *       then pass the preview URL)
 * Optional: --timeout-ms 120000 per wait; --ready-ms 900000 for the first
 * download and conversion on a fresh server.
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
const TIMEOUT_MS = Number(getOpt('--timeout-ms', '120000'));
const READY_MS = Number(getOpt('--ready-ms', '900000'));
const LAYER_ID = 'gravity';
// Northern India: the clearest groundwater decline in the record.
const INDIA = { lon: 77.5, lat: 28.5 };

const results = [];
function record(name, ok, detail) {
  results.push({ name, ok, detail });
  const tag = ok ? '\x1b[32mPASS\x1b[0m' : '\x1b[31mFAIL\x1b[0m';
  console.log(`  [${tag}] ${name}${detail ? `  — ${detail}` : ''}`);
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Wait for the proxy to have the record (and the mask) ready. */
async function waitForRecord() {
  const deadline = Date.now() + READY_MS;
  for (;;) {
    try {
      const res = await fetch(`${APP_URL}/api/gravity/index`);
      if (res.ok) {
        const index = await res.json();
        if (index.landMask) return index;
      }
    } catch {
      /* server still starting */
    }
    if (Date.now() > deadline) return null;
    await sleep(5000);
  }
}

/** Boot the app, dismiss the intro and look straight down at a place. */
async function boot(page, { lon, lat, height }) {
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

const diagnostics = (page) =>
  page.evaluate((id) => {
    const layer = window.__godsEyeView.dataManager.layers.get(id).module;
    return layer.getDiagnostics();
  }, LAYER_ID);
const rowInfo = (page) =>
  page.evaluate((id) => {
    const layer = window.__godsEyeView.dataManager.layers.get(id).module;
    return layer.getRowControls().info;
  }, LAYER_ID);
const card = (page) =>
  page.evaluate(() => {
    const panel = document.getElementById('gravity-panel');
    const box = panel?.getBoundingClientRect();
    const text = (selector) =>
      panel?.querySelector(selector)?.textContent?.trim() ?? null;
    return {
      shown: Boolean(panel && !panel.hidden && box.width > 0),
      month: text('.gravity-month-label'),
      point: text('.gravity-point-text'),
      lines:
        panel?.querySelectorAll('.gravity-chart-series polyline').length ?? 0,
      chartShown: Boolean(
        panel?.querySelector('.gravity-chart') &&
        !panel.querySelector('.gravity-chart').hasAttribute('hidden'),
      ),
      overflow: panel ? panel.scrollWidth > panel.clientWidth + 1 : null,
      right: box?.right ?? null,
      viewport: window.innerWidth,
    };
  });
const clickCardButton = (page, label) =>
  page.evaluate((text) => {
    const button = [...document.querySelectorAll('#gravity-panel button')].find(
      (node) => node.textContent.trim() === text,
    );
    button?.click();
    return Boolean(button);
  }, label);
const monthLabel = (day) =>
  new Date(`${day}T00:00:00Z`).toLocaleDateString('en', {
    month: 'short',
    year: 'numeric',
    timeZone: 'UTC',
  });

async function waitFor(page, predicate, ms = TIMEOUT_MS) {
  const deadline = Date.now() + ms;
  for (;;) {
    const value = await predicate();
    if (value) return value;
    if (Date.now() > deadline) return null;
    await sleep(250);
  }
}

async function main() {
  try {
    const res = await fetch(APP_URL);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
  } catch (e) {
    console.error(
      `\x1b[31mDev server not reachable at ${APP_URL} (${e.message}).\x1b[0m`,
    );
    process.exit(2);
  }
  console.log('Waiting for the gravity record and land mask...');
  const index = await waitForRecord();
  record(
    'the proxy serves the record and the land mask',
    Boolean(index?.solutions?.length),
    index ? `${index.solutions.length} solutions` : 'timed out',
  );
  if (!index) process.exit(1);
  const latest = index.solutions.at(-1);
  const previous = index.solutions.at(-2);

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
      '--use-gl=angle',
      '--use-angle=swiftshader',
      '--disable-dev-shm-usage',
      '--disable-background-timer-throttling',
      '--disable-renderer-backgrounding',
      '--window-size=1440,900',
    ],
  });

  const errors = [];
  try {
    // ── (i) LIVE ──────────────────────────────────────────────────────────
    console.log('(i) LIVE — latest solution, card and land mask...');
    const page = await browser.newPage();
    await page.setViewport({ width: 1440, height: 900 });
    page.on('pageerror', (e) => errors.push(e.message));
    await boot(page, { ...INDIA, height: 6_000_000 });
    await page.evaluate(
      (id) =>
        window.__godsEyeView.dataManager.setEnabled(id, true, {
          origin: 'user',
        }),
      LAYER_ID,
    );
    const live = await waitFor(page, async () => {
      const d = await diagnostics(page);
      return d.month && d.imageryActive && d.landMask ? d : null;
    });
    record(
      'LIVE: the latest solution is drawn through the land mask',
      live?.month === latest.id && live.area === 'land' && live.landMask,
      live ? `month ${live.month}, area ${live.area}` : 'never settled',
    );
    const shown = await card(page);
    record(
      'LIVE: the MASS CHANGE card names the month',
      shown.shown && shown.month === monthLabel(latest.id),
      `card "${shown.month}"`,
    );
    await page.screenshot({ path: path.join(SHOTS_DIR, 'gravity-live.png') });

    // ── (ii) MONTHS ───────────────────────────────────────────────────────
    console.log('(ii) MONTHS — step, latest, play...');
    await clickCardButton(page, '‹');
    const stepped = await waitFor(page, async () => {
      const d = await diagnostics(page);
      return d.month === previous.id ? d : null;
    });
    // The card follows the layer on its next row refresh.
    const steppedCard = await waitFor(page, async () => {
      const c = await card(page);
      return c.month === monthLabel(previous.id) ? c : null;
    });
    record(
      'MONTHS: ‹ steps to the previous solution',
      Boolean(stepped) && Boolean(steppedCard),
      `${stepped?.month}; card "${(await card(page)).month}"`,
    );
    await clickCardButton(page, 'Latest');
    record(
      'MONTHS: Latest returns to the newest solution',
      Boolean(
        await waitFor(page, async () =>
          (await diagnostics(page)).month === latest.id ? true : null,
        ),
      ),
    );
    await clickCardButton(page, 'Play');
    const first = await waitFor(page, async () => {
      const d = await diagnostics(page);
      return d.playing && d.month === index.solutions[0].id ? d : null;
    });
    await sleep(3000);
    const advanced = await diagnostics(page);
    const position = index.solutions.findIndex(
      ({ id }) => id === advanced.month,
    );
    record(
      'MONTHS: Play replays from the first solution and advances',
      Boolean(first) && advanced.playing && position >= 2,
      `at solution ${position} after 3 s`,
    );
    await clickCardButton(page, 'Pause');
    const paused = await diagnostics(page);
    await sleep(1500);
    record(
      'MONTHS: Pause stops the replay',
      !paused.playing && (await diagnostics(page)).month === paused.month,
    );
    await clickCardButton(page, 'Latest');
    await waitFor(page, async () =>
      (await diagnostics(page)).month === latest.id ? true : null,
    );

    // ── (iii) PROBE ───────────────────────────────────────────────────────
    console.log('(iii) PROBE — click northern India, chart the record...');
    await page.mouse.click(720, 450);
    const probed = await waitFor(page, async () => {
      const c = await card(page);
      return c.chartShown && c.lines > 0 ? c : null;
    });
    const probe = (await diagnostics(page)).probe;
    record(
      'PROBE: a click on open ground reads that cell',
      Boolean(probe) &&
        Math.abs(probe.lat - INDIA.lat) < 2 &&
        Math.abs(probe.lon - INDIA.lon) < 2 &&
        Number.isFinite(probe.cm),
      probe
        ? `${probe.lat.toFixed(1)}, ${probe.lon.toFixed(1)}: ${probe.cm} cm`
        : 'no probe',
    );
    record(
      'PROBE: the card charts the record, broken at the mission gap',
      Boolean(probed) &&
        probed.lines >= 2 &&
        probe?.history?.length === index.solutions.length,
      probed ? `${probed.lines} segments; "${probed.point}"` : 'no chart',
    );
    await page.screenshot({ path: path.join(SHOTS_DIR, 'gravity-probe.png') });
    await clickCardButton(page, 'Clear');
    record(
      'PROBE: Clear removes the point',
      (await diagnostics(page)).probe === null &&
        !(await card(page)).chartShown,
    );

    // ── (iv) AREA ─────────────────────────────────────────────────────────
    console.log('(iv) AREA — land + ocean and back...');
    await clickCardButton(page, 'Land + ocean');
    const all = await diagnostics(page);
    await page.screenshot({ path: path.join(SHOTS_DIR, 'gravity-all.png') });
    await clickCardButton(page, 'Land');
    const land = await diagnostics(page);
    record(
      'AREA: Land + ocean and Land switch the drawn area',
      all.area === 'all' && land.area === 'land' && land.imageryActive,
    );

    // ── (vii) DISABLE ─────────────────────────────────────────────────────
    console.log('(vii) DISABLE — card hides, shell removed...');
    await page.evaluate(
      (id) =>
        window.__godsEyeView.dataManager.setEnabled(id, false, {
          origin: 'user',
        }),
      LAYER_ID,
    );
    await sleep(500);
    record(
      'DISABLE: the card hides and the shell is removed',
      !(await card(page)).shown && !(await diagnostics(page)).imageryActive,
    );
    await page.close();

    // ── (v) FAILURE (stubbed) ─────────────────────────────────────────────
    console.log('(v) FAILURE — index stubbed to 503 GRAVITY_LOADING...');
    const failing = await browser.newPage();
    await failing.setViewport({ width: 1440, height: 900 });
    failing.on('pageerror', (e) => errors.push(e.message));
    await failing.setRequestInterception(true);
    failing.on('request', (request) => {
      if (request.url().includes('/api/gravity/index'))
        request.respond({
          status: 503,
          contentType: 'application/json',
          headers: { 'Retry-After': '30' },
          body: JSON.stringify({
            code: 'GRAVITY_LOADING',
            retryable: true,
            error: 'Preparing the gravity record',
          }),
        });
      else request.continue();
    });
    await boot(failing, { ...INDIA, height: 6_000_000 });
    await failing.evaluate(
      (id) =>
        window.__godsEyeView.dataManager.setEnabled(id, true, {
          origin: 'user',
        }),
      LAYER_ID,
    );
    const reported = await waitFor(failing, async () =>
      /Preparing the gravity record/.test(await rowInfo(failing)),
    );
    record(
      'FAILURE: a record still being prepared is reported, not thrown',
      Boolean(reported),
    );
    await failing.close();

    // ── (vi) VIEWPORT ─────────────────────────────────────────────────────
    console.log('(vi) VIEWPORT — 390x844 phone...');
    const phone = await browser.newPage();
    await phone.setViewport({ width: 390, height: 844, isMobile: true });
    phone.on('pageerror', (e) => errors.push(e.message));
    await boot(phone, { ...INDIA, height: 6_000_000 });
    await phone.evaluate(
      (id) =>
        window.__godsEyeView.dataManager.setEnabled(id, true, {
          origin: 'user',
        }),
      LAYER_ID,
    );
    const fits = await waitFor(phone, async () => {
      const c = await card(phone);
      return c.shown && c.month ? c : null;
    });
    record(
      'VIEWPORT: the card fits a phone with no horizontal overflow',
      Boolean(fits) && fits.overflow === false && fits.right <= fits.viewport,
      fits
        ? `right edge ${Math.round(fits.right)} of ${fits.viewport}`
        : 'no card',
    );
    await phone.screenshot({ path: path.join(SHOTS_DIR, 'gravity-phone.png') });
    await phone.close();

    record(
      'no page errors',
      errors.length === 0,
      errors.slice(0, 3).join(' | '),
    );
  } finally {
    await browser.close();
  }
  const failed = results.filter(({ ok }) => !ok);
  console.log(
    `\n${results.length - failed.length}/${results.length} passed${failed.length ? `; ${failed.length} FAILED` : ''}`,
  );
  process.exit(failed.length ? 1 : 0);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
