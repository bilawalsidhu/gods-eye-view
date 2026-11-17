#!/usr/bin/env node
/** Ports UI gate: running dev server, deterministic WPI-shaped fixtures.
 * node scripts/qa-ports.mjs [--live] [--url http://localhost:4173]
 * --live uses the real DOE endpoint (no port-data interception).
 */
import assert from 'node:assert/strict';
import { readFileSync, mkdirSync } from 'node:fs';
import puppeteer from 'puppeteer';
const arg = process.argv.indexOf('--url');
const base = arg >= 0 ? process.argv[arg + 1] : 'http://127.0.0.1:4173';
const live = process.argv.includes('--live');
const out = new URL('../.gev-logs/ports-review/', import.meta.url);
mkdirSync(out, { recursive: true });
const tile = readFileSync(
  new URL(
    '../node_modules/cesium/Build/Cesium/Assets/Textures/NaturalEarthII/0/0/0.jpg',
    import.meta.url,
  ),
);
const point = (id, name, country, lon, lat, container, lng = 'Unknown') => ({
  type: 'Feature',
  geometry: { type: 'Point', coordinates: [lon, lat] },
  properties: {
    objectid: id,
    wpinumber: id,
    main_port_name: name,
    wpi_cc: country,
    fac_container: container,
    fac_lngterm: lng,
    fac_oilterm: 'Unknown',
  },
});
const fixtures = [
  point(48276, 'Mina Jabal Ali', 'United Arab Emirates', 55.061, 24.996, 'Yes'),
  point(16080, 'Los Angeles', 'United States', -118.25, 33.75, 'Yes'),
  point(50000, 'Keppel - (East Singapore)', 'Singapore', 103.85, 1.283, 'Yes'),
  point(
    900001,
    'QA unknown facilities',
    'United Arab Emirates',
    55.3,
    25.25,
    'Unknown',
  ),
];
fixtures.forEach((feature, i) => {
  feature.properties.objectid = i + 1;
});
const browser = await puppeteer.launch({
  headless: process.env.GEV_HEADLESS_SHELL ? 'shell' : true,
  pipe: true,
  args: [
    '--no-sandbox',
    '--disable-dev-shm-usage',
    '--use-gl=angle',
    '--use-angle=swiftshader',
  ],
  defaultViewport: { width: 1440, height: 1000 },
});
const page = await browser.newPage();
await page.evaluateOnNewDocument(() => {
  localStorage.setItem('gev:first-run-mission:v1', 'suppressed');
  localStorage.setItem('gevStoriesPopSeen', '1');
});
const errors = [];
page.on('pageerror', (e) => {
  errors.push(e.message);
  console.error('Page error', e.message);
});
await page.setRequestInterception(true);
page.on('request', (req) => {
  const url = new URL(req.url());
  if (!live && url.hostname === 'arcgis.netl.doe.gov') {
    const value = url.pathname.endsWith('/query')
      ? { type: 'FeatureCollection', features: fixtures }
      : {
          name: 'World Port Index',
          objectIdField: 'objectid',
          advancedQueryCapabilities: {
            supportsPagination: true,
            supportsOrderBy: true,
          },
          editingInfo: { lastEditDate: Date.UTC(2026, 3, 20) },
        };
    return void req.respond({
      status: 200,
      contentType: 'application/json',
      headers: { 'Access-Control-Allow-Origin': '*' },
      body: JSON.stringify(value),
    });
  }
  if (
    !live &&
    ((url.hostname === 'services.arcgisonline.com' &&
      url.pathname.includes('/tile/')) ||
      url.hostname === 'tile.openstreetmap.org')
  )
    return void req.respond({
      status: 200,
      contentType: 'image/jpeg',
      headers: { 'Access-Control-Allow-Origin': '*' },
      body: tile,
    });
  void req.continue();
});
let recorder;
try {
  await page.goto(base, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => window.__godsEyeView?.dataManager, {
    timeout: 120000,
  });
  const screenshot = (name) =>
    page.screenshot({
      path: new URL(name.replace(/\.png$/, '.jpg'), out).pathname,
      type: 'jpeg',
      quality: 90,
    });
  // Recording shows enable, navigation, record selection, filtering, and disable.
  await page.waitForFunction(
    () =>
      document.querySelector('#loading-screen')?.classList.contains('hidden'),
    { timeout: 120000 },
  );
  console.log('App ready');

  await page.keyboard.press('Escape');
  const notNow = await page.$('#hPop .tbtn:not(.solid)');
  if (notNow && (await notNow.isVisible())) await notNow.click();
  if (process.argv.includes('--record'))
    recorder = await page.screencast({
      path: new URL(live ? 'live.webm' : 'fixtures.webm', out).pathname,
      fps: 3,
      scale: 0.75,
      speed: 1,
    });
  console.log('Enabling ports');
  await page.evaluate(() =>
    window.__godsEyeView.dataManager.setEnabled('world-ports', true),
  );
  await page.waitForFunction(
    () => {
      const s = window.__godsEyeView.dataManager.layers
        .get('world-ports')
        ?.module.getStats();
      if (s?.error) throw new Error(s.error);
      return s?.count > 0 && !s.loading;
    },
    { timeout: 120000 },
  );
  console.log('Port acquisition complete');
  assert.equal(
    await page.$eval('#ports-panel', (panel) => {
      const box = panel.getBoundingClientRect();
      return panel.contains(
        document.elementFromPoint(box.right - 50, box.top + 150),
      );
    }),
    true,
    'Ports panel must remain above the context dock',
  );
  if (live) {
    const count = await page.evaluate(
      () =>
        window.__godsEyeView.dataManager.layers
          .get('world-ports')
          .module.getStats().count,
    );
    assert.equal(
      count,
      3820,
      `expected reviewed mirror snapshot, received ${count}`,
    );
    const stats = await page.evaluate(() =>
      window.__godsEyeView.dataManager.layers
        .get('world-ports')
        .module.getStats(),
    );
    assert.equal(stats.partial, true);
    assert.equal(stats.rejected, 2);
    assert.equal(stats.duplicates, 2);
    console.log(`Live DOE WPI: ${count} ports acquired in browser`);
  }
  await page.evaluate(async () => {
    const { findCamera } = await import('/src/render/rendererOf.js');
    findCamera(window.__godsEyeView.viewer).flyTo(
      { lon: 60, lat: 20, height: 18000000 },
      {
        durationS: 0,
        orientation: { heading: 0, pitch: -Math.PI / 2, roll: 0 },
      },
    );
  });
  await new Promise((resolve) => setTimeout(resolve, 1000));
  await screenshot(live ? 'live-globe.png' : 'fixture-globe.png');
  await page.select('#ports-panel label:nth-of-type(3) select', '48276');
  await page.waitForFunction(() =>
    document.querySelector('#ports-panel')?.textContent.includes('19,400,000'),
  );
  await new Promise((resolve) => setTimeout(resolve, 1500));
  await screenshot(live ? 'live-profile.png' : 'fixture-profile.png');
  assert.ok(await page.$('a[href="https://msi.nga.mil/Publications/WPI"]'));
  const profile = await page.$eval('#ports-panel', (el) => el.textContent);
  assert.match(profile, /15,500,000 TEU/);
  assert.match(profile, /2024/);
  assert.match(profile, /Not provided by source/);
  await page.$eval('#ports-panel', (el) => {
    el.scrollTop = 560;
  });
  await screenshot(live ? 'live-facts.png' : 'fixture-facts.png');
  await page.$eval('#ports-panel', (el) => {
    el.scrollTop = 0;
  });
  console.log('Filtering ports');
  await page.select(
    '#ports-panel label:nth-of-type(1) select',
    'United Arab Emirates',
  );
  console.log(
    'After country filter',
    await page.evaluate(
      () =>
        window.__godsEyeView.dataManager.layers
          .get('world-ports')
          .module.getStats().count,
    ),
  );
  if (!live) {
    await page.waitForFunction(
      () =>
        window.__godsEyeView.dataManager.layers
          .get('world-ports')
          .module.getStats().count === 2,
    );
  }
  await page.select('#ports-panel label:nth-of-type(2) select', 'container');
  await page.waitForFunction(() => {
    const rows = window.__godsEyeView.dataManager.layers
      .get('world-ports')
      .module.getAnalystRecords();
    return (
      rows.length > 0 &&
      rows.every(
        (r) =>
          r.country === 'United Arab Emirates' &&
          r.facilities.container === true,
      )
    );
  });
  if (!live)
    assert.equal(
      await page.evaluate(
        () =>
          window.__godsEyeView.dataManager.layers
            .get('world-ports')
            .module.getStats().count,
      ),
      1,
    );
  // The mirror reports Jebel Ali capabilities as unknown. Never infer its
  // container flag from DP World's commercial supplement.
  await screenshot(live ? 'live-filtered.png' : 'fixture-filtered.png');
  await page.select('#ports-panel label:nth-of-type(2) select', '');
  console.log('Checking rendered marker selection');
  await page.select('#ports-panel label:nth-of-type(3) select', '48276');
  await new Promise((resolve) => setTimeout(resolve, 1500));
  // Click the actual rendered marker using the renderer's projection.
  const point = await page.evaluate(async () => {
    const { findQuery } = await import('/src/render/rendererOf.js');
    const { fromDegrees } = await import('/src/geo/ellipsoid.js');
    const { viewer, dataManager } = window.__godsEyeView;
    const layer = dataManager.layers.get('world-ports').module;
    const r = layer.getAnalystRecords().find((r) => r.id === '48276');
    layer.select('');
    return findQuery(viewer).project(fromDegrees(r.lon, r.lat));
  });
  assert.ok(point && Number.isFinite(point.x));
  await page.mouse.click(point.x, point.y);
  await page.waitForFunction(() =>
    document.querySelector('#ports-panel')?.textContent.includes('19,400,000'),
  );
  console.log('Checking phone layout and disable');
  await page.setViewport({ width: 390, height: 844 });
  await screenshot(live ? 'live-phone.png' : 'fixture-phone.png');
  assert.equal(
    await page.evaluate(
      () => document.documentElement.scrollWidth > innerWidth,
    ),
    false,
  );
  await page.evaluate(() =>
    window.__godsEyeView.dataManager.setEnabled('world-ports', false),
  );
  await page.waitForFunction(() => !document.querySelector('#ports-panel'));
  assert.equal(
    await page.evaluate(
      () =>
        window.__godsEyeView.dataManager.layers
          .get('world-ports')
          .module.getAnalystRecords().length,
    ),
    0,
  );
} finally {
  if (recorder) await recorder.stop();
  await browser.close();
}
assert.deepEqual(errors, []);
console.log('Ports browser gate passed');
