#!/usr/bin/env node
/** Run against npm run dev: real Cesium imagery with remote HTTPS providers blocked. */
import assert from 'node:assert/strict';
import puppeteer from 'puppeteer';
const origin = process.env.QA_BASE_URL || 'http://localhost:4173';
const browser = await puppeteer.launch({
  headless: !process.argv.includes('--headful'),
  args: [
    '--no-sandbox',
    ...(process.platform === 'darwin'
      ? ['--use-angle=metal', '--enable-gpu']
      : ['--use-gl=angle', '--use-angle=swiftshader']),
  ],
});
try {
  const page = await browser.newPage();
  await page.setViewport({ width: 1024, height: 800 });
  const external = [];
  const localTiles = [];
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('response', (response) => {
    if (
      response.url().includes('NaturalEarthII/') &&
      response.url().endsWith('.jpg')
    )
      localTiles.push({ url: response.url(), status: response.status() });
  });
  await page.setRequestInterception(true);
  const servePage = (request) =>
    request.url() === `${origin}/qa-offline-basemap`
      ? request.respond({
          contentType: 'text/html',
          body: '<link rel="stylesheet" href="/cesium/Widgets/widgets.css"><div id="globe" style="width:900px;height:650px"></div><div id="maps"></div><span id="status"></span>',
        })
      : request.continue();
  page.on('request', servePage);
  await page.goto(`${origin}/qa-offline-basemap`);
  // Release interception before Cesium starts module workers. CDP blocks the
  // remote providers without holding worker initialization requests open.
  await page.setRequestInterception(false);
  page.off('request', servePage);
  page.on('request', (request) => {
    if (request.url().startsWith('https:')) external.push(request.url());
  });
  const cdp = await page.createCDPSession();
  await cdp.send('Network.enable');
  await cdp.send('Network.setBlockedURLs', { urls: ['https://*'] });
  await page.evaluate(async () => {
    const moduleText = await (await fetch('/src/maps/imagery.js')).text();
    const cesiumUrl = moduleText.match(/from "([^"]*cesium\.js[^"]*)"/)[1];
    const Cesium = await import(cesiumUrl);
    const { MapSourceController } = await import('/src/maps/controller.js');
    const { createDefaultMapSources } =
      await import('/src/maps/defaultSources.js');
    const { createMapSourceControls } =
      await import('/src/ui/mapSourceControls.js');
    // Same local Cesium asset path configured by the application build plugin.
    Cesium.buildModuleUrl.setBaseUrl('/cesium/');
    window.viewer = new Cesium.Viewer('globe', {
      baseLayer: false,
      baseLayerPicker: false,
      geocoder: false,
      timeline: false,
      animation: false,
      skyBox: false,
      navigationHelpButton: false,
      terrainProvider: new Cesium.EllipsoidTerrainProvider(),
    });
    window.maps = new MapSourceController(viewer, {
      registry: createDefaultMapSources(),
    });
    window.controls = createMapSourceControls({
      container: document.getElementById('maps'),
      statusElement: document.getElementById('status'),
      controller: maps,
      subscribe: (listener) => maps.subscribe(listener),
    });
    viewer.camera.setView({
      destination: Cesium.Cartesian3.fromDegrees(18.4, -33.9, 19000000),
    });
    window.renderErrors = [];
    viewer.scene.renderError.addEventListener((scene, error) =>
      renderErrors.push(String(error)),
    );
    await maps.setStack('esri-imagery');
  });
  await page.waitForFunction(() => maps.getActiveId() === 'offline', {
    timeout: 30000,
  });
  await page.waitForFunction(() => viewer.scene.globe.tilesLoaded, {
    timeout: 30000,
  });
  assert.deepEqual(await page.evaluate(() => renderErrors), []);
  assert.ok(external.some((url) => url.includes('arcgisonline')));
  assert.ok(external.some((url) => url.includes('openstreetmap')));
  assert.ok(localTiles.length > 0);
  assert.ok(localTiles.every((tile) => tile.status === 200));
  assert.equal(await page.$eval('#status', (el) => el.textContent), 'OFFLINE');
  assert.match(
    await page.$eval('#status', (el) => el.title),
    /Live data requires internet/,
  );
  const before = external.length;
  await page.evaluate(async () => {
    await maps.setStack('offline');
    viewer.camera.setView({ destination: { x: 19000000, y: 0, z: 0 } });
  });
  await page.waitForFunction(() => viewer.scene.globe.tilesLoaded);
  assert.equal(
    external.length,
    before,
    'manual offline selection makes no remote map requests',
  );
  assert.equal(
    await page.evaluate(() => viewer.terrainProvider.constructor.name),
    'EllipsoidTerrainProvider',
  );
  if (process.env.QA_OFFLINE_SCREENSHOT)
    await page.screenshot({ path: process.env.QA_OFFLINE_SCREENSHOT });
  await page.evaluate(() => {
    controls.destroy();
    maps.destroy();
    viewer.destroy();
  });
  assert.deepEqual(errors, []);
  console.log(
    'PASS: real Esri/OSM failure chain, local tiles, flat terrain, offline status, manual selection, teardown',
  );
} finally {
  await browser.close();
}
