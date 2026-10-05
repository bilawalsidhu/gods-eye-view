#!/usr/bin/env node
/**
 * qa-cits.mjs — headless proof for the C-ITS (OpenTrafficMap) layer.
 *
 * Drives the REAL app in headless Chromium. `/api/cits/*` is intercepted with
 * a fixed Graz fixture — a tram, a bus, a private car, a traffic light with a
 * live phase, a DENM hazard and one MAPEM intersection — so the run never
 * contacts OpenTrafficMap.
 *
 *   (i)   LIVE — the row controls appear with the layer; every fixture
 *         station and the hazard are drawn; lanes load; the high-bandwidth
 *         chips stay hidden without the operator opt-in.
 *   (ii)  ANONYMOUS — the private car is never handed to detection, and a
 *         click on it publishes no card.
 *   (iii) CARDS — a click on the tram publishes exactly one `selected` card on
 *         the `cits-selected` world-overlay source, painted with its line and
 *         destination; an empty-space click clears it.
 *   (iv)  CONTROLS — the row's kind list shows live counts, and its Cars
 *         switch removes the car dot.
 *   (v)   TEARDOWN — disable removes every dot, the card and the row
 *         controls; polling stops; the console stays clean.
 *
 * Visual proof saved to qa-shots/cits/ (gitignored).
 *
 * Run:  node scripts/qa-cits.mjs --url http://localhost:4173
 * Exits non-zero on any FAIL. Does not commit anything.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..');
const SHOTS_DIR = path.join(REPO_ROOT, 'qa-shots', 'cits');
const args = process.argv.slice(2);
const option = (name, fallback) => {
  const index = args.indexOf(name);
  return index >= 0 && args[index + 1] ? args[index + 1] : fallback;
};
const APP_URL = new URL(
  option('--url', process.env.QA_BASE_URL || 'http://localhost:4173'),
);
APP_URL.searchParams.set('welcome', '0');
const HEADFUL = args.includes('--headful');

const CENTER = { lon: 15.4425, lat: 47.0665 };
const now = () => new Date(Date.now() - 1000).toISOString();
function stateFixture() {
  return {
    status: 'live',
    mode: 'tiled',
    fullStream: false,
    tiles: ['13/4446/2878'],
    mapsVersion: 1,
    upstream: { connected: true, lastMessageAt: Date.now(), error: null },
    objects: [
      {
        id: '00:30:e7:00:06:68',
        kind: 'tram',
        lon: CENTER.lon + 0.0012,
        lat: CENTER.lat + 0.0004,
        heading: 90,
        speedKmh: 23,
        lastSeen: now(),
        stale: false,
        name: null,
        line: '6',
        destination: 'St. Peter',
        vehicleNumber: '217',
        spat: null,
        hasMap: false,
      },
      {
        id: '00:30:e6:ff:ea:47',
        kind: 'bus',
        lon: CENTER.lon - 0.0015,
        lat: CENTER.lat - 0.0006,
        heading: 180,
        speedKmh: null,
        lastSeen: now(),
        stale: false,
        name: null,
        line: '33',
        destination: 'Jakominiplatz',
        vehicleNumber: '86',
        spat: null,
        hasMap: false,
      },
      {
        id: 'anon-0123456789abcdef',
        kind: 'car',
        anonymous: true,
        lon: CENTER.lon - 0.0008,
        lat: CENTER.lat + 0.0012,
        speedKmh: 48,
        lastSeen: now(),
        stale: false,
      },
      {
        id: '00:0d:41:ff:e0:81',
        kind: 'traffic_light',
        lon: CENTER.lon,
        lat: CENTER.lat,
        heading: null,
        speedKmh: null,
        lastSeen: now(),
        stale: false,
        name: 'Fixture crossing',
        line: null,
        destination: null,
        vehicleNumber: null,
        spat: [
          { group: '1', state: 6 },
          { group: '2', state: 3 },
        ],
        hasMap: true,
      },
    ],
    hazards: [
      {
        id: 'anon-hazard',
        kind: 'roadworks',
        label: 'Roadworks',
        position: [CENTER.lon + 0.002, CENTER.lat - 0.0015],
        paths: [
          [
            [CENTER.lon + 0.002, CENTER.lat - 0.0015],
            [CENTER.lon + 0.004, CENTER.lat - 0.0012],
          ],
        ],
        speedLimit: 30,
      },
    ],
  };
}
const INTERSECTIONS = {
  status: 'live',
  mode: 'tiled',
  mapsVersion: 1,
  intersections: [
    {
      id: '00:0d:41:ff:e0:81',
      name: 'Fixture crossing',
      lon: CENTER.lon,
      lat: CENTER.lat,
      lanes: [
        {
          id: '1',
          kind: 'vehicle',
          ingress: true,
          egress: false,
          signalGroups: ['1'],
          coordinates: [
            [CENTER.lon - 0.001, CENTER.lat],
            [CENTER.lon - 0.0001, CENTER.lat],
          ],
        },
      ],
    },
  ],
};

const chromeCandidates = [
  process.env.PUPPETEER_EXECUTABLE_PATH,
  await puppeteer.executablePath().catch(() => null),
].filter(Boolean);
const chrome = chromeCandidates.find((candidate) => {
  try {
    return fs.existsSync(candidate);
  } catch {
    return false;
  }
});

let failures = 0;
function check(name, ok, detail = '') {
  if (!ok) failures++;
  const label = ok ? '\x1b[32mPASS\x1b[0m' : '\x1b[31mFAIL\x1b[0m';
  console.log(`  [${label}] ${name}${detail ? `  — ${detail}` : ''}`);
}
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function main() {
  if (!chrome) {
    console.error('No Chromium found; set PUPPETEER_EXECUTABLE_PATH.');
    process.exit(2);
  }
  fs.mkdirSync(SHOTS_DIR, { recursive: true });
  const browser = await puppeteer.launch({
    executablePath: chrome,
    headless: HEADFUL ? false : 'new',
    protocolTimeout: 300_000,
    args: [
      '--no-sandbox',
      '--window-size=1440,900',
      '--use-angle=swiftshader',
      '--enable-unsafe-swiftshader',
      '--disable-background-timer-throttling',
      '--disable-renderer-backgrounding',
    ],
  });
  const consoleErrors = [];
  let citsRequests = 0;
  try {
    const page = await browser.newPage();
    await page.setViewport({ width: 1440, height: 900 });
    page.on('pageerror', (error) => consoleErrors.push(error.message));
    page.on('console', (message) => {
      if (message.type() !== 'error') return;
      const text = message.text();
      // Base-map tile misses are unrelated to this layer.
      if (/Failed to load resource/.test(text)) return;
      consoleErrors.push(text);
    });
    await page.setRequestInterception(true);
    page.on('request', (request) => {
      const url = new URL(request.url());
      if (!url.pathname.startsWith('/api/cits/')) return request.continue();
      citsRequests++;
      const body = url.pathname.endsWith('/intersections')
        ? INTERSECTIONS
        : stateFixture();
      return request.respond({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(body),
      });
    });

    await page.goto(APP_URL.href, { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => !!window.__godsEyeView?.dataManager, {
      timeout: 120_000,
    });
    await page.evaluate(({ lon, lat }) => {
      const viewer = window.__godsEyeView.viewer;
      viewer.camera.cancelFlight();
      viewer.camera.setView({
        destination: viewer.scene.globe.ellipsoid.cartographicToCartesian({
          longitude: (lon * Math.PI) / 180,
          latitude: (lat * Math.PI) / 180,
          height: 900,
        }),
        orientation: { heading: 0, pitch: -Math.PI / 2, roll: 0 },
      });
    }, CENTER);
    await sleep(3000);

    const rowControlsShown = () =>
      page.evaluate(() => {
        const node = document.querySelector(
          '[data-layer-id="cits"] .data-toggle-controls',
        );
        return Boolean(node && !node.hidden);
      });
    check(
      '(i) LIVE — row controls are hidden while the layer is off',
      (await rowControlsShown()) === false,
    );

    await page.evaluate(() =>
      window.__godsEyeView.dataManager.setEnabled('cits', true, {
        origin: 'user',
      }),
    );
    await page.waitForFunction(
      () =>
        window.__godsEyeView.dataManager.layers.get('cits').module.getStats()
          .status === 'live',
      { timeout: 30_000 },
    );
    await sleep(2500);

    const snapshot = () =>
      page.evaluate(async () => {
        const viewer = window.__godsEyeView.viewer;
        const dots = {};
        for (const collection of viewer.scene.primitives._primitives)
          for (const point of collection?._pointPrimitives || [])
            if (typeof point.id === 'string' && point.id.startsWith('cits:'))
              dots[point.id] = viewer.scene.cartesianToCanvasCoordinates(
                point.position,
              );
        const layer =
          window.__godsEyeView.dataManager.layers.get('cits').module;
        const { getOverlayPaintRect, getWorldOverlayDiagnostics } =
          await import('/src/overlays/worldOverlay.js');
        const diagnostics = getWorldOverlayDiagnostics();
        // Paint rects are valid for one frame: read them right after a render.
        const painted = await new Promise((resolve) => {
          let frames = 0;
          const remove = viewer.scene.postRender.addEventListener(() => {
            const rect = getOverlayPaintRect(
              'cits-selected',
              'cits-card:00:30:e7:00:06:68',
            );
            if (rect || ++frames >= 10) {
              remove();
              resolve(rect);
            } else viewer.scene.requestRender();
          });
          viewer.scene.requestRender();
          setTimeout(() => {
            remove();
            resolve(null);
          }, 3000);
        });
        const controls = document.querySelector(
          '[data-layer-id="cits"] .data-toggle-controls',
        );
        return {
          dots,
          stats: layer.getStats(),
          chips: layer.getRowControls().chips.map((chip) => chip.id),
          detectable: layer.getDetectableObjects().map((item) => item.id),
          rowControls: Boolean(controls && !controls.hidden),
          rowList: [
            ...document.querySelectorAll(
              '[data-layer-id="cits"] .data-row-list-item',
            ),
          ].map((node) => node.textContent),
          selectedEntries: diagnostics.entriesBySource?.['cits-selected'] || 0,
          card: painted?.entry
            ? [painted.entry.title, ...(painted.entry.details || [])].join(
                '\n',
              )
            : null,
        };
      });

    let state = await snapshot();
    check('(i) LIVE — row controls appear with the layer', state.rowControls);
    check(
      '(i) LIVE — every fixture station and the hazard are drawn',
      Object.keys(state.dots).length === 5,
      `${Object.keys(state.dots).length} dots`,
    );
    check(
      '(i) LIVE — intersection lanes are loaded',
      state.stats.intersections === 1,
      `${state.stats.intersections}`,
    );
    check(
      '(i) LIVE — high-bandwidth chips stay hidden without the operator opt-in',
      !state.chips.some((id) => id.startsWith('bandwidth-')),
      state.chips.join(','),
    );
    check(
      '(ii) ANONYMOUS — the car is never handed to detection',
      !state.detectable.some((id) => id.includes('anon-')),
      state.detectable.join(','),
    );
    check(
      '(iv) CONTROLS — the kind list shows live counts',
      state.rowList.some((text) => /^1\s*Trams$/.test(text)) &&
        state.rowList.some((text) => /^1\s*Cars$/.test(text)),
      state.rowList.join(' | '),
    );
    await page.screenshot({ path: path.join(SHOTS_DIR, 'cits-live.png') });

    // Click each station at the view centre, clear of the app's chrome.
    const clickStation = async (lon, lat, id) => {
      await page.evaluate(
        ({ lon, lat }) => {
          const viewer = window.__godsEyeView.viewer;
          viewer.camera.setView({
            destination: viewer.scene.globe.ellipsoid.cartographicToCartesian({
              longitude: (lon * Math.PI) / 180,
              latitude: (lat * Math.PI) / 180,
              height: 600,
            }),
            orientation: { heading: 0, pitch: -Math.PI / 2, roll: 0 },
          });
        },
        { lon, lat },
      );
      await sleep(2500);
      const at = (await snapshot()).dots[id];
      const picked = await page.evaluate(
        ({ x, y }) => {
          const viewer = window.__godsEyeView.viewer;
          const hit = viewer.scene.pick({ x, y });
          return typeof hit?.id === 'string' ? hit.id : null;
        },
        { x: at.x, y: at.y },
      );
      await page.mouse.click(at.x, at.y);
      await sleep(800);
      return picked;
    };
    const fixture = stateFixture().objects;
    const carRecord = fixture.find((object) => object.kind === 'car');
    const tramRecord = fixture.find((object) => object.kind === 'tram');
    const carId = Object.keys(state.dots).find((id) => id.includes('anon-0'));
    const tramId = Object.keys(state.dots).find((id) =>
      id.includes('00:30:e7'),
    );
    const carPick = await clickStation(carRecord.lon, carRecord.lat, carId);
    check(
      '(ii) ANONYMOUS — the click lands on the car dot',
      carPick === carId,
      `${carPick}`,
    );
    state = await snapshot();
    check(
      '(ii) ANONYMOUS — clicking the car publishes no card',
      state.selectedEntries === 0,
      `${state.selectedEntries} selected entries`,
    );

    await clickStation(tramRecord.lon, tramRecord.lat, tramId);
    state = await snapshot();
    check(
      '(iii) CARDS — clicking the tram publishes one selected card',
      state.selectedEntries === 1,
      `${state.selectedEntries} selected entries`,
    );
    check(
      '(iii) CARDS — the painted card names the line and destination',
      /^TRAM · 6 → St\. Peter/.test(state.card || ''),
      (state.card || '').replace(/\n/g, ' | '),
    );
    await page.screenshot({ path: path.join(SHOTS_DIR, 'cits-card.png') });

    // Empty space: well away from every fixture station.
    await page.mouse.click(120, 820);
    await sleep(800);
    state = await snapshot();
    check(
      '(iii) CARDS — an empty-space click clears the card',
      state.selectedEntries === 0,
      `${state.selectedEntries} selected entries`,
    );

    const toggleCars = () =>
      page.evaluate(() => {
        const button = [
          ...document.querySelectorAll(
            '[data-layer-id="cits"] .data-row-list-item',
          ),
        ].find((node) => /Cars$/.test(node.textContent));
        button?.click();
        return Boolean(button);
      });
    const clicked = await toggleCars();
    await sleep(2500);
    state = await snapshot();
    check(
      '(iv) CONTROLS — the Cars switch removes the car dot',
      clicked &&
        !Object.keys(state.dots).some((id) => id.includes('anon-0')) &&
        Object.keys(state.dots).length === 4,
      `${Object.keys(state.dots).length} dots`,
    );
    await toggleCars();

    await page.evaluate(() =>
      window.__godsEyeView.dataManager.setEnabled('cits', false, {
        origin: 'user',
      }),
    );
    await sleep(1000);
    const requestsAtDisable = citsRequests;
    state = await snapshot();
    check(
      '(v) TEARDOWN — disable removes every dot, the card and the row controls',
      Object.keys(state.dots).length === 0 &&
        state.selectedEntries === 0 &&
        state.rowControls === false,
    );
    await sleep(4000);
    check(
      '(v) TEARDOWN — polling stops after disable',
      citsRequests === requestsAtDisable,
      `${citsRequests - requestsAtDisable} late request(s)`,
    );
    check(
      '(v) TEARDOWN — no console errors',
      consoleErrors.length === 0,
      consoleErrors.slice(0, 3).join(' | '),
    );
  } finally {
    await browser.close();
  }
  console.log(`\n  RESULT: ${failures ? `${failures} failed` : 'all passed'}`);
  process.exitCode = failures ? 1 : 0;
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
