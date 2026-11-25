/**
 * Deterministic real-app South African provider gate.
 * Run with a dev server: node scripts/qa-south-africa-air-quality.mjs
 * Supplies synthetic South African observations, answers OpenAQ and India as
 * keyless and the field as unconfigured, independently of the server settings.
 * Optional --live audits the national public source directly (no credentials
 * printed); that audit ignores SAAQIS_ENABLED.
 */
import assert from 'node:assert/strict';
import puppeteer from 'puppeteer';
import { createSaAcquisition } from '../server/providers/southAfricaAirQuality.js';
import {
  normalizeSaStations,
  normalizeSaMeasurements,
} from '../src/layers/airQuality/southAfrica.js';
import { OBSERVATION_MAX_AGE_MS } from '../src/layers/airQuality/model.js';

if (process.argv.includes('--live')) {
  const snapshot = await createSaAcquisition().getSnapshot();
  const checkedAt = Date.now();
  const fresh = new Set(
    snapshot.readings
      .filter(
        (row) =>
          Number.isFinite(row.observedMs) &&
          row.observedMs <= checkedAt + 300_000 &&
          checkedAt - row.observedMs <= OBSERVATION_MAX_AGE_MS,
      )
      .map((row) => row.stationId),
  );
  console.log(
    JSON.stringify(
      {
        checkedAt: new Date(checkedAt).toISOString(),
        catalog: snapshot.stations.length,
        reportingAnyPollutant: fresh.size,
        provinces: [...new Set(snapshot.stations.map((row) => row.province))]
          .sort()
          .map((province) => ({
            province,
            catalog: snapshot.stations.filter(
              (row) => row.province === province,
            ).length,
            reporting: snapshot.stations.filter(
              (row) => row.province === province && fresh.has(row.stationId),
            ).length,
          })),
        westernCape: snapshot.stations
          .filter((row) => row.province === 'Western Cape')
          .map((row) => ({
            stationId: row.stationId,
            name: row.name,
            reporting: fresh.has(row.stationId),
          })),
      },
      null,
      2,
    ),
  );
  process.exit(0);
}

const now = Date.now();
const stations = normalizeSaStations([
  {
    name: 'Western Cape',
    stations: [
      {
        stationId: 1,
        name: 'Cape Town fixture',
        active: true,
        owner: 'Fixture network',
        location: { latitude: -33.92, longitude: 18.42 },
      },
      {
        stationId: 2,
        name: 'Silent station fixture',
        active: true,
        location: { latitude: -33.95, longitude: 18.45 },
      },
    ],
  },
]);
const snapshot = {
  schemaVersion: 1,
  stations,
  fetchedAt: now,
  stale: false,
  readings: normalizeSaMeasurements(
    [
      {
        stationId: 1,
        regionData: {
          channels: [
            {
              name: 'PM2.5',
              value: 12,
              units: 'µg/m³',
              active: true,
              valid: true,
              datetime: new Date(now).toISOString(),
            },
            {
              name: 'NO2',
              value: 20,
              units: 'µg/m³',
              active: true,
              valid: true,
              datetime: new Date(now).toISOString(),
            },
          ],
        },
      },
    ],
    stations,
  ),
};
// A provider-reported index on the PM2.5 row, as the portal publishes one: the
// layer must neither use nor show it.
snapshot.readings.find((row) => row.parameter === 'PM2.5').rating = {
  score: 4,
  label: 'Moderate',
  method: 'SAAQIS index',
};
let fail = false;
const browser = await puppeteer.launch({
  headless: !process.argv.includes('--headful'),
  args: [
    '--no-sandbox',
    ...(process.platform === 'darwin'
      ? ['--use-angle=metal', '--enable-gpu']
      : [
          '--use-gl=angle',
          '--use-angle=swiftshader',
          '--enable-unsafe-swiftshader',
        ]),
  ],
});
try {
  const page = await browser.newPage();
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.setViewport({ width: 1440, height: 1000 });
  const cdp = await page.createCDPSession();
  await cdp.send('Fetch.enable', {
    patterns: ['south-africa*', 'openaq*', 'india*', 'field/*'].map(
      (route) => ({ urlPattern: '*/api/air-quality/' + route }),
    ),
  });
  cdp.on('Fetch.requestPaused', async ({ requestId, request }) => {
    const route = new URL(request.url).pathname.split('/air-quality/')[1];
    const [status, body] =
      route === 'south-africa'
        ? [fail ? 503 : 200, fail ? { error: 'unavailable' } : snapshot]
        : route === 'field/manifest'
          ? [200, { unavailable: true, code: 'not_configured' }]
          : route.startsWith('field/')
            ? [404, {}]
            : [428, { error: 'no_key' }];
    await cdp
      .send('Fetch.fulfillRequest', {
        requestId,
        responseCode: status,
        responseHeaders: [{ name: 'Content-Type', value: 'application/json' }],
        body: Buffer.from(JSON.stringify(body)).toString('base64'),
      })
      .catch(() => {});
  });
  await gotoSafely(
    page,
    `${process.env.QA_BASE_URL || 'http://127.0.0.1:4173'}/?welcome=0`,
    {
      waitUntil: 'domcontentloaded',
      timeout: 90_000,
    },
  );
  await page.waitForFunction(
    () => {
      const cover = document.getElementById('loading-screen');
      return (
        window.__godsEyeView?.dataManager &&
        cover?.classList.contains('hidden') &&
        Number(getComputedStyle(cover).opacity) === 0
      );
    },
    { timeout: 90_000 },
  );
  await page.evaluate(async () => {
    const { dataManager: dm, viewer } = window.__godsEyeView;
    dm.setLayerParams('air-quality', { view: 'PM2.5' });
    await dm.setEnabled('air-quality', true);
    await dm.layers.get('air-quality').module.update();
    const { cameraOf } = await import('/src/render/rendererOf.js');
    const camera = cameraOf(viewer);
    camera.cancelFlight();
    camera.setView({
      destination: { lon: 18.42, lat: -33.92, height: 80_000 },
    });
  });
  const state = () =>
    page.evaluate(() => {
      const layer =
        window.__godsEyeView.dataManager.layers.get('air-quality').module;
      return {
        params: layer.getParams(),
        stats: layer.getStats(),
        controls: layer.getRowControls(),
        records: layer.getAnalystRecords(),
      };
    });
  let result = await state();
  assert.equal(result.stats.count, 1);
  assert.equal(result.records[0].units, 'µg/m³');
  assert.equal(result.controls.list.items.length, 1);
  // One scale for every network: the six EEA PM2.5 bands. 12 µg/m³ is
  // "Fair", the record's band; SAAQIS's own index is neither read nor shown.
  assert.equal(result.controls.legend.length, 6);
  assert.equal(result.records[0].assessment.label, 'Fair');
  assert.equal(result.records[0].band, 'Fair');
  assert.doesNotMatch(
    result.controls.list.items[0].title,
    /SAAQIS index|4\/10/,
  );
  // The keyed providers say they need a key.
  assert.ok(
    result.controls.summary.lines.some((row) =>
      row.text.includes('OpenAQ: add a key'),
    ),
  );
  console.log(
    'PASS: national source → layer → map-view card with the EEA band, no network index',
  );

  // Open the Weather air-quality card, then exercise the real pollutant button.
  await page.evaluate(() => {
    const button = document.querySelector(
      '[data-card-id="air-quality"] button',
    );
    button?.click();
  });
  await page.waitForFunction(
    () => {
      const cover = document.getElementById('loading-screen');
      return (
        !cover ||
        cover.classList.contains('hidden') ||
        getComputedStyle(cover).display === 'none'
      );
    },
    { timeout: 90_000 },
  );
  const no2 = await page.$('[data-tile-id="NO2"]');
  assert.ok(no2, 'real Weather card exposes the pollutant controls');
  // Camera restoration and Vue publication may settle after the layer data.
  await page.waitForFunction(
    () =>
      document
        .querySelector('[data-card-id="air-quality"] [data-tile-id="PM2.5"]')
        ?.getAttribute('aria-pressed') === 'true',
  );
  await no2.click();

  await page.waitForFunction(
    () =>
      window.__godsEyeView.dataManager.layers
        .get('air-quality')
        .module.getAnalystRecords()[0]?.parameter === 'NO2',
  );
  result = await state();
  assert.equal(result.records[0].value, 20);
  assert.equal(result.records[0].units, 'µg/m³');
  assert.equal(result.params.view, 'NO2');
  console.log('PASS: real NO2 control selects concentration');
  if (process.env.QA_SA_SCREENSHOT)
    await page.screenshot({ path: process.env.QA_SA_SCREENSHOT });

  await page.evaluate(async () => {
    const { viewer } = window.__godsEyeView;
    const { cameraOf } = await import('/src/render/rendererOf.js');
    cameraOf(viewer).setView({
      destination: { lon: 24, lat: -30, height: 20_000 },
    });
  });
  result = await state();
  assert.equal(result.controls.list.items.length, 0);
  // The card says so with its count, not with distant readings.
  assert.equal(result.controls.summary.status, '0 stations');
  console.log(
    'PASS: municipality without reporting stations shows a gap, not distant readings',
  );

  // The client keeps a provider's answer for its refresh interval, so a
  // failing source is met on a fresh load.
  fail = true;
  await page.reload({ waitUntil: 'domcontentloaded', timeout: 90_000 });
  await page.waitForFunction(() => window.__godsEyeView?.dataManager, {
    timeout: 90_000,
  });
  await page.evaluate(async () => {
    const dm = window.__godsEyeView.dataManager;
    dm.setLayerParams('air-quality', { view: 'PM2.5' });
    await dm.setEnabled('air-quality', true);
    await dm.layers.get('air-quality').module.update();
  });
  const failed = await page.evaluate(() =>
    window.__godsEyeView.dataManager.layers
      .get('air-quality')
      .module.getProviderStates()
      .find((entry) => entry.id === 'saaqis'),
  );
  assert.equal(failed.status, 'failed');
  assert.ok(failed.error);
  console.log('PASS: source failure is visible');
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
