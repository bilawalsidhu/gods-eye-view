/** Real-app OpenAQ gate. Runs with explicit synthetic data; never writes keys.
 * Start the dev server with OPENAQ_API_KEY empty, then
 * point QA_BASE_URL at it: QA_BASE_URL=<the dev server> node scripts/qa-openaq.mjs
 */
import assert from 'node:assert/strict';
import puppeteer from 'puppeteer';
import { interpretHourly } from '../src/layers/airQuality/interpretation.js';
const base = process.env.QA_BASE_URL || 'http://127.0.0.1:4173';
const fixtures = [
  ['KE', 'Nairobi', -1.28, 36.82],
  ['US', 'New York', 40.71, -74.01],
  ['JP', 'Tokyo', 35.68, 139.69],
  ['ZA', 'Cape Town', -33.92, 18.42],
  ['BR', 'São Paulo', -23.55, -46.63],
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
  averagingMinutes: 60,
  coveragePercent: 100,
  qualityFlagged: false,
  band: null,
  risk: null,
  color: '#8cb4ce',
  owner: 'Fixture network',
  network: 'Fixture',
  zone: country,
}));
for (const row of readings) Object.assign(row, interpretHourly(row));
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
  let scoped = false;
  const requestedKinds = [];
  const requestedViews = [];
  await cdp.send('Fetch.enable', {
    patterns: [{ urlPattern: '*/api/air-quality/openaq*' }],
  });
  cdp.on('Fetch.requestPaused', async ({ requestId, request }) => {
    const query = new URL(request.url).searchParams;
    const kind = query.get('mode') === 'aqi' ? 'aqi' : query.get('parameter');
    requestedKinds.push(kind);
    const valid = kind === 'aqi' || kind === 'PM2.5';
    const raw = query.get('view');
    const view = raw?.split(',').map(Number);
    requestedViews.push(view);
    const selected =
      scoped && view
        ? readings.filter(
            (r) =>
              r.lat >= view[1] &&
              r.lat <= view[3] &&
              (view[0] < view[2]
                ? r.lon >= view[0] && r.lon <= view[2]
                : r.lon >= view[0] || r.lon <= view[2]),
          )
        : readings;
    await new Promise((resolve) => setTimeout(resolve, scoped ? 700 : 5000));
    await cdp
      .send('Fetch.fulfillRequest', {
        requestId,
        responseCode: valid ? status : 400,
        responseHeaders: [{ name: 'Content-Type', value: 'application/json' }],
        body: Buffer.from(
          JSON.stringify(
            !valid
              ? { error: 'unexpected' }
              : status === 200
                ? {
                    ...payload,
                    readings:
                      kind === 'aqi'
                        ? selected.map((r, i) => ({ ...r, value: 30 + i }))
                        : selected,
                    stations: selected,
                  }
                : {
                    error: status === 429 ? 'rate_limited' : 'no_key',
                    retryAt: status === 429 ? Date.now() + 1500 : null,
                  },
          ),
        ).toString('base64'),
      })
      .catch(() => {}); // Navigation/disable may have cancelled the request.
  });
  await gotoSafely(
    page,
    `${base}/?welcome=0&setup=1#v=2&lat=0&lon=20&alt=12000000&pitch=-90&map=esri-imagery&l=4`,
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
  // The server for this gate runs with no keys, so the panel always opens.
  await page.waitForSelector('input[data-env-var="OPENAQ_API_KEY"]', {
    visible: true,
    timeout: 15000,
  });
  const input = await page.$eval(
    'input[data-env-var="OPENAQ_API_KEY"]',
    (el) => ({ type: el.type, empty: el.value.length === 0 }),
  );
  assert.equal(input.type, 'password');
  assert.equal(input.empty, true);
  await page.click('[data-key-setup-close]');
  const layerState = () =>
    page.evaluate(() => {
      const m =
        window.__godsEyeView.dataManager.layers.get('air-quality').module;
      return {
        params: m.getParams(),
        stats: m.getStats(),
        records: m.getAnalystRecords(),
        controls: m.getRowControls(),
        providers: m.getProviderStates(),
      };
    });
  await page.waitForFunction(
    () => {
      const layer =
        window.__godsEyeView.dataManager.layers.get('air-quality').module;
      return layer.getStats().count === 5;
    },
    { timeout: 10000 },
  );
  // Every provider is read together; this gate looks at one pollutant.
  await page.evaluate(() =>
    window.__godsEyeView.dataManager.layers
      .get('air-quality')
      .module.setParams({ view: 'PM2.5' }),
  );
  await page.waitForFunction(
    () => {
      const controls = window.__godsEyeView.dataManager.layers
        .get('air-quality')
        .module.getRowControls();
      return controls.list.items.length > 0;
    },
    { timeout: 10000 },
  );
  let state = await layerState();
  assert.equal(state.params.view, 'PM2.5');
  assert.ok(state.records.every((r) => r.value < 20));
  assert.ok(requestedKinds.includes('aqi') && requestedKinds.includes('PM2.5'));
  assert.deepEqual(
    new Set(state.records.map((r) => r.country)),
    new Set(fixtures.map((r) => r[0])),
  );
  // The slim tile card: the one index (the US AQI) and six pollutants, no
  // provider picker.
  assert.deepEqual(
    state.controls.sublists.map((group) => [group.id, group.tiles.length]),
    [
      ['index', 1],
      ['pollutants', 6],
    ],
  );
  assert.ok(state.records.every((r) => r.assessment?.label === 'Fair'));
  console.log(
    'PASS: masked, empty OpenAQ key field; worldwide fixture renders through the shared layer',
  );
  assert.equal(state.controls.legend.length, 6);
  assert.ok(state.records.every((r) => r.assessment.general));
  assert.ok(
    await page.$('[data-card-id="air-quality"] [data-tile-id="PM2.5"]'),
  );
  console.log(
    'PASS: hourly comparison shows category, guidance, numeric legend and the tile card',
  );
  scoped = true;
  async function navigate(lat, lon) {
    await page.evaluate(
      async ({ lat, lon }) => {
        const { viewer } = window.__godsEyeView;
        const { cameraOf } = await import('/src/render/rendererOf.js');
        const camera = cameraOf(viewer);
        camera.cancelFlight();
        camera.setView({ destination: { lon, lat, height: 150_000 } });
      },
      { lat, lon },
    );
  }
  for (const country of ['ZA', 'BR', 'JP']) {
    const [, , lat, lon] = fixtures.find((f) => f[0] === country);
    await navigate(lat, lon);
    await page.waitForFunction(
      (country) => {
        const m =
          window.__godsEyeView.dataManager.layers.get('air-quality').module;
        const rows = m.getAnalystRecords();
        return rows.length === 1 && rows[0].country === country;
      },
      { timeout: 15000 },
      country,
    );
  }
  assert.ok(requestedViews.every((view) => view?.length === 6));
  console.log(
    'PASS: camera navigation automatically loads South Africa, Brazil and Japan with geographic queries',
  );
  status = 429;
  await page.evaluate(() =>
    window.__godsEyeView.dataManager.layers.get('air-quality').module.update(),
  );
  // A pass already under way may answer first; the card names the provider.
  await page.waitForFunction(
    () =>
      window.__godsEyeView.dataManager.layers
        .get('air-quality')
        .module.getRowControls()
        .summary.lines.some((line) =>
          /OpenAQ: request budget reached/.test(line.text),
        ),
    { timeout: 15000 },
  );
  const cooldown = await layerState();
  assert.equal(cooldown.stats.count, 1);
  assert.match(
    cooldown.providers.find((entry) => entry.id === 'openaq').error,
    /request budget reached/,
  );
  const beforeRetry = requestedViews.length;
  status = 200;
  await page.waitForFunction(
    () => {
      const m =
        window.__godsEyeView.dataManager.layers.get('air-quality').module;
      return !m
        .getRowControls()
        .summary.lines.some((line) => line.id === 'provider-openaq');
    },
    { timeout: 10000 },
  );
  assert.equal(requestedViews.length > beforeRetry, true);
  assert.equal((await layerState()).stats.count, 1);
  console.log(
    'PASS: rate limits retain cached markers, say so on the card and recover automatically',
  );
  // A completed search over open ocean finds nothing: the answer for the new
  // view has come back (a request was made and the provider is no longer
  // loading), and only then is the empty list asserted.
  const beforeOcean = requestedViews.length;
  await navigate(0, -140);
  await page.waitForFunction(
    () =>
      window.__godsEyeView.dataManager.layers
        .get('air-quality')
        .module.getAnalystRecords().length === 0,
    { timeout: 15000 },
  );
  await page.waitForFunction(
    () =>
      window.__godsEyeView.dataManager.layers
        .get('air-quality')
        .module.getProviderStates()
        .find((entry) => entry.id === 'openaq').status === 'ok',
    { timeout: 15000 },
  );
  const ocean = await layerState();
  assert.ok(requestedViews.length > beforeOcean, 'the ocean view was asked');
  assert.equal(ocean.records.length, 0);
  assert.equal(ocean.controls.list.items.length, 0);
  console.log('PASS: a completed ocean search lists no stations');
  // Back over a fixture station, a missing key must leave its cached reading
  // as it is, not replace it with anything else.
  const [, tokyo, tokyoLat, tokyoLon] = fixtures.find((f) => f[0] === 'JP');
  await navigate(tokyoLat, tokyoLon);
  await page.waitForFunction(
    () =>
      window.__godsEyeView.dataManager.layers
        .get('air-quality')
        .module.getAnalystRecords().length === 1,
    { timeout: 15000 },
  );
  const cachedBefore = (await layerState()).records;
  assert.equal(cachedBefore[0].name, tokyo);
  status = 428;
  await page.evaluate(() =>
    window.__godsEyeView.dataManager.layers.get('air-quality').module.update(),
  );
  await page.waitForFunction(
    () =>
      /Provider Settings/.test(
        window.__godsEyeView.dataManager.layers
          .get('air-quality')
          .module.getProviderStates()
          .find((entry) => entry.id === 'openaq').error ?? '',
      ),
    { timeout: 15000 },
  );
  const noKey = await layerState();
  assert.match(
    noKey.providers.find((entry) => entry.id === 'openaq').error ?? '',
    /Provider Settings/,
  );
  assert.deepEqual(
    noKey.records.map((r) => [r.id, r.value]),
    cachedBefore.map((r) => [r.id, r.value]),
    'the cached reading stays; nothing fabricated replaces it',
  );
  console.log(
    'PASS: missing key gives Provider Settings guidance, and the cached reading is kept',
  );
  assert.deepEqual(errors, []);
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
