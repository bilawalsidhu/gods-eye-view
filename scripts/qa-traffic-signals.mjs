// Deterministic browser integration: real Cesium rendering, fixture-only feeds.
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { createServer } from 'vite';
import puppeteer from 'puppeteer';

let configured = false;
let feedFails = false;
let snapshotCount = 0;
let mapRequests = 0;
let delayMap = false;
let reportsOnly = false;
let staleReports = false;
const qaPlugin = { name: 'qa-traffic-signals', configureServer(server) {
server.middlewares.use('/__qa_traffic_signals', async (req, res) => {
  const html = await server.transformIndexHtml('/__qa_traffic_signals', `<!doctype html>
    <html><head><link rel="stylesheet" href="/style.css"></head><body><div id="map" style="position:absolute;inset:0"></div>
    <script type="module">
      import * as Cesium from 'cesium';
      import { createTrafficSignalsLayer } from '/src/data/trafficSignals.js';
      Cesium.Ion.defaultAccessToken = '';
      const viewer = new Cesium.Viewer('map', { baseLayer: false, baseLayerPicker: false, geocoder: false,
        timeline: false, animation: false, infoBox: false, homeButton: false, sceneModePicker: false,
        navigationHelpButton: false, fullscreenButton: false, skyBox: false });
      viewer.camera.setView({ destination: Cesium.Cartesian3.fromDegrees(-123, 49, 1200) });
      const layer = createTrafficSignalsLayer();
      layer.init(viewer); layer.enable();
      window.qa = { viewer, layer, Cesium };
    </script></body></html>`);
  res.setHeader('Content-Type', 'text/html');
  res.end(html);
});
} };
const server = await createServer({ plugins: [qaPlugin], server: { host: '127.0.0.1', port: 0, open: false } });
let browser;
try {
  await server.listen();
  const candidates = [process.env.CHROME_PATH, puppeteer.executablePath(),
    'C:/Program Files/Google/Chrome/Application/chrome.exe',
    'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe'].filter(Boolean);
  browser = await puppeteer.launch({ executablePath: candidates.find(existsSync), headless: true,
    args: ['--no-sandbox', '--disable-dev-shm-usage', '--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
  const page = await browser.newPage();
  await page.setViewport({ width: 1280, height: 800 });
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.setRequestInterception(true);
  page.on('request', async (request) => {
    const url = new URL(request.url());
    const json = (body, status = 200) => request.respond({ status, contentType: 'application/json', body: JSON.stringify(body) });
    if (url.pathname === '/api/overpass') {
      mapRequests++;
      if (delayMap) await new Promise((resolve) => setTimeout(resolve, 1000));
      return json({ elements: [{ type: 'node', id: 1, lat: 49, lon: -123,
        tags: { highway: 'traffic_signals', name: 'Fixture intersection' } }] }).catch(() => {});
    }
    if (url.pathname === '/api/traffic-signals/status') return json({ configured });
    if (url.pathname === '/api/traffic-signals/snapshot') {
      snapshotCount++;
      if (feedFails) return json({ error: 'offline' }, 503);
      const now = Date.now();
      const record = {
        id: 'osm:1', lat: 49, lon: -123, name: 'Fixture intersection', movement: 'North approach, straight',
        source: 'QA fixture (not live)', state: 'red', observedAtEpochMs: now - 500,
        validUntilEpochMs: now + 1500, changeAtEpochMs: now + 3000, resolutionMs: 1, uncertaintyMs: 20,
      };
      if (reportsOnly) {
        record.observationOnly = true;
        record.observedAtEpochMs = now - (staleReports ? 60000 : 500);
        for (const key of ['validUntilEpochMs', 'changeAtEpochMs', 'resolutionMs', 'uncertaintyMs']) delete record[key];
      }
      return json({ serverTimeEpochMs: now, clockUncertaintyMs: 5,
        coverage: reportsOnly ? 'Public reports; no countdown' : '', signals: [record] });
    }
    if (!['127.0.0.1', 'localhost'].includes(url.hostname) && url.protocol.startsWith('http')) return request.abort();
    return request.continue();
  });
  await page.goto(`http://127.0.0.1:${server.httpServer.address().port}/__qa_traffic_signals`, { waitUntil: 'networkidle0' });
  await page.waitForFunction(() => window.qa?.layer.getStats().count === 1);
  assert.match(await page.$eval('.traffic-signals-panel', (el) => el.textContent), /Locations only/);
  // Select the rendered point through the actual screen-space click handler.
  const point = await page.evaluate(() => {
    const { viewer, Cesium } = qa;
    const p = Cesium.SceneTransforms.worldToWindowCoordinates(viewer.scene, Cesium.Cartesian3.fromDegrees(-123, 49, 3));
    return { x: p.x, y: p.y };
  });
  await page.mouse.click(point.x, point.y);
  await page.waitForFunction(() => document.querySelector('.traffic-signals-panel').textContent.includes('UNKNOWN'));
  assert.match(await page.$eval('.traffic-signals-panel', (el) => el.textContent), /Timing unavailable/);
  configured = true;
  await page.evaluate(() => { qa.layer.disable(); qa.layer.enable(); });
  await page.waitForFunction(() => document.querySelector('.traffic-signals-panel').textContent.includes('1 with fresh state'));
  await page.mouse.click(point.x, point.y);
  await page.waitForFunction(() => /RED.*\d\.\d{3} s/.test(document.querySelector('.traffic-signals-panel').textContent));
  const before = await page.$eval('.traffic-signals-panel p:last-child', (el) => el.textContent);
  await page.waitForFunction((text) => document.querySelector('.traffic-signals-panel p:last-child').textContent !== text, {}, before);
  reportsOnly = true;
  await page.waitForFunction(() => document.querySelector('.traffic-signals-panel').textContent.includes('LAST REPORTED RED'));
  assert.match(await page.$eval('.traffic-signals-panel', (el) => el.textContent), /countdown unavailable/);
  assert.doesNotMatch(await page.$eval('.traffic-signals-panel p:last-child', (el) => el.textContent), /estimate/);
  staleReports = true;
  await page.waitForFunction(() => document.querySelector('.traffic-signals-panel').textContent.includes('current state unknown'));
  feedFails = true;
  await page.waitForFunction(() => document.querySelector('.traffic-signals-panel').textContent.includes('Timing unavailable'));
  await page.evaluate(() => qa.layer.disable());
  assert.equal(await page.$eval('.traffic-signals-panel', (el) => el.hidden), true);
  assert.equal(await page.evaluate(() => qa.layer.getStats().count), 0);
  const stoppedAt = snapshotCount;
  await new Promise((resolve) => setTimeout(resolve, 1300));
  assert.equal(snapshotCount, stoppedAt, 'disable stops polling');
  await page.evaluate(() => {
    qa.viewer.camera.setView({ destination: qa.Cesium.Cartesian3.fromDegrees(-123, 49, 100000) });
    qa.layer.enable();
  });
  assert.match(await page.$eval('.traffic-signals-panel', (el) => el.textContent), /Zoom below 8 km/);
  delayMap = true;
  const priorMaps = mapRequests;
  await page.evaluate(() => qa.viewer.camera.setView({ destination: qa.Cesium.Cartesian3.fromDegrees(-123, 49, 1200) }));
  const deadline = Date.now() + 5000;
  while (mapRequests === priorMaps && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 50));
  assert.ok(mapRequests > priorMaps, 'camera descent starts a fresh map request');
  await page.evaluate(() => qa.layer.disable());
  await new Promise((resolve) => setTimeout(resolve, 1200));
  assert.equal(await page.evaluate(() => qa.layer.getStats().count), 0, 'late response cannot resurrect a disabled layer');
  await page.evaluate(() => qa.layer.destroy());
  assert.equal(await page.$('.traffic-signals-panel'), null);
  assert.deepEqual(errors, []);
  console.log(JSON.stringify({ pass: true, mapRequests, snapshotCount,
    checks: ['mapped locations', 'real marker click', 'unknown state', 'millisecond estimate', 'countdown advances', 'reported state without invented countdown', 'stale reports stay unknown', 'feed failure', 'disable stops polling', 'altitude gate', 'late response ignored', 'destroy'] }));
} finally {
  await browser?.close();
  await server.close();
}
