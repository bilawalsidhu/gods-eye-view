#!/usr/bin/env node
// Border Wait Times browser gate: the real app, the live CBP feed through
// /api/border-waits, a marker click and its card, and a clean disable.
//
// Run against the dev server (it reads overlay diagnostics from the served
// source module) at QA_BASE_URL (default http://localhost:4173):
//   npm run qa:border-waits
import { existsSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import puppeteer from 'puppeteer';

const BASE = process.env.QA_BASE_URL || 'http://localhost:4173';
const SHOTS = process.env.QA_SHOTS || 'qa-shots/border-waits';
const HEADFUL = process.argv.includes('--headful');
const SOURCE_ID = 'border-waits';
const LAYER_ID = 'border-waits';
// Detroit's three crossings into Windsor, framed from above.
const DETROIT = { lat: 42.305, lon: -83.07, alt: 14000 };

const CHROME_CANDIDATES = [
  process.env.PUPPETEER_EXECUTABLE_PATH,
  await puppeteer.executablePath().catch(() => null),
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Chromium.app/Contents/MacOS/Chromium',
].filter(Boolean);
const chrome = CHROME_CANDIDATES.find((candidate) => existsSync(candidate));

let failed = 0;
function check(name, ok, detail = '') {
  const tag = ok ? '\x1b[32mPASS\x1b[0m' : '\x1b[31mFAIL\x1b[0m';
  console.log(`  [${tag}] ${name}${detail ? `  — ${detail}` : ''}`);
  if (!ok) failed++;
}
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

await mkdir(SHOTS, { recursive: true });
const browser = await puppeteer.launch({
  headless: HEADFUL ? false : 'new',
  protocolTimeout: 300_000,
  ...(chrome ? { executablePath: chrome } : {}),
  args: [
    '--no-sandbox',
    ...(HEADFUL ? [] : ['--use-gl=angle', '--use-angle=swiftshader']),
    '--disable-background-timer-throttling',
    '--disable-renderer-backgrounding',
    '--disable-backgrounding-occluded-windows',
    '--window-size=1280,800',
  ],
});

try {
  const page = await browser.newPage();
  await page.setViewport({ width: 1280, height: 800 });
  const pageErrors = [];
  page.on('pageerror', (error) => pageErrors.push(error.message));
  const proxyResponses = [];
  page.on('response', (response) => {
    if (new URL(response.url()).pathname === '/api/border-waits')
      proxyResponses.push(response.status());
  });
  const shot = (name) =>
    page.screenshot({ path: `${SHOTS}/${name}`, type: 'jpeg', quality: 82 });

  await page.goto(
    `${BASE}/?welcome=0#lat=${DETROIT.lat}&lon=${DETROIT.lon}&alt=${DETROIT.alt}&heading=0&pitch=-90`,
    { waitUntil: 'domcontentloaded' },
  );
  await page.waitForFunction(
    (id) =>
      Boolean(window.__godsEyeView?.dataManager?.layers?.get(id)) &&
      Boolean(document.querySelector(`[data-layer-id="${id}"]`)),
    { timeout: 120_000 },
    LAYER_ID,
  );
  // The globe takes clicks only once the loading screen has gone.
  await page.waitForFunction(
    () =>
      document.getElementById('loading-screen')?.classList.contains('hidden'),
    { timeout: 120_000 },
  );
  check(
    'the layer has a row in the Data Layers panel',
    Boolean(await page.$(`[data-layer-id="${LAYER_ID}"]`)),
  );

  await page.evaluate(
    (id) =>
      window.__godsEyeView.dataManager.setEnabled(id, true, { origin: 'user' }),
    LAYER_ID,
  );
  await page.waitForFunction(
    (id) =>
      window.__godsEyeView.dataManager.layers.get(id).module.getStats().count >
      0,
    { timeout: 60_000 },
    LAYER_ID,
  );
  const stats = await page.evaluate(
    (id) => window.__godsEyeView.dataManager.layers.get(id).module.getStats(),
    LAYER_ID,
  );
  check(
    'the live CBP snapshot loads through the same-origin proxy',
    stats.count >= 80 && proxyResponses.includes(200),
    `${stats.count} crossings, proxy ${proxyResponses.join(',')}`,
  );
  check('the snapshot is current, not stale', stats.stale === false);

  // Every Michigan crossing is on the map with a marker.
  const michigan = await page.evaluate((id) => {
    const layer = window.__godsEyeView.dataManager.layers.get(id).module;
    return layer
      .getAnalystRecords()
      .filter(({ id: crossing }) => crossing.startsWith('38'))
      .map(({ id: crossing, crossing: name, delayMinutes }) => ({
        crossing,
        name,
        delayMinutes,
      }));
  }, LAYER_ID);
  check(
    "Michigan's five crossings are drawn",
    michigan.length === 5,
    michigan
      .map(({ name, delayMinutes }) => `${name}: ${delayMinutes ?? '–'} min`)
      .join('; '),
  );

  const canada = await page.evaluate(async () => {
    const payload = await (await fetch('/api/border-waits')).json();
    return {
      available: payload.canada?.available === true,
      michigan: payload.rows.filter(
        ({ id, canada: into }) => id.startsWith('38') && into,
      ).length,
    };
  });
  check(
    'waits into Canada (CBSA) reach the Michigan crossings',
    canada.available && canada.michigan === 5,
    `${canada.michigan} of 5`,
  );

  await wait(3_000);
  const overlay = await page.evaluate(async (source) => {
    const { getWorldOverlayDiagnostics } = await import(
      '/src/overlays/worldOverlay.js'
    );
    const diagnostics = getWorldOverlayDiagnostics();
    return {
      entries: diagnostics.entriesBySource?.[source] ?? 0,
      painted: diagnostics.paintedBySource?.[source] ?? 0,
    };
  }, SOURCE_ID);
  check(
    'minute labels reach the overlay and paint',
    overlay.entries > 0 && overlay.painted > 0,
    `${overlay.entries} entries, ${overlay.painted} painted`,
  );
  await shot('01-detroit-markers.jpg');

  // Click the Ambassador Bridge marker where Cesium draws it.
  const target = await page.evaluate((id) => {
    const app = window.__godsEyeView;
    const source = app.viewer.dataSources.getByName(id)[0];
    const entity = source.entities.getById(`${id}:380001`);
    const position = entity.position.getValue(app.viewer.clock.currentTime);
    const xy = app.viewer.scene.cartesianToCanvasCoordinates(position);
    const rect = app.viewer.scene.canvas.getBoundingClientRect();
    return xy ? { x: rect.left + xy.x, y: rect.top + xy.y } : null;
  }, LAYER_ID);
  check('the Ambassador Bridge marker is on screen', Boolean(target));
  if (target) {
    await page.mouse.click(target.x, target.y);
    await wait(1_500);
    const afterClick = await page.evaluate(async (source) => {
      const { getWorldOverlayDiagnostics } = await import(
        '/src/overlays/worldOverlay.js'
      );
      return getWorldOverlayDiagnostics().entriesBySource?.[source] ?? 0;
    }, SOURCE_ID);
    check(
      'clicking the marker adds its crossing card',
      afterClick === overlay.entries + 1,
      `${overlay.entries} → ${afterClick} entries`,
    );
    await shot('02-ambassador-card.jpg');
  }

  await page.evaluate(
    (id) =>
      window.__godsEyeView.dataManager.setEnabled(id, false, {
        origin: 'user',
      }),
    LAYER_ID,
  );
  await wait(1_000);
  const disabled = await page.evaluate(async (source) => {
    const { getWorldOverlayDiagnostics } = await import(
      '/src/overlays/worldOverlay.js'
    );
    return getWorldOverlayDiagnostics().entriesBySource?.[source] ?? 0;
  }, SOURCE_ID);
  check('disabling clears the labels and card', disabled === 0);
  check('no page errors', pageErrors.length === 0, pageErrors.join(' | '));
} finally {
  await browser.close();
}

console.log(failed ? `\n${failed} check(s) failed` : '\nAll checks passed');
process.exit(failed ? 1 : 0);
