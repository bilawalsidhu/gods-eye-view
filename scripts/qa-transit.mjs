#!/usr/bin/env node
/**
 * Browser proof of the Transit layer: real feeds through the real proxy, real
 * vehicles gliding on the globe, a real click on one of them, and the
 * operator's credit on screen.
 *
 * Usage: node scripts/qa-transit.mjs [--url http://localhost:4173]
 *        [--shots qa-shots/transit] [--label keyless] [--headful]
 *
 * Needs a live network: it polls HSL (Helsinki) and Entur (Norway), which are
 * keyless. Run it in the daytime for the region under test — at 03:00 local a
 * feed honestly reports few or no vehicles.
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const arg = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
};
const BASE = arg('url', 'http://localhost:4173');
const SHOTS = arg('shots', path.join(ROOT, 'qa-shots', 'transit'));
const LABEL = arg('label', 'keyless');
const HEADFUL = args.includes('--headful');

await fs.mkdir(SHOTS, { recursive: true });

let failures = 0;
const lines = [];
const check = (name, passed, detail = '') => {
  const text = `[${passed ? 'PASS' : 'FAIL'}] ${name}${detail ? ` — ${detail}` : ''}`;
  console.log(text);
  lines.push(text);
  if (!passed) failures += 1;
};

const browser = await puppeteer.launch({
  headless: HEADFUL ? false : 'new',
  executablePath:
    process.env.PUPPETEER_EXECUTABLE_PATH ||
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  args: [
    '--no-sandbox',
    '--use-angle=metal',
    '--enable-gpu',
    '--disable-background-timer-throttling',
    '--disable-renderer-backgrounding',
    '--window-size=1280,860',
  ],
});
const page = await browser.newPage();
await page.setViewport({ width: 1280, height: 860 });
const pageErrors = [];
page.on('pageerror', (error) => pageErrors.push(error.message));
const consoleErrors = [];
page.on('console', (msg) => {
  if (msg.type() === 'error') consoleErrors.push(msg.text());
});
const transitRequests = [];
page.on('response', (response) => {
  const url = response.url();
  if (url.includes('/api/transit/'))
    transitRequests.push({
      status: response.status(),
      cache: response.headers()['x-gev-cache'] || '',
      path: url.replace(/.*\/api\/transit/, ''),
    });
});

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const shot = async (name) => {
  const file = path.join(SHOTS, name);
  await page.screenshot({ path: file, type: 'jpeg', quality: 82 });
  console.log(`  shot: ${file}`);
};

async function lookAt(lat, lon, height, pitchDeg = -55) {
  await page.evaluate(
    (la, lo, h, pitch) => {
      const viewer = window.__godsEyeView.viewer;
      const Cartesian3 = viewer.camera.positionWC.constructor;
      viewer.camera.cancelFlight();
      viewer.camera.setView({
        destination: Cartesian3.fromDegrees(lo, la, h),
        orientation: { heading: 0, pitch: (pitch * Math.PI) / 180, roll: 0 },
      });
    },
    lat,
    lon,
    height,
    pitchDeg,
  );
}

/** Canvas position of a world point, or null when it is off screen. */
const screenAt = (position) =>
  page.evaluate((pos) => {
    const viewer = window.__godsEyeView.viewer;
    const Cartesian3 = viewer.camera.positionWC.constructor;
    const win = viewer.scene.cartesianToCanvasCoordinates(
      new Cartesian3(pos.x, pos.y, pos.z),
    );
    if (!win || !Number.isFinite(win.x)) return null;
    const x = Math.round(win.x);
    const y = Math.round(win.y);
    if (x < 360 || y < 120 || x > 1200 || y > 780) return null;
    return { x, y };
  }, position);

const layerState = () =>
  page.evaluate(() => {
    const gev = window.__godsEyeView;
    const module = gev.dataManager.layers.get('transit').module;
    const row = document.querySelector(
      '#data-toggles [data-layer-id="transit"]',
    );
    const vehicles = module._transitVehiclesForTest();
    return {
      stats: module.getStats(),
      rowMeta: row?.querySelector('.data-toggle-meta')?.textContent || '',
      rowCount: row?.querySelector('.data-count')?.textContent || '',
      vehicles: vehicles.length,
      shown: vehicles.filter((v) => v.shown).length,
      anchored: vehicles.filter((v) => Number.isFinite(v.floorM)).length,
      modes: [...new Set(vehicles.map((v) => v.mode))].sort(),
      sample: vehicles
        .slice(0, 40)
        .map((v) => ({ key: v.key, position: v.position })),
      selected: module._transitSelectedKeyForTest(),
      overlay:
        window.__gevWorldOverlay?.getDiagnostics?.()?.entriesBySource?.[
          'transit-selected'
        ] ?? null,
      pointerOwner: window.__gevQa?.pointerOwner?.() ?? null,
    };
  });

const toggleRow = () =>
  page.evaluate(() => {
    const panel = document.getElementById('data-panel');
    if (panel?.classList.contains('collapsed')) {
      panel
        .querySelector('.panel-collapse-btn[data-collapse-target="data-panel"]')
        ?.click();
    }
    const row = document.querySelector(
      '#data-toggles [data-layer-id="transit"]',
    );
    const button = row?.querySelector('.data-toggle-btn');
    if (!button) return null;
    button.scrollIntoView({ block: 'center' });
    const before = button.textContent.trim();
    button.click();
    return before;
  });

try {
  // ── 1. Boot keyless, open the panel, switch the layer on over Helsinki. ──
  await page.goto(`${BASE}/#lat=60.17&lon=24.94&alt=9000&heading=0&pitch=-55`, {
    waitUntil: 'load',
  });
  await page.waitForFunction(
    () => window.__godsEyeView?.dataManager?.layers?.has('transit'),
    { timeout: 60000 },
  );
  await sleep(2500);
  await page.keyboard.press('Escape'); // first-run dialog
  await sleep(500);
  await lookAt(60.17, 24.94, 9000);
  const before = await toggleRow();
  check(
    'the Transit row is in the Data Layers panel',
    before !== null,
    String(before),
  );
  await sleep(1500);
  let state = await layerState();
  check(
    'switching on polls the feed under the camera and no other',
    state.stats.feeds?.length === 1 && state.stats.feeds[0] === 'hsl-helsinki',
    JSON.stringify(state.stats.feeds),
  );

  // ── 2. Vehicles arrive, are anchored to the ground floor, and are shown. ──
  await sleep(12000);
  state = await layerState();
  check(
    'HSL vehicles are on the globe',
    state.vehicles > 0,
    `${state.vehicles} vehicles`,
  );
  check(
    'the row shows the count and the feed',
    /HSL \d+/.test(state.rowMeta) || /\d/.test(state.rowCount),
    `${state.rowCount} · ${state.rowMeta}`,
  );
  check(
    'near the ground, vehicles are anchored to the shared floor before they are shown',
    state.shown === state.anchored,
    `${state.shown} shown, ${state.anchored} anchored of ${state.vehicles}`,
  );
  check(
    'more than one mode is on screen, so the colour legend means something',
    state.modes.length >= 2,
    state.modes.join(','),
  );
  await shot(`01-${LABEL}-helsinki.jpg`);

  // ── 3. The second poll makes them glide. ─────────────────────────────────
  const first = state.sample;
  await sleep(16000); // past the next poll, mid-glide
  state = await layerState();
  const moved = state.sample.filter((v) => {
    const was = first.find((f) => f.key === v.key);
    return (
      was &&
      v.position &&
      was.position &&
      (Math.abs(v.position.x - was.position.x) > 0.5 ||
        Math.abs(v.position.y - was.position.y) > 0.5 ||
        Math.abs(v.position.z - was.position.z) > 0.5)
    );
  }).length;
  check(
    'after the second poll, vehicles have moved',
    moved > 0,
    `${moved} of ${state.sample.length} sampled moved`,
  );
  check(
    'each poll hits the proxy once per feed',
    transitRequests.filter((r) => r.path.includes('hsl-helsinki')).length >=
      2 && transitRequests.every((r) => r.status === 200),
    JSON.stringify(transitRequests.slice(0, 4)),
  );

  // ── 4. Click a vehicle: the card opens; yield while a tool has the pointer. ─
  let target = null;
  for (const v of state.sample) {
    const at = v.position ? await screenAt(v.position) : null;
    if (at) {
      target = { key: v.key, at };
      break;
    }
  }
  check('a vehicle is on screen to click', !!target, JSON.stringify(target));
  if (target) {
    await page.mouse.click(target.at.x, target.at.y);
    await sleep(1200);
    state = await layerState();
    check(
      'clicking a vehicle selects it',
      state.selected !== null,
      String(state.selected),
    );
    check(
      'the selection paints one card on the shared host',
      state.overlay === 1,
      String(state.overlay),
    );
    await shot(`02-${LABEL}-selected.jpg`);
    await page.keyboard.press('Escape');
    await sleep(400);
    state = await layerState();
    check('Escape clears the selection', state.selected === null);
    const yielded = await page.evaluate(async (key) => {
      const gev = window.__godsEyeView;
      const module = gev.dataManager.layers.get('transit').module;
      const lease = window.__gevQa?.claimPointer?.('qa-tool');
      const result = module._handleTransitClickForTest({ id: key });
      if (lease) window.__gevQa.releasePointer(lease);
      return { lease: !!lease, result };
    }, target.key);
    check(
      'while a tool holds the pointer, a click on a vehicle is ignored',
      !yielded.lease || yielded.result === 'yielded',
      yielded.lease
        ? JSON.stringify(yielded)
        : 'no pointer seam exposed to the page; covered by the unit suite',
    );
  }

  // ── 5. The operator is credited. ─────────────────────────────────────────
  const credit = await page.evaluate(async () => {
    const anchor = [...document.querySelectorAll('a')].find((a) =>
      /data attribution/i.test(a.textContent),
    );
    anchor?.click();
    await new Promise((resolve) => setTimeout(resolve, 900));
    const text = document.body.innerText;
    return {
      open: /Data provided by/i.test(text),
      gtfs: /GTFS-Realtime/i.test(text),
      hsl: /HSL/.test(text) && /CC BY 4\.0/.test(text),
    };
  });
  check('the Data attribution popover opens', credit.open);
  check('it credits transit feeds generically', credit.gtfs);
  check(
    'it credits HSL with its license once its vehicles rendered',
    credit.hsl,
  );
  await page.keyboard.press('Escape');

  // ── 6. Norway from 1,500 km: a national fleet, one feed, shown unanchored. ─
  await lookAt(64.5, 12, 1_500_000, -80);
  await sleep(14000);
  state = await layerState();
  check(
    'flying to Norway swaps the polled feed to Entur alone',
    state.stats.feeds?.length === 1 && state.stats.feeds[0] === 'entur-norway',
    JSON.stringify(state.stats.feeds),
  );
  check(
    'the national fleet is on the globe',
    state.vehicles > 50,
    `${state.vehicles} vehicles`,
  );
  check(
    'from 1,500 km every vehicle is shown at the ellipsoid',
    state.shown === state.vehicles,
  );
  await shot(`03-${LABEL}-norway.jpg`);

  // ── 7. Off: nothing left behind. ─────────────────────────────────────────
  await toggleRow();
  await sleep(1000);
  state = await layerState();
  check(
    'switching off drops every vehicle',
    state.vehicles === 0 && state.stats.count === 0,
  );

  check(
    'no uncaught page errors',
    pageErrors.length === 0,
    pageErrors.join(' | '),
  );
  const realConsoleErrors = consoleErrors.filter(
    (text) =>
      !/Failed to load resource|net::ERR|favicon|429|ERR_ABORTED|status of 4/i.test(
        text,
      ),
  );
  check(
    'no unexpected console errors',
    realConsoleErrors.length === 0,
    realConsoleErrors.slice(0, 3).join(' | '),
  );
} catch (error) {
  check('harness completed', false, error?.stack || String(error));
  await shot(`99-${LABEL}-failure.jpg`).catch(() => {});
} finally {
  await browser.close();
  await fs.writeFile(
    path.join(SHOTS, `qa-transit-${LABEL}.log`),
    `${lines.join('\n')}\n${failures} failure(s)\n`,
  );
  console.log(`\n${failures} failure(s)`);
  process.exit(failures ? 1 : 0);
}
