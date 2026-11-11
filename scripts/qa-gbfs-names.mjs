#!/usr/bin/env node
/**
 * Keyless station-name regression against the real globe and bike-share tool.
 * Run with a dev or preview server: node scripts/qa-gbfs-names.mjs --url http://localhost:4173
 * GBFS documents are synthetic; no operator feed or provider key is required.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import puppeteer from 'puppeteer';

const urlIndex = process.argv.indexOf('--url');
const appUrl =
  urlIndex < 0 ? 'http://localhost:4173' : process.argv[urlIndex + 1];
const shots = path.resolve('qa-shots/gbfs-names');
fs.mkdirSync(shots, { recursive: true });
const information = {
  version: '3.0',
  data: {
    stations: [
      {
        station_id: 'english',
        name: [
          { language: 'hu', text: 'Magyar tér' },
          { language: 'en', text: 'QA English Square' },
        ],
      },
      {
        station_id: 'short',
        name: [null, { language: 'en', text: ' ' }],
        short_name: [{ language: 'en-GB', text: 'QA Short Name' }],
      },
      { station_id: 'unnamed', name: [null, {}, { language: 42, text: [] }] },
      { station_id: 'legacy', name: ' QA Legacy Station ' },
      {
        station_id: 'fallback',
        name: [null, { language: 'hu', text: 'QA Magyar Station' }],
      },
    ].map((station, index) => ({
      ...station,
      lat: 30.2681 + index * 0.001,
      lon: -97.7469 + index * 0.001,
      capacity: 13,
    })),
  },
};
const status = {
  data: {
    stations: information.data.stations.map(({ station_id }) => ({
      station_id,
      num_bikes_available: 4,
      num_docks_available: 9,
      is_renting: true,
      is_returning: true,
    })),
  },
};
const browser = await puppeteer.launch({
  headless: 'new',
  ...(process.env.PUPPETEER_EXECUTABLE_PATH
    ? { executablePath: process.env.PUPPETEER_EXECUTABLE_PATH }
    : {}),
  args:
    process.platform === 'darwin'
      ? ['--use-angle=metal']
      : ['--use-gl=angle', '--use-angle=swiftshader'],
});
let checks = 0;
const check = (name, actual, expected) => {
  assert.deepEqual(actual, expected, name);
  checks++;
  console.log(`[PASS] ${name}`);
};
async function open(mode = 'normal') {
  const page = await browser.newPage();
  await page.bringToFront();
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.setViewport({ width: 1440, height: 900 });
  await page.evaluateOnNewDocument(
    ({ information, status, mode }) => {
      localStorage.clear();
      localStorage.setItem('gev:first-run-mission:v1', 'suppressed');
      window.__qaPainted = [];
      const paint = CanvasRenderingContext2D.prototype.fillText;
      CanvasRenderingContext2D.prototype.fillText = function (text, ...args) {
        if (
          String(text).startsWith('QA ') ||
          String(text) === 'Station unnamed'
        ) {
          window.__qaPainted.push(String(text));
          if (window.__qaPainted.length > 100) window.__qaPainted.shift();
        }
        return paint.call(this, text, ...args);
      };
      const original = window.fetch.bind(window);
      window.fetch = async (input, init) => {
        const url = String(
          typeof input === 'string' || input instanceof URL ? input : input.url,
        );
        if (url.includes('/api/gbfs/')) {
          if (mode === 'failure') return new Response('{}', { status: 503 });
          const payload =
            mode === 'empty'
              ? { data: { stations: [] } }
              : decodeURIComponent(url).includes('station_information')
                ? information
                : status;
          return new Response(JSON.stringify(payload), {
            headers: { 'Content-Type': 'application/json' },
          });
        }
        if (url.includes('/api/flights')) return new Response('{"states":[]}');
        if (url.includes('/api/military')) return new Response('{"ac":[]}');
        if (url.includes('/api/vessels'))
          return new Response('{"connected":false,"vessels":[]}');
        return original(input, init);
      };
    },
    { information, status, mode },
  );
  await page.goto(appUrl, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(
    () =>
      window.__godsEyeView?.dataManager && window.__godsEyeView?.voiceCommands,
    { timeout: 60000 },
  );
  await page.waitForFunction(
    () =>
      !document.getElementById('loading-screen') ||
      (document.getElementById('loading-screen').classList.contains('hidden') &&
        getComputedStyle(document.getElementById('loading-screen')).opacity ===
          '0'),
    { timeout: 60000 },
  );
  await page.evaluate(async () => {
    const { dataManager, viewer } = window.__godsEyeView;
    for (const [id, layer] of dataManager.layers) {
      if (layer.enabled)
        await dataManager.setEnabled(id, false, { origin: 'user' });
    }
    const Cartesian3 = viewer.camera.position.constructor;
    viewer.camera.cancelFlight();
    viewer.camera.setView({
      destination: Cartesian3.fromDegrees(-97.7449, 30.2701, 3000),
      orientation: { heading: 0, pitch: -Math.PI / 2, roll: 0 },
    });
    await dataManager.setEnabled('bikeshare', true, { origin: 'user' });
    window.__godsEyeView.requestRender('gbfs-name-qa');
  });
  return { page, errors };
}
try {
  const { page, errors } = await open();
  await page.waitForFunction(
    () =>
      window.__godsEyeView.dataManager.layers.get('bikeshare').module.getStats()
        .count === 5,
    { timeout: 15000 },
  );
  const records = await page.evaluate(() =>
    window.__godsEyeView.dataManager.layers
      .get('bikeshare')
      .module.getAnalystRecords(),
  );
  check(
    'the layer retains all five stations and normalized names',
    records.map((r) => r.name),
    [
      'QA English Square',
      'QA Short Name',
      null,
      'QA Legacy Station',
      'QA Magyar Station',
    ],
  );
  const tool = await page.evaluate(() =>
    window.__godsEyeView.voiceCommands.runner('get_bike_share', {
      area: { lat: 30.2701, lon: -97.7449, radius_km: 2 },
    }),
  );
  check('the real bike-share tool succeeds', tool.ok, true);
  check(
    'the tool preserves localized, short, unnamed, legacy and non-English names',
    tool.data.rows.map((r) => r.name).sort(),
    [
      null,
      'QA English Square',
      'QA Short Name',
      'QA Legacy Station',
      'QA Magyar Station',
    ].sort(),
  );
  check(
    'availability remains attached to every station',
    tool.data.rows.every(
      (r) => r.bikes_available === 4 && r.docks_available === 9,
    ),
    true,
  );
  const clickPoint = await page.evaluate(() => {
    window.__qaPainted = [];
    const { viewer } = window.__godsEyeView;
    const Cartesian3 = viewer.camera.position.constructor;
    const point = viewer.scene.cartesianToCanvasCoordinates(
      Cartesian3.fromDegrees(-97.7469, 30.2681),
    );
    const rect = viewer.scene.canvas.getBoundingClientRect();
    return { x: rect.left + point.x, y: rect.top + point.y };
  });
  await page.mouse.click(clickPoint.x, clickPoint.y);
  await page.waitForFunction(
    () => window.__qaPainted.includes('QA English Square'),
    { timeout: 10000 },
  );
  check(
    'a real pointer click selects the station with its localized name',
    await page.evaluate(() => window.__qaPainted.includes('QA English Square')),
    true,
  );
  await page.keyboard.press('Escape');
  for (const [id, title] of [
    ['english', 'QA English Square'],
    ['short', 'QA Short Name'],
    ['unnamed', 'Station unnamed'],
  ]) {
    await page.evaluate((id) => {
      window.__qaPainted = [];
      const app = window.__godsEyeView;
      app.dataManager.layers
        .get('bikeshare')
        .module._selectBikeshareStationForTest(`austin-capmetro:${id}`);
      app.requestRender('gbfs-name-selection-qa');
    }, id);
    await page.waitForFunction(
      (title) => window.__qaPainted.includes(title),
      { timeout: 10000 },
      title,
    );
    check(
      `the selected ${id} card paints the expected title`,
      await page.evaluate((title) => window.__qaPainted.includes(title), title),
      true,
    );
    await page.screenshot({ path: path.join(shots, `${id}.png`) });
    await page.keyboard.press('Escape');
    await page.waitForFunction(() =>
      window.__godsEyeView.dataManager.layers
        .get('bikeshare')
        .module.getDetectableObjects()
        .every((record) => !record.skipLabel),
    );
    check(
      `Escape clears the ${id} card`,
      await page.evaluate(
        () =>
          window.__godsEyeView.dataManager.layers
            .get('bikeshare')
            .module.getDetectableObjects()
            .filter((record) => record.skipLabel).length,
      ),
      0,
    );
  }
  await page.setViewport({ width: 390, height: 844 });
  await page.evaluate(() => {
    window.__qaPainted = [];
    const app = window.__godsEyeView;
    // Use the supported clean view to inspect the mobile card clear of panels.
    app.styleManager.toggleCleanView(true);
    const Cartesian3 = app.viewer.camera.position.constructor;
    app.viewer.camera.cancelFlight();
    app.viewer.camera.setView({
      destination: Cartesian3.fromDegrees(-97.7449, 30.2701, 3000),
      orientation: { heading: 0, pitch: -Math.PI / 2, roll: 0 },
    });
    app.dataManager.layers
      .get('bikeshare')
      .module._selectBikeshareStationForTest('austin-capmetro:english');
    app.requestRender('gbfs-name-mobile-qa');
  });
  await page.waitForFunction(
    () => window.__qaPainted.includes('QA English Square'),
    { timeout: 10000 },
  );
  check(
    'the mobile selected card paints its normalized name',
    await page.evaluate(() => window.__qaPainted.includes('QA English Square')),
    true,
  );
  await page.screenshot({ path: path.join(shots, 'mobile.png') });
  await page.evaluate(() =>
    window.__godsEyeView.dataManager.setEnabled('bikeshare', false, {
      origin: 'user',
    }),
  );
  check(
    'disabling clears selected cards and analyst records',
    await page.evaluate(() => ({
      count: window.__godsEyeView.dataManager.layers
        .get('bikeshare')
        .module.getAnalystRecords().length,
      selected: window.__godsEyeView.dataManager.layers
        .get('bikeshare')
        .module.getDetectableObjects()
        .filter((record) => record.skipLabel).length,
    })),
    { count: 0, selected: 0 },
  );
  check('normal fixtures produce no page exceptions', errors, []);
  await page.close();
  for (const mode of ['empty', 'failure']) {
    const { page, errors } = await open(mode);
    await page.waitForFunction(
      () =>
        !window.__godsEyeView.dataManager.layers
          .get('bikeshare')
          .module.getStats().loading,
    );
    check(
      `${mode} leaves no rendered stations`,
      await page.evaluate(
        () =>
          window.__godsEyeView.dataManager.layers
            .get('bikeshare')
            .module.getStats().count,
      ),
      0,
    );
    check(`${mode} produces no page exceptions`, errors, []);
    await page.close();
  }
  console.log(`GBFS names: ${checks}/${checks} checks passed; ${appUrl}`);
} finally {
  await browser.close();
}
