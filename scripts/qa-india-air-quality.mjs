/**
 * Deterministic browser gate for India's Air quality card (no API key).
 * Run: node scripts/qa-india-air-quality.mjs --url http://localhost:4173
 * Synthetic observations exercise presentation, not live CPCB availability.
 */
import assert from 'node:assert/strict';
import puppeteer from 'puppeteer';

const args = process.argv.slice(2);
const urlIndex = args.indexOf('--url');
const url = urlIndex >= 0 ? args[urlIndex + 1] : 'http://localhost:4173';
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
    if (!request.url().includes('/api/air-quality/india'))
      return void request.continue();
    const ist = new Date(Date.now() + 330 * 60_000).toISOString();
    const last_update = `${ist.slice(8, 10)}-${ist.slice(5, 7)}-${ist.slice(0, 4)} ${ist.slice(11, 19)}`;
    const payload =
      mode === 'key'
        ? { error: 'key_required' }
        : {
            stale: mode === 'stale',
            records: [
              {
                country: 'India',
                state: 'Delhi',
                city: 'Delhi',
                station: 'QA synthetic station',
                latitude: '28.6',
                longitude: '77.2',
                pollutant_id: 'PM2.5',
                avg_value: '123',
                last_update,
              },
            ],
          };
    void request.respond({
      status: mode === 'key' ? 503 : 200,
      contentType: 'application/json',
      body: JSON.stringify(payload),
    });
  });
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 90_000 });
  await page.waitForFunction(() => window.__godsEyeView?.dataManager, {
    timeout: 90_000,
  });
  await new Promise((resolve) => setTimeout(resolve, 1500));
  const explore = await page.$('[data-first-run-choice="explore"]');
  if (explore && (await explore.isVisible())) await explore.click();
  await page.evaluate(async () => {
    const dm = window.__godsEyeView.dataManager;
    await dm.setLayerParams('air-quality', { provider: 'cpcb' });
    await dm.setEnabled('air-quality', true);
  });
  await page.waitForFunction(() =>
    window.__godsEyeView.dataManager.layers
      .get('air-quality')
      .module.getStats()
      .error?.includes('API key'),
  );
  mode = 'live';
  const result = await page.evaluate(async () => {
    await window.__godsEyeView.dataManager.setEnabled('air-quality', true);
    const layer =
      window.__godsEyeView.dataManager.layers.get('air-quality').module;
    await layer.update();
    return {
      stats: layer.getStats(),
      records: layer.getAnalystRecords(),
      controls: layer.getRowControls(),
    };
  });
  assert.equal(result.stats.count, 1, JSON.stringify(result));
  assert.equal(result.records[0].provider, 'cpcb');
  assert.equal(result.records[0].scale, 'PM2.5');
  assert.equal(result.records[0].band, null);
  assert.deepEqual(result.controls.legend, []);
  assert.match(result.controls.summary.detail, /not an overall AQI/);
  mode = 'stale';
  const stale = await page.evaluate(async () => {
    const layer =
      window.__godsEyeView.dataManager.layers.get('air-quality').module;
    await layer.update();
    return { stats: layer.getStats(), controls: layer.getRowControls() };
  });
  assert.equal(stale.stats.stale, true);
  assert.ok(
    stale.controls.summary.lines.some((line) => /cached/.test(line.text)),
  );
  // Exercise the actual pollutant action through the panel's parameter route.
  const header = await page.$('[data-card-id="air-quality"] .rail-card-header');
  assert.ok(header, 'Air quality card is mounted');
  if (
    await header.evaluate(
      (node) => node.getAttribute('aria-expanded') !== 'true',
    )
  )
    await header.click();
  await page.click(
    '[data-card-id="air-quality"] [data-action-id="connection"]',
  );
  await page.waitForSelector('#key-setup.visible');
  assert.deepEqual(
    await page.$$eval('#key-setup input[data-env-var]', (nodes) =>
      nodes.map((node) => node.dataset.envVar),
    ),
    ['DATA_GOV_IN_API_KEY'],
  );
  await page.click('[data-key-setup-close]');
  await page.waitForSelector('#key-setup', { hidden: true });
  await page.click('#key-setup-chip');
  await page.waitForSelector('#key-setup.visible');
  const generalKeys = await page.$$eval(
    '#key-setup input[data-env-var]',
    (nodes) => nodes.map((node) => node.dataset.envVar),
  );
  assert.ok(!generalKeys.includes('DATA_GOV_IN_API_KEY'));
  assert.ok(generalKeys.includes('GOOGLE_MAPS_API_KEY'));
  await page.click('[data-key-setup-close]');
  await page.waitForSelector('#key-setup', { hidden: true });
  await page.click('[data-card-id="air-quality"] [data-action-id="PM10"]');
  await page.waitForFunction(() => {
    const layer =
      window.__godsEyeView.dataManager.layers.get('air-quality').module;
    return (
      layer.getParams().pollutant === 'PM10' &&
      layer.getStats().lastUpdate !== null
    );
  });
  const empty = await page.evaluate(() =>
    window.__godsEyeView.dataManager.layers
      .get('air-quality')
      .module.getStats(),
  );
  assert.equal(empty.count, 0, 'PM2.5 must not be relabeled as PM10');
  console.log(
    'PASS India air quality: key required, station rendering, neutral values, stale cache, pollutant isolation',
  );
} finally {
  await browser.close();
}
