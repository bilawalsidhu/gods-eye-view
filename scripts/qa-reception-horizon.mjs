#!/usr/bin/env node
/**
 * Browser proof for the Reception Horizon layer.
 *
 * The page's two local-receiver routes are answered by the REAL route
 * handlers (`server/providers/local-receivers.js`) reading a synthetic
 * decoder (`scripts/synthetic-adsb.mjs`): aircraft at every altitude inside a
 * radio horizon that grows with altitude, a ridge that shadows low traffic to
 * the west-north-west, and a corrupt 1,500–1,800 km fix every 20 s. No radio,
 * no `.env` change and no network feed are needed.
 *
 * It proves, in the running app:
 *   1. The antenna comes from the decoder's receiver.json.
 *   2. Every drawn direction lies inside the radio horizon of the altitude
 *      and bearing it was heard at (no direction claims more than was heard),
 *      all five bands fill, and higher bands reach farther.
 *   3. The ridge shows: low bands are shorter behind it.
 *   4. Corrupt fixes were refused upstream and never reach the horizon.
 *   5. Neither local layer enters the share link.
 *   6. SET ANTENNA (the row chip) then a real click on the globe moves the
 *      antenna; AUTO returns to receiver.json.
 *   7. Disabling keeps counting; the console stays clean.
 *   8. A decoder WITHOUT a location: the row asks for the antenna, positions
 *      wait, and SET ANTENNA + click places them all.
 * Screenshots are written under the gitignored `qa-shots/reception-horizon/`.
 *
 * Run (dev server up): node scripts/qa-reception-horizon.mjs --url http://localhost:4173
 * Options: --headful, --seconds <n> (time to let the horizon fill; default 45),
 * --speed <n> (play the synthetic sky n times faster, for fuller screenshots).
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer';
import { createLocalReceiversHandler } from '../server/providers/local-receivers.js';
import {
  SYNTHETIC_RIDGE,
  createSyntheticSky,
  syntheticHorizonKm,
} from './synthetic-adsb.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..');
const SHOTS_DIR = path.join(REPO_ROOT, 'qa-shots', 'reception-horizon');
const args = process.argv.slice(2);
const option = (name, fallback) => {
  const index = args.indexOf(name);
  return index >= 0 && args[index + 1] ? args[index + 1] : fallback;
};
const APP_URL = option(
  '--url',
  process.env.QA_BASE_URL || 'http://localhost:4173',
);
const FILL_SECONDS = Number(option('--seconds', 45));
const SKY_SPEED = Math.max(1, Number(option('--speed', 1)) || 1);
const HEADFUL = args.includes('--headful');
const ANTENNA = Object.freeze({ lat: 30.2672, lon: -97.7431 });
const FEED_URL = 'http://127.0.0.1:8090/data/aircraft.json';

const chromeCandidates = [
  process.env.PUPPETEER_EXECUTABLE_PATH,
  await puppeteer.executablePath().catch(() => null),
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Chromium.app/Contents/MacOS/Chromium',
].filter(Boolean);
const chrome = chromeCandidates.find((candidate) => {
  try {
    return fs.existsSync(candidate);
  } catch {
    return false;
  }
});

let failures = 0;
function check(condition, label, detail = '') {
  if (condition) console.log(`  ✔ ${label}`);
  else {
    failures += 1;
    console.log(`  ✖ ${label}${detail ? ` — ${detail}` : ''}`);
  }
}

/** Route handlers over a synthetic sky; `withLocation` toggles receiver.json lat/lon. */
function syntheticRoutes({ withLocation }) {
  const sky = createSyntheticSky({
    antenna: ANTENNA,
    location: withLocation,
    timeScale: SKY_SPEED,
  });
  const handler = createLocalReceiversHandler({
    feedsValue: `1090=${FEED_URL}`,
    logger: { warn() {}, info() {} },
    positionCacheMs: 0,
    fetchImpl: async (url) =>
      new Response(
        JSON.stringify(
          url.endsWith('/receiver.json')
            ? sky.receiverJson()
            : sky.aircraftJson(Date.now()),
        ),
        { status: 200, headers: { 'content-type': 'application/json' } },
      ),
  });
  const run = async (handle) => {
    const res = {
      writeHead(status) {
        this.status = status;
      },
      end(body) {
        this.body = body;
      },
    };
    await handle({ url: '/', method: 'GET' }, res);
    return res;
  };
  return {
    aircraft: () => run(handler.handle),
    receiver: () => run(handler.handlePosition),
  };
}

async function openApp(browser, routes, errors) {
  const page = await browser.newPage();
  await page.setViewport({ width: 1440, height: 900, deviceScaleFactor: 1 });
  page.on('pageerror', (error) => errors.push(`pageerror: ${error.message}`));
  page.on('console', (message) => {
    if (message.type() !== 'error') return;
    const text = message.text();
    if (/horizon|local-receivers|Local ADS-B/i.test(text)) errors.push(text);
  });
  // Pause only the two local-receiver routes; imagery and every other request
  // flow untouched (page-wide interception starves the globe's tiles).
  const cdp = await page.createCDPSession();
  await cdp.send('Fetch.enable', {
    patterns: [
      { urlPattern: '*/api/local-receivers/*', requestStage: 'Request' },
    ],
  });
  cdp.on('Fetch.requestPaused', async ({ requestId, request }) => {
    const { pathname } = new URL(request.url);
    const route =
      pathname === '/api/local-receivers/aircraft'
        ? routes.aircraft
        : pathname === '/api/local-receivers/receiver'
          ? routes.receiver
          : null;
    try {
      if (!route) {
        await cdp.send('Fetch.continueRequest', { requestId });
        return;
      }
      const res = await route();
      await cdp.send('Fetch.fulfillRequest', {
        requestId,
        responseCode: res.status,
        responseHeaders: [
          { name: 'Content-Type', value: 'application/json' },
          { name: 'Cache-Control', value: 'no-store' },
        ],
        body: Buffer.from(res.body).toString('base64'),
      });
    } catch {
      // The page navigated or closed while the request was paused.
    }
  });
  // No share-link hash: a shared view lays out panels from the link.
  const url = new URL(APP_URL);
  url.searchParams.set('welcome', '0');
  await page.goto(url.toString(), {
    waitUntil: 'domcontentloaded',
    timeout: 60_000,
  });
  await page.waitForFunction(
    () =>
      window.__godsEyeView?.dataManager?.layers?.has('reception-horizon') &&
      !document.querySelector('.app-loading:not(.hidden)'),
    { timeout: 60_000, polling: 250 },
  );
  // Let the shared-view restoration finish before changing layers.
  await page.waitForFunction(() => document.readyState === 'complete', {
    timeout: 30_000,
  });
  await new Promise((resolve) => setTimeout(resolve, 3_000));
  await setCamera(page, {
    lat: ANTENNA.lat,
    lon: ANTENNA.lon,
    height: 1_500_000,
  });
  return page;
}

const horizon = (page) =>
  page.evaluate(() => {
    const module =
      window.__godsEyeView.dataManager.layers.get('reception-horizon').module;
    const { antenna, armed, horizon: h } = module.getHorizon();
    return {
      antenna,
      armed,
      counted: h.counted,
      pending: h.pending,
      implausible: h.implausible,
      farthest: h.farthest,
      bands: h.bands.map((band) => ({
        id: band.id,
        drawCeilingFt: band.drawCeilingFt,
        directions: band.directions,
        maxRangeKm: band.maxRangeKm,
        points: band.arcs.flatMap((arc) =>
          arc.points.map(({ bearingDeg, rangeKm, altitudeFt }) => ({
            bearingDeg,
            rangeKm,
            altitudeFt,
          })),
        ),
      })),
      stats: module.getStats(),
      controls: module.getRowControls(),
    };
  });

/** Open DATA LAYERS and turn both layers on with their row toggles, as a user does. */
async function enableLayers(page) {
  const expanded = await page.$eval(
    '#data-panel .panel-collapse-btn',
    (button) => button.getAttribute('aria-expanded'),
  );
  if (expanded !== 'true') await page.click('#data-panel .panel-collapse-btn');
  await new Promise((resolve) => setTimeout(resolve, 500));
  for (const id of ['local-adsb', 'reception-horizon']) {
    const selector = `[data-layer-id="${id}"] .data-toggle-btn`;
    // Turning a layer on re-renders rows; click a fresh, visible node.
    for (let attempt = 0; ; attempt += 1) {
      try {
        const button = await page.waitForSelector(selector, {
          visible: true,
          timeout: 10_000,
        });
        await button.evaluate((node) =>
          node.scrollIntoView({ block: 'center' }),
        );
        await button.click();
        break;
      } catch (error) {
        if (attempt >= 3) throw error;
        await new Promise((resolve) => setTimeout(resolve, 300));
      }
    }
    await page.waitForFunction(
      (layer) => window.__godsEyeView.dataManager.isEnabled(layer),
      { timeout: 15_000 },
      id,
    );
  }
}

/** Click a row chip the way a user does: the real DOM button in Data Layers. */
async function clickChip(page, chipId) {
  const clicked = await page.evaluate((id) => {
    const button = document.querySelector(
      `[data-layer-id="reception-horizon"] [data-chip-id="${id}"]`,
    );
    if (!button) return false;
    button.click();
    return true;
  }, chipId);
  // The panel repaints on the next frame.
  await new Promise((resolve) => setTimeout(resolve, 300));
  return clicked;
}

async function clickGlobeCentre(page) {
  const box = await page.evaluate(() => {
    const rect =
      window.__godsEyeView.viewer.scene.canvas.getBoundingClientRect();
    return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
  });
  await page.mouse.click(box.x, box.y);
  await new Promise((resolve) => setTimeout(resolve, 300));
}

/** Point the camera (degrees, metres), as the other gates do, then let it render. */
async function setCamera(
  page,
  { lat, lon, height, heading = 0, pitch = -90 },
  settleMs = 1_500,
) {
  await page.evaluate(
    async (view) => {
      const Cesium = await import('/node_modules/cesium/Build/Cesium/index.js');
      const { viewer } = window.__godsEyeView;
      viewer.camera.setView({
        destination: Cesium.Cartesian3.fromDegrees(
          view.lon,
          view.lat,
          view.height,
        ),
        orientation: {
          heading: Cesium.Math.toRadians(view.heading),
          pitch: Cesium.Math.toRadians(view.pitch),
          roll: 0,
        },
      });
      viewer.scene.requestRender();
    },
    { lat, lon, height, heading, pitch },
  );
  await new Promise((resolve) => setTimeout(resolve, settleMs));
}

async function main() {
  fs.mkdirSync(SHOTS_DIR, { recursive: true });
  const browser = await puppeteer.launch({
    headless: HEADFUL ? false : 'new',
    ...(chrome ? { executablePath: chrome } : {}),
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      ...(process.platform === 'darwin'
        ? ['--use-angle=metal', '--enable-gpu']
        : ['--use-gl=angle', '--use-angle=swiftshader']),
      '--disable-dev-shm-usage',
      '--disable-background-timer-throttling',
      '--disable-renderer-backgrounding',
      '--window-size=1440,900',
    ],
  });
  const errors = [];
  try {
    // ── A decoder that knows where its antenna is ──────────────────────────
    console.log('Decoder with a location in receiver.json');
    const page = await openApp(
      browser,
      syntheticRoutes({ withLocation: true }),
      errors,
    );
    const hashBefore = await page.evaluate(() => location.hash);
    await enableLayers(page);
    console.log(`  … letting the horizon fill for ${FILL_SECONDS} s`);
    await new Promise((resolve) => setTimeout(resolve, FILL_SECONDS * 1000));
    const state = await horizon(page);

    check(
      state.antenna?.source === 'feed',
      'antenna comes from receiver.json',
      JSON.stringify(state.antenna),
    );
    check(
      Math.abs(state.antenna?.lat - ANTENNA.lat) < 1e-9 &&
        Math.abs(state.antenna?.lon - ANTENNA.lon) < 1e-9,
      'antenna is exactly the decoder position',
    );
    check(state.counted > 500, `positions counted (${state.counted})`);
    check(
      state.bands.every((band) => band.directions >= 3),
      'all five altitude bands heard',
      state.bands.map((b) => `${b.id}:${b.directions}`).join(' '),
    );
    const outside = state.bands.flatMap((band) =>
      band.points.filter(
        (point) =>
          point.rangeKm >
          syntheticHorizonKm(point.altitudeFt, point.bearingDeg) + 1,
      ),
    );
    check(
      outside.length === 0,
      'no drawn direction lies beyond the radio horizon it was heard inside',
      JSON.stringify(outside.slice(0, 3)),
    );
    const max = Object.fromEntries(
      state.bands.map((b) => [b.id, b.maxRangeKm]),
    );
    check(
      max['above-35k'] > max['15k-25k'] && max['15k-25k'] > max['below-5k'],
      'higher bands reach farther',
      JSON.stringify(max),
    );
    // Below the ridge ceiling, behind the ridge, the synthetic antenna hears
    // at most this far; the same altitude in the open reaches much farther.
    const ridgeLimit = syntheticHorizonKm(SYNTHETIC_RIDGE.belowFt - 1, 280);
    const inRidge = (p) =>
      p.bearingDeg >= SYNTHETIC_RIDGE.fromDeg + 3 &&
      p.bearingDeg <= SYNTHETIC_RIDGE.toDeg - 3;
    const lowBehindRidge = state.bands
      .filter((band) => band.drawCeilingFt <= SYNTHETIC_RIDGE.belowFt)
      .flatMap((band) => band.points.filter(inRidge));
    const lowOpen = state.bands
      .find((band) => band.id === '5k-15k')
      .points.filter((p) => !inRidge(p));
    check(
      lowBehindRidge.every((p) => p.rangeKm <= ridgeLimit + 1) &&
        Math.max(...lowOpen.map((p) => p.rangeKm)) > ridgeLimit,
      'the ridge shortens the low bands behind it',
      `behind ${lowBehindRidge.length} ≤ ${Math.round(ridgeLimit)} km`,
    );
    const rejected = await page.evaluate(
      () =>
        window.__godsEyeView.dataManager.layers
          .get('local-adsb')
          .module.getStats().rejectedPositions,
    );
    check(
      rejected >= 1 && state.farthest.rangeKm < 650,
      `corrupt fixes refused upstream (${rejected}) and never drawn (farthest ${Math.round(state.farthest.rangeKm)} km)`,
    );
    check(
      /^\d[\d,]*\u00a0km$/.test(state.stats.countLabel || ''),
      `row count shows the farthest range (${state.stats.countLabel})`,
    );
    check(
      state.controls.legend.length === 5 &&
        /receiver\.json/.test(state.controls.info),
      'row shows the five-band legend and names the antenna source',
      state.controls.info,
    );
    const row = await page.$('[data-layer-id="reception-horizon"]');
    const rowText = await row?.evaluate((node) => node.innerText);
    check(
      /SET ANTENNA/.test(rowText || '') &&
        /35k\+ ft \d+ km/.test(rowText || ''),
      'Data Layers row shows the chips and the per-band ranges',
      rowText,
    );
    await row?.evaluate((node) => node.scrollIntoView({ block: 'center' }));
    await new Promise((resolve) => setTimeout(resolve, 300));
    await row?.screenshot({
      path: path.join(SHOTS_DIR, '00-data-layers-row.png'),
    });
    const hashAfter = await page.evaluate(() => location.hash);
    const layersParam = (hash) => new URLSearchParams(hash.slice(1)).get('l');
    // Both layers are on, yet the link's layer list stays empty.
    check(
      !layersParam(hashAfter) && !/reception|adsb/i.test(hashAfter),
      'neither local layer enters the share link',
      `l=${layersParam(hashBefore)} → l=${layersParam(hashAfter)}`,
    );
    await setCamera(
      page,
      { lat: 24.2, lon: -93.6, height: 620_000, heading: -32, pitch: -34 },
      3_000,
    );
    await page.screenshot({
      path: path.join(SHOTS_DIR, '01-horizon-oblique.png'),
    });
    await setCamera(
      page,
      { lat: ANTENNA.lat, lon: ANTENNA.lon, height: 1_900_000 },
      3_000,
    );
    await page.screenshot({
      path: path.join(SHOTS_DIR, '02-horizon-top-down.png'),
    });
    check(await clickChip(page, 'height'), 'HEIGHT ×10 chip clicked');
    const stretched = await horizon(page);
    check(
      /heights ×10 for display$/.test(stretched.controls.info) &&
        Math.abs(stretched.farthest.rangeKm - state.farthest.rangeKm) < 50,
      'the row says heights are stretched; ranges are not',
    );
    await setCamera(
      page,
      { lat: 25.0, lon: -94.4, height: 560_000, heading: -34, pitch: -22 },
      3_000,
    );
    await page.screenshot({
      path: path.join(SHOTS_DIR, '03-horizon-height-x10.png'),
    });
    await clickChip(page, 'height');

    // SET ANTENNA → a real click on the globe centre → AUTO.
    const centre = { lat: 30.6, lon: -97.2 };
    await setCamera(page, { ...centre, height: 400_000 });
    check(await clickChip(page, 'antenna-set'), 'SET ANTENNA chip clicked');
    const armed = await horizon(page);
    check(
      armed.armed && /Click your antenna/.test(armed.controls.info),
      'chip arms a globe click',
    );
    await clickGlobeCentre(page);
    const placed = await horizon(page);
    check(
      placed.antenna?.source === 'manual' &&
        Math.abs(placed.antenna.lat - centre.lat) < 0.05 &&
        Math.abs(placed.antenna.lon - centre.lon) < 0.05,
      'a click on the globe places the antenna there',
      JSON.stringify(placed.antenna),
    );
    check(
      await page.evaluate(
        () =>
          window.__godsEyeView.dataManager.layers
            .get('reception-horizon')
            .module.getHorizon().armed === false,
      ),
      'placement disarms',
    );
    check(await clickChip(page, 'antenna-auto'), 'AUTO chip clicked');
    check(
      (await horizon(page)).antenna?.source === 'feed',
      'AUTO returns to receiver.json',
    );

    const before = (await horizon(page)).counted;
    await page.evaluate(() =>
      window.__godsEyeView.dataManager.setEnabled('reception-horizon', false, {
        origin: 'user',
      }),
    );
    await new Promise((resolve) => setTimeout(resolve, 4_000));
    check(
      (await horizon(page)).counted > before,
      'positions keep counting while the layer is off',
    );
    await page.close();

    // ── A decoder started without a location ───────────────────────────────
    console.log('Decoder without a location');
    const blind = await openApp(
      browser,
      syntheticRoutes({ withLocation: false }),
      errors,
    );
    await enableLayers(blind);
    await new Promise((resolve) => setTimeout(resolve, 10_000));
    const waiting = await horizon(blind);
    check(waiting.antenna === null, 'no antenna is guessed');
    check(
      waiting.stats.statusMessage === 'Needs your antenna position' &&
        /LOCATE in the Radio card/.test(waiting.controls.info),
      'the row asks for the antenna position',
      waiting.controls.info,
    );
    check(
      waiting.pending > 0 && waiting.counted === 0,
      `positions wait for the antenna (${waiting.pending})`,
    );
    await setCamera(blind, {
      lat: ANTENNA.lat,
      lon: ANTENNA.lon,
      height: 400_000,
    });
    await clickChip(blind, 'antenna-set');
    await clickGlobeCentre(blind);
    const placedBlind = await horizon(blind);
    check(
      placedBlind.antenna?.source === 'manual' &&
        placedBlind.counted >= waiting.pending,
      `SET ANTENNA places every waiting position (${placedBlind.counted})`,
    );
    await blind.close();

    check(errors.length === 0, 'console clean', errors.slice(0, 5).join(' | '));
  } finally {
    await browser.close();
  }
  console.log(
    failures
      ? `\n${failures} check(s) failed`
      : '\nAll Reception Horizon checks passed',
  );
  console.log(`Screenshots: ${path.relative(REPO_ROOT, SHOTS_DIR)}/`);
  process.exit(failures ? 1 : 0);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
