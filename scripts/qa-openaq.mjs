/** Real-app OpenAQ gate. Runs with explicit synthetic data; never writes keys.
 * QA_BASE_URL=http://127.0.0.1:4174 node scripts/qa-openaq.mjs
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
  let incomplete = false;
  const requestedViews = [];
  await cdp.send('Fetch.enable', {
    patterns: [{ urlPattern: '*/api/air-quality/openaq*' }],
  });
  cdp.on('Fetch.requestPaused', async ({ requestId, request }) => {
    const raw = new URL(request.url).searchParams.get('view');
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
        responseCode: status,
        responseHeaders: [{ name: 'Content-Type', value: 'application/json' }],
        body: Buffer.from(
          JSON.stringify(
            status === 200
              ? {
                  ...payload,
                  readings: selected,
                  stations: selected,
                  partial: incomplete,
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
  assert.ok(state.controls.list.items.every((r) => r.badge === 'Fair'));
  console.log(
    'PASS: existing Provider Settings has a masked, empty OpenAQ field; worldwide fixture renders through shared layer',
  );
  assert.equal(state.controls.legend.length, 7);
  assert.ok(
    state.controls.summary.overview.some((line) =>
      line.text.includes('Most people:'),
    ),
  );
  assert.ok(await page.$('.data-row-list-badge.gev-status-badge'));
  console.log(
    'PASS: hourly comparison shows category, guidance, numeric legend and shared status badges',
  );
  scoped = true;
  async function navigate(lat, lon) {
    await page.evaluate(
      ({ lat, lon }) => {
        const { viewer } = window.__godsEyeView;
        viewer.camera.cancelFlight();
        viewer.camera.setView({
          destination: viewer.scene.globe.ellipsoid.cartographicToCartesian({
            longitude: (lon * Math.PI) / 180,
            latitude: (lat * Math.PI) / 180,
            height: 150_000,
          }),
          orientation: { heading: 0, pitch: -Math.PI / 2, roll: 0 },
        });
        viewer.scene.requestRender();
      },
      { lat, lon },
    );
  }
  for (const country of ['ZA', 'BR', 'JP']) {
    const [, , lat, lon] = fixtures.find((f) => f[0] === country);
    await navigate(lat, lon);
    await page.waitForFunction(() =>
      /Loading/.test(
        window.__godsEyeView.dataManager.layers
          .get('air-quality')
          .module.getRowControls().summary.status,
      ),
    );
    await page.waitForFunction(
      (country) => {
        const m =
          window.__godsEyeView.dataManager.layers.get('air-quality').module;
        const rows = m.getAnalystRecords();
        return (
          !/Loading/.test(m.getRowControls().summary.status) &&
          rows.length === 1 &&
          rows[0].country === country
        );
      },
      { timeout: 15000 },
      country,
    );
  }
  assert.ok(requestedViews.every((view) => view?.length === 6));
  console.log(
    'PASS: camera navigation automatically loads South Africa, Brazil and Japan with geographic queries and visible loading state',
  );
  status = 429;
  await page.evaluate(() =>
    window.__godsEyeView.dataManager.layers.get('air-quality').module.update(),
  );
  const cooldown = await page.evaluate(() => {
    const m = window.__godsEyeView.dataManager.layers.get('air-quality').module;
    return { count: m.getStats().count, summary: m.getRowControls().summary };
  });
  assert.equal(cooldown.count, 1);
  assert.match(cooldown.summary.status, /request budget reached/);
  assert.ok(cooldown.summary.lines.some((line) => line.id === 'retry'));
  const beforeRetry = requestedViews.length;
  status = 200;
  await page.waitForFunction(
    () => {
      const m =
        window.__godsEyeView.dataManager.layers.get('air-quality').module;
      return (
        /PM2.5/.test(m.getRowControls().summary.status) &&
        m.getStats().count === 1
      );
    },
    { timeout: 10000 },
  );
  assert.equal(requestedViews.length, beforeRetry + 1);
  console.log(
    'PASS: rate limits retain cached markers, show the retry time and recover automatically',
  );
  incomplete = true;
  await navigate(0, -140);
  await page.waitForFunction(() =>
    /Partial/.test(
      window.__godsEyeView.dataManager.layers
        .get('air-quality')
        .module.getRowControls().summary.status,
    ),
  );
  incomplete = false;
  await page.evaluate(() =>
    window.__godsEyeView.dataManager.layers.get('air-quality').module.update(),
  );
  assert.match(
    await page.evaluate(
      () =>
        window.__godsEyeView.dataManager.layers
          .get('air-quality')
          .module.getRowControls().summary.status,
    ),
    /No current readings/,
  );
  console.log(
    'PASS: empty incomplete discovery differs from a completed empty ocean search',
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
  assert.deepEqual(
    await page.evaluate(
      () =>
        window.__godsEyeView.dataManager.layers
          .get('air-quality')
          .module.getRowControls().summary.overview,
    ),
    [],
  );
  console.log(
    'PASS: missing key gives Provider Settings guidance, without replacing data with fake readings',
  );
  assert.deepEqual(errors, []);
} finally {
  await browser.close();
}
