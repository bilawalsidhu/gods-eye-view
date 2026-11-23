/**
 * Deterministic real-app South African provider gate.
 * Run with a dev server: node scripts/qa-south-africa-air-quality.mjs
 * Optional --live audits the national public source (no credentials printed).
 */
import assert from 'node:assert/strict';
import puppeteer from 'puppeteer';
import { createSaAcquisition } from '../server/providers/southAfricaAirQuality.js';
import {
  normalizeSaStations,
  normalizeSaMeasurements,
  selectSaReadings,
  SA_POLLUTANTS,
} from '../src/layers/airQuality/southAfrica.js';

if (process.argv.includes('--live')) {
  const snapshot = await createSaAcquisition().getSnapshot();
  const fresh = new Set(
    SA_POLLUTANTS.flatMap((parameter) =>
      selectSaReadings(snapshot, parameter).map((row) => row.stationId),
    ),
  );
  console.log(
    JSON.stringify(
      {
        checkedAt: new Date().toISOString(),
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
for (const row of snapshot.readings) {
  if (row.parameter === 'PM2.5') {
    row.rating = {
      score: 4,
      label: 'Moderate',
      method: 'SAAQIS index',
      observedMs: row.observedMs,
    };
    row.color = '#F7FF00';
  }
}
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
    patterns: [{ urlPattern: '*/api/air-quality/south-africa*' }],
  });
  cdp.on('Fetch.requestPaused', async ({ requestId }) => {
    await cdp.send('Fetch.fulfillRequest', {
      requestId,
      responseCode: fail ? 503 : 200,
      responseHeaders: [{ name: 'Content-Type', value: 'application/json' }],
      body: Buffer.from(
        JSON.stringify(fail ? { error: 'unavailable' } : snapshot),
      ).toString('base64'),
    });
  });
  await page.goto(
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
  assert.equal(result.records[0].band, null);
  assert.equal(result.controls.list.items.length, 1);
  // One scale for every network: the EEA PM2.5 bands and "Not rated" (7).
  // 12 µg/m³ is "Fair"; SAAQIS's own index (4/10) stays in the details.
  assert.equal(result.controls.legend.length, 7);
  assert.equal(result.controls.list.items[0].badge, 'Fair');
  assert.match(result.controls.list.items[0].text, /SAAQIS index 4\/10/);
  assert.ok(
    result.controls.summary.lines.some((row) =>
      row.text.includes('2 catalog stations'),
    ),
  );
  console.log(
    'PASS: national source → layer → map-view card; silent catalog station stays distinct',
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
  const no2 = await page.$('[data-chip-id="NO2"]');
  assert.ok(no2, 'real Weather card exposes the pollutant controls');
  // Camera restoration and Vue publication may settle after the layer data.
  await page.waitForFunction(
    () =>
      document.querySelector(
        '[data-card-id="air-quality"] .data-row-list-badge',
      )?.textContent === 'Fair',
  );
  assert.equal(
    await page.$eval('.data-row-list-badge', (el) => el.textContent),
    'Fair',
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
  console.log(
    'PASS: real NO2 control selects concentration, with an unavailable index badge',
  );
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
  assert.ok(
    result.controls.summary.lines.some((row) =>
      row.text.includes('No current observations'),
    ),
  );
  console.log(
    'PASS: municipality without reporting stations shows a gap, not distant readings',
  );

  fail = true;
  await page.evaluate(async () => {
    await window.__godsEyeView.dataManager.layers
      .get('air-quality')
      .module.update();
  });
  assert.ok((await state()).stats.error);
  console.log('PASS: source failure is visible');
  assert.deepEqual(errors, []);
} finally {
  await browser.close();
}
