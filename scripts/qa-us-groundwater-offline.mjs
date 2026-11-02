/** Local component gate: real Cesium, native overlays, fixture only; no live app providers. */
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';
import cesium from 'vite-plugin-cesium';
import puppeteer from 'puppeteer';
import {
  createServer as createDenyProxy,
  request as httpRequest,
} from 'node:http';

const root = fileURLToPath(new URL('..', import.meta.url));
const out = path.resolve(process.argv[2] ?? '.temp-gev/offline-browser');
await mkdir(out, { recursive: true });
const checks = [],
  errors = [],
  consoleErrors = [],
  visualGaps = [],
  network = {
    local: 0,
    blockedExternal: 0,
    bundledImageryResponses: 0,
    failedLocalPaths: [],
    proxyDenied: 0,
    proxySelfTestsPassed: 0,
  };
const html = `<!doctype html><html><head><meta charset="utf-8"><title>Offline groundwater component QA</title><style>html,body,#map{width:100%;height:100%;margin:0;overflow:hidden}#toolbar{position:absolute;top:10px;left:10px;z-index:1000;background:#071b25;color:white;padding:8px;font:14px sans-serif}#stats{font:12px monospace;margin:6px 0}</style></head><body><div id="map"></div><div id="toolbar">OFFLINE COMPONENT QA — six historical USGS sites<div id="stats"></div><button id="toggle">Toggle wells</button></div><script type="module" src="/scripts/fixtures/usGroundwaterOffline.js"></script></body></html>`;
const server = await createServer({
  configFile: false,
  envFile: false,
  root,
  logLevel: 'error',
  plugins: [
    cesium(),
    {
      name: 'offline-fixture-page',
      configureServer(s) {
        s.middlewares.use(async (req, res, next) => {
          res.setHeader(
            'Content-Security-Policy',
            "default-src 'self' data: blob:; connect-src 'self' ws://127.0.0.1:*; worker-src 'self' blob:; img-src 'self' data: blob:; style-src 'self' 'unsafe-inline'; script-src 'self' 'unsafe-inline' 'unsafe-eval'",
          );
          if (req.url?.startsWith('/api/')) {
            res.statusCode = 404;
            res.end();
            return;
          }
          if (req.url?.split('?')[0] !== '/__qa-groundwater.html')
            return next();
          res.setHeader('Content-Type', 'text/html');
          res.end(await s.transformIndexHtml(req.url, html));
        });
      },
    },
  ],
  server: {
    host: '127.0.0.1',
    port: 0,
    strictPort: true,
    fs: { strict: true, allow: [root] },
  },
});
// Upstream qa-street-level.mjs documents that page-wide Fetch interception
// stalls Cesium workers. A fail-closed loopback proxy blocks nonlocal traffic
// without pausing local worker module requests; no request is ever forwarded.
const denyProxy = createDenyProxy((_req, res) => {
  network.proxyDenied++;
  res.writeHead(403);
  res.end();
});
denyProxy.on('connect', (_req, socket) => {
  network.proxyDenied++;
  socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n');
});
let browser;
try {
  await new Promise((resolve, reject) => {
    denyProxy.once('error', reject);
    denyProxy.listen(0, '127.0.0.1', resolve);
  });
  const proxyPort = denyProxy.address().port;
  for (const method of ['GET', 'CONNECT'])
    await new Promise((resolve, reject) => {
      const req = httpRequest({
        host: '127.0.0.1',
        port: proxyPort,
        method,
        path:
          method === 'GET'
            ? 'http://offline-deny.invalid/'
            : 'offline-deny.invalid:443',
      });
      req.on('error', reject);
      req.on(method === 'CONNECT' ? 'connect' : 'response', (res, socket) => {
        try {
          assert.equal(res.statusCode, 403);
          network.proxySelfTestsPassed++;
          res.resume?.();
          socket?.destroy();
          resolve();
        } catch (error) {
          reject(error);
        }
      });
      req.end();
    });
  await server.listen();
  const origin = `http://127.0.0.1:${server.httpServer.address().port}`;
  browser = await puppeteer.launch({
    headless: true,
    args: [
      '--use-gl=angle',
      '--use-angle=swiftshader',
      '--disable-background-networking',
      `--proxy-server=http://127.0.0.1:${proxyPort}`,
      '--proxy-bypass-list=127.0.0.1;localhost',
    ],
  });
  const page = await browser.newPage();
  await page.setViewport({ width: 1440, height: 900, deviceScaleFactor: 1 });
  page.on('request', (request) => {
    const u = new URL(request.url());
    if (u.origin === origin || ['data:', 'blob:'].includes(u.protocol)) {
      network.local++;
      return;
    }
    network.blockedExternal++;
    // CSP/proxy refuse these; this observer never pauses Cesium workers.
  });
  page.on('pageerror', (error) =>
    errors.push(error.message.replaceAll(root, '<checkout>')),
  );
  page.on('console', (message) => {
    if (message.type() === 'error')
      consoleErrors.push(message.text().replaceAll(root, '<checkout>'));
  });
  page.on('response', (response) => {
    if (response.ok() && /NaturalEarthII.*\.jpg/.test(response.url()))
      network.bundledImageryResponses++;
    if (response.status() >= 400)
      network.failedLocalPaths.push({
        path: new URL(response.url()).pathname,
        status: response.status(),
      });
  });
  await page.evaluateOnNewDocument(() => {
    window.__workerErrors = [];
    const Original = window.Worker;
    window.Worker = class extends Original {
      constructor(...args) {
        super(...args);
        this.addEventListener('error', (event) =>
          window.__workerErrors.push({
            message: event.message,
            filename: event.filename,
          }),
        );
      }
    };
  });
  await page.goto(origin + '/__qa-groundwater.html', {
    waitUntil: 'domcontentloaded',
  });
  await page.waitForFunction(
    () => window.qa?.layer.getStats().representedLocationCount === 6,
    { timeout: 45000 },
  );
  try {
    await page.waitForFunction(
      () =>
        qa.viewer.scene.globe.tilesLoaded &&
        qa.viewer.scene.globe._surface._tilesToRender.length > 0,
      { timeout: 5000 },
    );
  } catch {
    visualGaps.push(
      'Bundled globe terrain/imagery tiles did not become ready; screenshots are not basemap or full-app visual acceptance.',
    );
  }
  await page.waitForFunction(() => qa.settled());
  assert.equal(await page.evaluate(() => qa.layer.getStats().screenGroups), 0);
  assert.equal(
    await page.evaluate(
      () => qa.viewer.dataSources.get(0).entities.values.length,
    ),
    0,
  );
  checks.push(
    'national count evidence allocates no visible aggregate markers or individual detail',
  );
  await page.screenshot({ path: path.join(out, 'national-hidden.png') });

  await page.evaluate(async () => {
    qa.viewer.camera.cancelFlight();
    const r = qa.records[0];
    qa.camera(r.longitude, r.latitude, 15000);
    await qa.install('sample');
  });
  await page.waitForFunction(() => {
    const r = qa.records[0],
      p = qa.point(r.longitude, r.latitude);
    return qa.settled() && p && qa.pick(p.x, p.y);
  });
  const point = await page.evaluate(() =>
    qa.point(qa.records[0].longitude, qa.records[0].latitude),
  );
  await page.mouse.click(point.x, point.y);
  await page.waitForFunction(() => qa.selected?.id === qa.records[0].id);
  const selection = await page.evaluate(() => ({
    actual: qa.selected,
    expected: qa.records[0],
    contextLayer: qa.context?.layerId,
  }));
  assert.equal(selection.actual.sourceUrl, selection.expected.sourceUrl);
  assert.equal(
    selection.actual.readings.length,
    selection.expected.readings.length,
  );
  assert.equal(selection.contextLayer, 'us-groundwater');
  await page.waitForFunction(
    () => qa.overlayDiagnostics().paintedBySource.tracked > 0,
  );
  checks.push(
    'selection retains source ID, official URL, supplied readings and visibly painted native card',
  );
  await page.screenshot({ path: path.join(out, 'selected-well.png') });
  await page.mouse.click(900, 750);
  await page.waitForFunction(() => qa.selected === null);
  checks.push('empty-map click dismisses selection');
  const dot = await page.evaluate(() => {
    const r = qa.records[0];
    return qa.point(r.longitude, r.latitude);
  });
  await page.mouse.click(dot.x, dot.y);
  await page.waitForFunction(() => qa.selected?.id === qa.records[0].id);
  checks.push(
    'direct dot click after dismissal selects the same exact source-backed well',
  );
  await page.waitForFunction(
    () => qa.overlayDiagnostics().paintedBySource.tracked > 0,
  );
  await page.screenshot({ path: path.join(out, 'flag-selected-well.png') });
  await page.click('#toggle');
  assert.deepEqual(
    await page.evaluate(() => ({
      count: qa.layer.getStats().count,
      represented: qa.layer.getStats().representedLocationCount,
      sources: qa.viewer.dataSources.length,
    })),
    { count: 6, represented: 0, sources: 0 },
  );
  await page.click('#toggle');
  await page.waitForFunction(
    () => qa.layer.getStats().representedLocationCount === 6,
  );
  assert.equal(await page.evaluate(() => qa.viewer.dataSources.length), 1);
  checks.push(
    'OFF/ON preserves catalog six, releases graphics, then owns one data source',
  );

  await page.evaluate(async () => {
    await qa.install('sample');
  });
  await page.waitForFunction(() => !qa.layer.getStats().loading);
  await page.evaluate(() => {
    qa.setMode('delayed');
    const r = qa.records[1];
    qa.camera(r.longitude, r.latitude, 18000);
    qa.viewer.camera.moveEnd.raiseEvent();
  });
  await page.waitForFunction(() => qa.requests.some((r) => r.resolve));
  const old = await page.evaluate(() =>
    qa.requests.findIndex((r) => r.resolve),
  );
  await page.evaluate(() => {
    const r = qa.records[2];
    qa.camera(r.longitude, r.latitude, 22000);
    qa.viewer.camera.moveEnd.raiseEvent();
  });
  await page.waitForFunction(
    (index) => qa.requests.length > index + 1 && qa.requests.at(-1).resolve,
    {},
    old,
  );
  await page.evaluate((index) => {
    qa.finish(index, { ...qa.detail, records: [] });
  }, old);
  assert.equal(await page.evaluate(() => qa.layer.getRecords().length), 6);
  await page.evaluate(() => {
    qa.setMode('sample');
    for (let i = 0; i < qa.requests.length; i++)
      if (qa.requests[i].resolve && !qa.requests[i].options.signal.aborted)
        qa.finish(i);
  });
  await page.waitForFunction(() => !qa.layer.getStats().loading);
  assert.equal(await page.evaluate(() => qa.layer.getRecords().length), 6);
  assert.equal(
    await page.evaluate(
      (index) => qa.requests[index].options.signal.aborted,
      old,
    ),
    true,
  );
  checks.push(
    'rapid actual camera changes abort obsolete requests; late empty result cannot replace last-good six IDs',
  );
  assert.deepEqual(errors, []);
  assert.deepEqual(await page.evaluate(() => qa.renderErrors), []);
  if (!network.bundledImageryResponses && !visualGaps.length)
    visualGaps.push('No bundled basemap image response observed.');
  assert.equal(
    network.blockedExternal,
    0,
    'fixture must not even attempt an external request',
  );
  const status = visualGaps.length ? 'partial' : 'passed';
  console.log(
    JSON.stringify({
      status,
      checks,
      network,
      visualGaps,
      viewport: { width: 1440, height: 900 },
      errors,
    }),
  );
  await writeFile(
    path.join(out, 'result.json'),
    JSON.stringify(
      {
        status,
        checks,
        network,
        visualGaps,
        viewport: { width: 1440, height: 900 },
        errors,
      },
      null,
      2,
    ) + '\n',
  );
  if (visualGaps.length) process.exitCode = 1;
} catch (error) {
  let scene;
  try {
    const page = (await browser.pages()).at(-1);
    scene = await page.evaluate(
      () =>
        window.qa && {
          workerErrors: window.__workerErrors,
          renderErrors: qa.renderErrors,
          globe: qa.viewer.scene.globe.show,
          tilesLoaded: qa.viewer.scene.globe.tilesLoaded,
          tiles: qa.viewer.scene.globe._surface._tilesToRender.length,
          imagery: qa.viewer.imageryLayers.length,
          loop: qa.viewer.useDefaultRenderLoop,
          stats: qa.layer.getStats(),
          diagnostics: qa.diagnostics(),
        },
    );
  } catch {}
  const result = {
    status: 'failed',
    checks,
    network,
    visualGaps,
    errors,
    consoleErrors,
    scene,
    failure: error.message.replaceAll(root, '<checkout>'),
  };
  await writeFile(
    path.join(out, 'result.json'),
    JSON.stringify(result, null, 2) + '\n',
  );
  console.log(JSON.stringify(result));
  process.exitCode = 1;
} finally {
  await browser?.close();
  await server.close();
  await new Promise((resolve) => denyProxy.close(resolve));
}
