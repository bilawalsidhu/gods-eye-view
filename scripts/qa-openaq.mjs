/** Real-app OpenAQ gate. Runs with explicit synthetic data; never writes keys.
 * QA_BASE_URL=http://127.0.0.1:4174 node scripts/qa-openaq.mjs
 */
import assert from 'node:assert/strict';
import puppeteer from 'puppeteer';
const base = process.env.QA_BASE_URL || 'http://127.0.0.1:4173';
const fixtures = [
  ['KE', 'Nairobi', -1.28, 36.82],
  ['NG', 'Lagos', 6.46, 3.39],
  ['EG', 'Cairo', 30.04, 31.24],
  ['ZA', 'Cape Town', -33.92, 18.42],
  ['MG', 'Antananarivo', -18.88, 47.5],
];
const readings = fixtures.map(([country, name, lat, lon], i) => ({
  id: `openaq:${i}:1`,
  stationId: String(i),
  provider: 'openaq',
  country,
  name,
  lat,
  lon,
  parameter: 'PM2.5',
  scale: 'PM2.5',
  units: 'µg/m³',
  value: 10 + i,
  label: `${10 + i} µg/m³`,
  observedMs: Date.now(),
  kind: 'observation',
  rating: null,
  band: null,
  risk: null,
  color: '#8cb4ce',
  owner: 'Fixture network',
  network: 'Fixture',
  zone: country,
}));
const payload = {
  schemaVersion: 1,
  stations: readings,
  readings,
  checked: 5,
  eligible: 5,
  countriesReporting: 5,
  partial: false,
  stale: false,
};
const browser = await puppeteer.launch({
  headless: !process.argv.includes('--headful'),
  args: [
    '--no-sandbox',
    ...(process.platform === 'darwin'
      ? ['--use-angle=metal', '--enable-gpu']
      : ['--use-angle=swiftshader', '--enable-unsafe-swiftshader']),
  ],
});
try {
  const page = await browser.newPage();
  await page.setViewport({ width: 1440, height: 1000 });
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  const cdp = await page.createCDPSession();
  let status = 200;
  await cdp.send('Fetch.enable', {
    patterns: [{ urlPattern: '*/api/air-quality/openaq*' }],
  });
  cdp.on('Fetch.requestPaused', async ({ requestId }) =>
    cdp.send('Fetch.fulfillRequest', {
      requestId,
      responseCode: status,
      responseHeaders: [{ name: 'Content-Type', value: 'application/json' }],
      body: Buffer.from(
        JSON.stringify(status === 200 ? payload : { error: 'no_key' }),
      ).toString('base64'),
    }),
  );
  await page.goto(
    `${base}/?welcome=0&setup=1#v=2&lat=0&lon=20&alt=12000000&pitch=-90&map=esri-imagery&l=4&lo=4.p.o`,
    { waitUntil: 'domcontentloaded', timeout: 90000 },
  );
  await page.waitForFunction(
    () =>
      window.__godsEyeView?.dataManager &&
      document.getElementById('loading-screen')?.classList.contains('hidden') &&
      Number(
        getComputedStyle(document.getElementById('loading-screen')).opacity,
      ) === 0,
    { timeout: 90000 },
  );
  await page.waitForSelector('input[data-env-var="OPENAQ_API_KEY"]', {
    visible: true,
    timeout: 15000,
  });
  const input = await page.$eval(
    'input[data-env-var="OPENAQ_API_KEY"]',
    (el) => ({ type: el.type, value: el.value }),
  );
  assert.equal(input.type, 'password');
  assert.equal(input.value, '');
  await page.click('[data-key-setup-close]');
  await page.waitForFunction(
    () =>
      window.__godsEyeView.dataManager.layers
        .get('air-quality')
        .module.getStats().count === 5,
    { timeout: 10000 },
  );
  let state = await page.evaluate(() => {
    const m = window.__godsEyeView.dataManager.layers.get('air-quality').module;
    return {
      params: m.getParams(),
      records: m.getAnalystRecords(),
      controls: m.getRowControls(),
    };
  });
  assert.equal(state.params.provider, 'openaq');
  assert.deepEqual(
    new Set(state.records.map((r) => r.country)),
    new Set(fixtures.map((r) => r[0])),
  );
  assert.equal(state.controls.summary.settings[0].chips.length, 3);
  assert.ok(
    state.controls.list.items.every((r) => r.badge === 'Index unavailable'),
  );
  console.log(
    'PASS: existing Provider Settings has a masked, empty OpenAQ field; Africa fixture renders through shared layer',
  );
  status = 428;
  await page.evaluate(() =>
    window.__godsEyeView.dataManager.layers.get('air-quality').module.update(),
  );
  assert.match(
    await page.evaluate(
      () =>
        window.__godsEyeView.dataManager.layers
          .get('air-quality')
          .module.getStats().error,
    ),
    /Provider Settings/,
  );
  console.log(
    'PASS: missing key gives Provider Settings guidance, without replacing data with fake readings',
  );
  assert.deepEqual(errors, []);
} finally {
  await browser.close();
}
