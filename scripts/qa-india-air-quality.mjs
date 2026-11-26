/**
 * Deterministic browser gate for India's Air quality provider (no API key).
 * Run against a dev server started with OPENAQ_API_KEY and DATA_GOV_IN_API_KEY
 * empty (the key chip must exist):
 * node scripts/qa-india-air-quality.mjs --url http://localhost:4173
 * Synthetic observations exercise presentation, not live CPCB availability.
 * OpenAQ answers an empty snapshot, so India is alone.
 */
import assert from 'node:assert/strict';
import puppeteer from 'puppeteer';
import { normalizeCpcbRecords } from '../src/layers/airQuality/cpcb.js';

const args = process.argv.slice(2);
const urlIndex = args.indexOf('--url');
const url = urlIndex >= 0 ? args[urlIndex + 1] : 'http://localhost:4173';
const EMPTY = { schemaVersion: 1, stations: [], readings: [] };
const browser = await puppeteer.launch({
  headless: true,
  args: [
    '--use-gl=angle',
    '--use-angle=swiftshader',
    '--enable-unsafe-swiftshader',
    '--no-sandbox',
  ],
  defaultViewport: { width: 1400, height: 1000 },
});
try {
  const page = await browser.newPage();
  await page.evaluateOnNewDocument(() =>
    localStorage.setItem('gev:first-run-mission:v1', 'suppressed'),
  );
  let mode = 'key';
  await page.setRequestInterception(true);
  page.on('request', (request) => {
    const path = new URL(request.url()).pathname;
    if (path === '/api/air-quality/openaq')
      return void request.respond({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(EMPTY),
      });
    if (path !== '/api/air-quality/india') return void request.continue();
    const ist = new Date(Date.now() - 10 * 60_000 + 330 * 60_000).toISOString();
    const last_update = `${ist.slice(8, 10)}-${ist.slice(5, 7)}-${ist.slice(0, 4)} ${ist.slice(11, 19)}`;
    const body =
      mode === 'key'
        ? { error: 'no_key' }
        : {
            schemaVersion: 1,
            ...normalizeCpcbRecords({
              records: [
                ['PM2.5', '123'],
                ['PM10', '77'],
              ].map(([pollutant_id, avg_value]) => ({
                country: 'India',
                state: 'Delhi',
                city: 'Delhi',
                station: 'QA synthetic station',
                latitude: '28.6',
                longitude: '77.2',
                pollutant_id,
                avg_value,
                last_update,
              })),
            }),
            stale: mode === 'stale',
          };
    void request.respond({
      status: mode === 'key' ? 428 : 200,
      contentType: 'application/json',
      body: JSON.stringify(body),
    });
  });
  // A provider that said it has no key, or that answered, is left alone for a
  // while (the layer keeps its answer), so each case starts on a fresh load.
  const open = async () => {
    await gotoSafely(page, url, {
      waitUntil: 'domcontentloaded',
      timeout: 90_000,
    });
    await page.waitForFunction(() => window.__godsEyeView?.dataManager, {
      timeout: 90_000,
    });
    await new Promise((resolve) => setTimeout(resolve, 1500));
    const explore = await page.$('[data-first-run-choice="explore"]');
    if (explore && (await explore.isVisible())) await explore.click();
    await page.evaluate(async () => {
      const { dataManager: dm, viewer } = window.__godsEyeView;
      const { cameraOf } = await import('/src/render/rendererOf.js');
      const camera = cameraOf(viewer);
      camera.cancelFlight();
      camera.setView({
        destination: { lon: 77.2, lat: 28.6, height: 80_000 },
      });
      await dm.setLayerParams('air-quality', { view: 'PM2.5' });
      await dm.setEnabled('air-quality', true);
    });
  };
  await open();
  const indiaState = () =>
    page.evaluate(
      () =>
        window.__godsEyeView.dataManager.layers
          .get('air-quality')
          .module.getProviderStates()
          .find((state) => state.id === 'cpcb') ?? null,
    );
  await page.waitForFunction(() =>
    window.__godsEyeView.dataManager.layers
      .get('air-quality')
      .module.getProviderStates()
      .some((state) => state.id === 'cpcb' && state.status === 'no-key'),
  );
  assert.match((await indiaState()).error, /DATA_GOV_IN_API_KEY/);
  mode = 'live';
  await open();
  await page.waitForFunction(
    () =>
      window.__godsEyeView.dataManager.layers
        .get('air-quality')
        .module.getStats().count === 1,
    { timeout: 30_000 },
  );
  const result = await page.evaluate(() => {
    const layer =
      window.__godsEyeView.dataManager.layers.get('air-quality').module;
    return {
      stats: layer.getStats(),
      records: layer.getAnalystRecords(),
      controls: layer.getRowControls(),
    };
  });
  assert.equal(result.stats.count, 1, JSON.stringify(result));
  assert.equal((await indiaState()).status, 'ok');
  assert.equal(result.records[0].provider, 'cpcb');
  assert.equal(result.records[0].scale, 'PM2.5');
  assert.equal(result.records[0].band, null);
  // Unverified units: India's station is unrated in the pollutant view.
  assert.equal(result.controls.list.items[0].swatch, '#8cb4ce');
  mode = 'stale';
  await open();
  await page.waitForFunction(
    () =>
      window.__godsEyeView.dataManager.layers
        .get('air-quality')
        .module.getRowControls()
        .summary.lines.some((line) => line.id === 'provider-cpcb'),
    { timeout: 30_000 },
  );
  const cached = await page.evaluate(
    () =>
      window.__godsEyeView.dataManager.layers
        .get('air-quality')
        .module.getRowControls().summary.lines,
  );
  assert.match(
    cached.find((line) => line.id === 'provider-cpcb').text,
    /showing cached data/,
  );
  // The key is a normal Provider Settings entry.
  // The server for this gate runs with no keys, so the chip always shows.
  await page.waitForSelector('#key-setup-chip', { visible: true });
  await page.click('#key-setup-chip');
  await page.waitForSelector('#key-setup.visible');
  const keys = await page.$$eval('#key-setup input[data-env-var]', (nodes) =>
    nodes.map((node) => node.dataset.envVar),
  );
  assert.ok(keys.includes('DATA_GOV_IN_API_KEY'));
  assert.ok(keys.includes('OPENAQ_API_KEY'));
  await page.click('[data-key-setup-close]');
  await page.waitForSelector('#key-setup', { hidden: true });
  // Exercise the real pollutant tile of the Weather card.
  const header = await page.$('[data-card-id="air-quality"] .rail-card-header');
  assert.ok(header, 'Air quality card is mounted');
  if (
    await header.evaluate(
      (node) => node.getAttribute('aria-expanded') !== 'true',
    )
  )
    await header.click();
  await page.click('[data-card-id="air-quality"] [data-tile-id="PM10"]');
  await page.waitForFunction(() => {
    const layer =
      window.__godsEyeView.dataManager.layers.get('air-quality').module;
    return (
      layer.getParams().view === 'PM10' &&
      layer.getProviderStates().find((s) => s.id === 'cpcb')?.status === 'ok' &&
      layer.getAnalystRecords().some((r) => r.provider === 'cpcb')
    );
  });
  const rows = await page.evaluate(() =>
    window.__godsEyeView.dataManager.layers
      .get('air-quality')
      .module.getAnalystRecords(),
  );
  assert.ok(
    rows.some(
      (r) =>
        r.provider === 'cpcb' &&
        r.parameter === 'PM10' &&
        r.reportedValue === 77,
    ),
  );
  assert.ok(rows.every((r) => r.reportedValue !== 123));
  console.log(
    'PASS India air quality: key required, station rendering, unrated values, stale cache, Provider Settings key, pollutant isolation',
  );
} finally {
  await browser.close();
}

/** Opens `target`; a failure names its origin only, never a query that may carry a token. */
async function gotoSafely(page, target, options) {
  try {
    return await page.goto(target, options);
  } catch (error) {
    throw new Error(
      `navigation to ${new URL(target).origin} failed: ${String(error?.message ?? error).split(' at ')[0]}`,
    );
  }
}
