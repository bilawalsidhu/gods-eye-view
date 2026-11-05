#!/usr/bin/env node
/**
 * Render a documented CWA-shaped cyclone fixture through the existing layer.
 *
 * Usage: npm run qa:cyclone-fixture -- [--url http://localhost:4173]
 * The screenshot is saved under qa-shots/cyclone-fixture/.
 */
import assert from 'node:assert/strict';
import { mkdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import puppeteer from 'puppeteer';
import { validateCycloneSnapshot } from '../src/layers/cyclones/source.js';

const argv = process.argv.slice(2);
const option = (name, fallback) => {
  const index = argv.indexOf(name);
  return index >= 0 && argv[index + 1] ? argv[index + 1] : fallback;
};
const baseUrl = option('--url', 'http://localhost:4173');
const outputDirectory = path.resolve(
  option('--out', 'qa-shots/cyclone-fixture'),
);
const outputPath = path.join(outputDirectory, 'taiwan-forecast.png');
mkdirSync(outputDirectory, { recursive: true });
const offlineImageryTile = readFileSync(
  new URL(
    '../node_modules/cesium/Build/Cesium/Assets/Textures/NaturalEarthII/0/0/0.jpg',
    import.meta.url,
  ),
);

function snapshot() {
  const now = Date.now();
  const issuedAt = new Date(now - 15 * 60_000).toISOString();
  const current = { longitude: 121.5, latitude: 20 };
  const forecastPoints = [
    {
      position: { longitude: 123, latitude: 22 },
      tauHours: 12,
      validAt: new Date(now + 12 * 60 * 60_000).toISOString(),
      windKt: null,
      gustKt: null,
      windMs: 32,
      gustMs: null,
      pressureHpa: 985,
      probabilityRadiusKm: 150,
    },
    {
      position: { longitude: 125, latitude: 24 },
      tauHours: 24,
      validAt: new Date(now + 24 * 60 * 60_000).toISOString(),
      windKt: null,
      gustKt: null,
      windMs: 30,
      gustMs: null,
      pressureHpa: 990,
      probabilityRadiusKm: null,
    },
  ];
  const sourceUrl = 'https://opendata.cwa.gov.tw/dataset/forecast/W-C0034-005';
  const cycleId = `cwa-2026-td1:${issuedAt}`;
  return {
    schemaVersion: 1,
    source: 'NOAA NHC / CPHC + Taiwan CWA',
    attribution:
      'NOAA/NWS National Hurricane Center / Central Pacific Hurricane Center; Taiwan Central Weather Administration (CWA)',
    coverage:
      'NOAA NHC/CPHC: North Atlantic and eastern/central North Pacific; Taiwan CWA: western North Pacific and South China Sea when configured. North Indian, Southern Hemisphere and Australian-region forecasts are not covered.',
    fetchedAt: now,
    stale: false,
    partial: false,
    unavailable: false,
    providers: { nhc: 'available', cwa: 'available' },
    reason: null,
    storms: [
      {
        id: 'cwa-2026-td1',
        provider: 'cwa',
        source: 'Taiwan Central Weather Administration (CWA)',
        sourceUrl,
        name: 'QA Typhoon',
        classification: 'Tropical cyclone',
        basin: 'WP',
        position: current,
        positionAt: issuedAt,
        advisoryNumber: null,
        advisoryId: `CWA fixture ${issuedAt}`,
        cycleId,
        issuedAt,
        windKt: null,
        windMs: 32,
        windAveragingMinutes: null,
        pressureHpa: 985,
        movement: {
          directionDegrees: null,
          speedKt: null,
          speedKmh: 17.5,
          direction: 'NNE',
        },
        advisoryUrl: sourceUrl,
        outlookUrl: null,
        geometryStatus: 'current',
        geometryAdvisoryNumber: null,
        geometryCycleId: cycleId,
        coneStatus: 'not_provided',
        forecastPoints,
        track: {
          type: 'LineString',
          coordinates: [
            [current.longitude, current.latitude],
            ...forecastPoints.map((point) => [
              point.position.longitude,
              point.position.latitude,
            ]),
          ],
        },
        cone: null,
      },
    ],
  };
}

const fixture = snapshot();
validateCycloneSnapshot(fixture);

const browser = await puppeteer.launch({
  headless: 'new',
  protocolTimeout: 120_000,
  ...(process.env.PUPPETEER_EXECUTABLE_PATH
    ? { executablePath: process.env.PUPPETEER_EXECUTABLE_PATH }
    : {}),
  args: [
    '--no-sandbox',
    '--disable-setuid-sandbox',
    '--use-gl=angle',
    '--use-angle=swiftshader',
    '--disable-dev-shm-usage',
    '--disable-backgrounding-occluded-windows',
    '--disable-renderer-backgrounding',
  ],
});

try {
  const page = await browser.newPage();
  await page.setViewport({ width: 1440, height: 950, deviceScaleFactor: 1 });
  let fixtureRequests = 0;
  let offlineImageryRequests = 0;
  const pageErrors = [];
  page.on('pageerror', (error) => pageErrors.push(error.message));
  page.on('console', (message) => {
    if (message.type() === 'error')
      console.error(`[browser] ${message.text().slice(0, 240)}`);
  });
  await page.setRequestInterception(true);
  page.on('request', (request) => {
    const url = new URL(request.url());
    if (url.pathname === '/api/cyclones') {
      fixtureRequests++;
      request.respond({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(fixture),
      });
      return;
    }
    const knownImageryTile =
      request.method() === 'GET' &&
      ((url.origin === 'https://services.arcgisonline.com' &&
        /^\/ArcGIS\/rest\/services\/World_Imagery\/MapServer\/tile\/\d+\/\d+\/\d+$/.test(
          url.pathname,
        )) ||
        (url.origin === 'https://tile.openstreetmap.org' &&
          /^\/\d+\/\d+\/\d+\.png$/.test(url.pathname)));
    if (knownImageryTile) {
      offlineImageryRequests++;
      request.respond({
        status: 200,
        contentType: 'image/jpeg',
        headers: { 'Access-Control-Allow-Origin': '*' },
        body: offlineImageryTile,
      });
    } else request.continue();
  });
  await page.evaluateOnNewDocument(() => {
    try {
      localStorage.setItem('godsEyeView.v6.panelCollapsed.data-panel', '0');
    } catch {
      /* storage may be unavailable */
    }
  });
  const targetUrl = new URL(baseUrl);
  targetUrl.searchParams.set('welcome', '0');
  await page.goto(targetUrl.href, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(
    () =>
      Boolean(
        window.__godsEyeView?.viewer && window.__godsEyeView?.dataManager,
      ),
    { timeout: 90_000 },
  );
  await page.evaluate(async () => {
    await window.__godsEyeView.dataManager.setEnabled(
      'weather-cyclones',
      true,
      {
        origin: 'user',
      },
    );
  });
  await page
    .waitForFunction(
      () => {
        const layer =
          window.__godsEyeView.dataManager.layers.get(
            'weather-cyclones',
          )?.module;
        return layer?.getDiagnostics?.().forecastPoints === 2;
      },
      { timeout: 30_000 },
    )
    .catch(async (error) => {
      const state = await page.evaluate(() => {
        const entry =
          window.__godsEyeView.dataManager.layers.get('weather-cyclones');
        return {
          enabled: entry?.enabled,
          stats: entry?.module?.getStats?.(),
          diagnostics: entry?.module?.getDiagnostics?.(),
        };
      });
      console.error(
        `Cyclone fixture requests: ${fixtureRequests}; layer state: ${JSON.stringify(state)}`,
      );
      throw error;
    });

  const ui = await page.evaluate(async () => {
    const gev = window.__godsEyeView;
    const layer = gev.dataManager.layers.get('weather-cyclones').module;
    layer.setParams({ stormId: 'cwa-2026-td1' });
    document.querySelector('#data-panel')?.classList.remove('collapsed');
    const ellipsoid = gev.viewer.scene.globe.ellipsoid;
    const destination = ellipsoid.cartographicToCartesian({
      longitude: (123.5 * Math.PI) / 180,
      latitude: (20.5 * Math.PI) / 180,
      height: 2_800_000,
    });
    await new Promise((resolve) =>
      gev.viewer.camera.flyTo({ destination, duration: 1, complete: resolve }),
    );
    const controls = layer.getRowControls();
    return {
      diagnostics: layer.getDiagnostics(),
      summary: controls.summary,
      source: controls.summary.detail,
      stormRows: controls.list.items.length,
    };
  });

  assert.equal(fixtureRequests > 0, true, 'the cyclone fixture was requested');
  assert.equal(ui.diagnostics.storms, 1);
  assert.equal(ui.diagnostics.tracks, 1);
  assert.equal(ui.diagnostics.forecastPoints, 2);
  assert.equal(ui.diagnostics.cones, 0);
  assert.equal(ui.diagnostics.probabilityRadii, 1);
  assert.equal(ui.stormRows, 1);
  assert.match(ui.source, /Taiwan Central Weather Administration/);
  assert.match(ui.summary.detail, /QA Typhoon/);
  assert.deepEqual(pageErrors, [], 'the app reported no browser exceptions');

  await page.screenshot({ path: outputPath, fullPage: true });
  console.log(
    `PASS: Taiwan fixture rendered ${ui.diagnostics.forecastPoints} forecast points, one source-supplied probability radius, and no fabricated cone.`,
  );
  console.log(`Bundled imagery tiles served: ${offlineImageryRequests}`);
  console.log(`Screenshot: ${outputPath}`);
} finally {
  await browser.close();
}
