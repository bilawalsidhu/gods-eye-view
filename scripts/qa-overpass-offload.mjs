#!/usr/bin/env node
/**
 * qa-overpass-offload.mjs — keyless/keyed source replacement acceptance gate.
 *
 * Run: node scripts/qa-overpass-offload.mjs http://localhost:4173
 *      node scripts/qa-overpass-offload.mjs --url http://localhost:4173
 *
 * Flies to Austin at 2 km, enables Street Traffic, Mapped Installations and
 * ALPR, then checks rendered road dots, ALPR entities, and military markers
 * and polygon outlines near Camp Mabry, Fort Cavazos marker deduplication,
 * and at least 150 street-view dots within -3/+25 m of the surface. Records the traffic road-source label
 * and rejects every browser request to an Overpass host or public Nominatim.
 * Server-side zero egress is separately pinned in src/overpassOffload.test.mjs.
 * --tour measures Austin, London, Dubai, San Diego, Tokyo and São Paulo, then
 * revisits Austin, with all three layers enabled. CDP records requests, decoded
 * response-body bytes and transferred bytes (including headers), split by provider.
 * Uses real tile responses. A second isolated page overrides only TomTom key
 * availability to check OpenFreeMap roads on the Google mesh.
 * Screenshots and a JSON result go to qa-shots/ (gitignored). Exits nonzero on
 * a failed assertion. Works against keyed or keyless dev servers.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import puppeteer from 'puppeteer';

const args = process.argv.slice(2);
if (args.includes('--help') || args.includes('-h')) {
  console.log(
    'Usage: node scripts/qa-overpass-offload.mjs [--url] <dev-server-url> [--headful] [--software-gl] [--tour]\nChecks street-level mesh alignment for OpenFreeMap roads with/without TomTom flow, ALPR, Camp Mabry, Fort Cavazos, source labels and zero external Overpass/Nominatim requests. With --tour, measures a six-city session plus Austin revisit. Both modes record per-view provider requests/bytes and cache hits in qa-shots/overpass-offload-result.json (also a mode-specific result). Writes qa-shots/. Uses platform ANGLE by default; --software-gl opts into slower SwiftShader.',
  );
  process.exit(0);
}
const url = args.includes('--url')
  ? args[args.indexOf('--url') + 1]
  : args.find((arg) => !arg.startsWith('--'));
if (!url || !['http:', 'https:'].includes(new URL(url).protocol))
  throw new Error('Supply a running dev server URL; see --help');
const tour = args.includes('--tour');
const shots = path.resolve('qa-shots');
await fs.mkdir(shots, { recursive: true });
const browser = await puppeteer.launch({
  headless: !args.includes('--headful'),
  protocolTimeout: 300_000,
  ...(process.env.PUPPETEER_EXECUTABLE_PATH
    ? { executablePath: process.env.PUPPETEER_EXECUTABLE_PATH }
    : {}),
  args: [
    '--no-sandbox',
    '--disable-setuid-sandbox',
    '--use-gl=angle',
    ...(args.includes('--software-gl')
      ? ['--use-angle=swiftshader', '--enable-unsafe-swiftshader']
      : []),
    '--disable-dev-shm-usage',
    '--disable-background-timer-throttling',
    '--disable-renderer-backgrounding',
  ],
});
const result = {
  url,
  mode: tour ? 'tour' : 'acceptance',
  forbiddenRequests: [],
  errors: [],
  consoleErrors: [],
  failedRequests: [],
  traffic: null,
  alpr: null,
  military: null,
  screenshots: [],
  loadTimes: {},
};
// Assign each request to the view active when it started, even if it finishes later.
// Record both decoded body bytes and CDP transfer bytes; cached bodies are not egress.
const categories = [
  'ofmTileJSON',
  'ofmTiles',
  'alprTileJSON',
  'alprTiles',
  'tomtom',
];
const requests = [];
const views = [];
let currentView;
function beginView(name, camera = null) {
  currentView = { name, camera, startedAt: new Date().toISOString() };
  views.push(currentView);
  return currentView;
}
function categoryFor(target) {
  if (target.hostname === 'tiles.openfreemap.org')
    return target.pathname.endsWith('.pbf') ? 'ofmTiles' : 'ofmTileJSON';
  if (
    ['tiles.dontgetflocked.com', 'data.dontgetflocked.com'].includes(
      target.hostname,
    )
  )
    return target.pathname.endsWith('.json') ? 'alprTileJSON' : 'alprTiles';
  if (
    target.origin === new URL(url).origin &&
    target.pathname.startsWith('/api/tomtom/')
  )
    return 'tomtom';
  return null;
}
async function observeNetwork(targetPage) {
  const client = await targetPage.createCDPSession();
  const pending = new Map();
  await client.send('Network.enable');
  client.on('Network.requestWillBeSent', (event) => {
    const target = new URL(event.request.url);
    if (
      target.hostname.includes('overpass') ||
      target.hostname === 'nominatim.openstreetmap.org'
    )
      result.forbiddenRequests.push(target.origin + target.pathname);
    const category = categoryFor(target);
    if (!category) return;
    const entry = {
      view: currentView.name,
      category,
      target: target.origin + target.pathname,
      responseBytes: 0,
      transferBytes: 0,
      cached: false,
      finished: false,
    };
    requests.push(entry);
    pending.set(event.requestId, entry);
  });
  client.on('Network.requestServedFromCache', ({ requestId }) => {
    const entry = pending.get(requestId);
    if (entry) entry.cached = true;
  });
  client.on('Network.responseReceived', ({ requestId, response }) => {
    const entry = pending.get(requestId);
    if (!entry) return;
    entry.status = response.status;
    entry.cached ||= Boolean(
      response.fromDiskCache ||
      response.fromServiceWorker ||
      response.fromPrefetchCache,
    );
    entry.transferBytes = response.encodedDataLength || 0;
  });
  client.on(
    'Network.dataReceived',
    ({ requestId, dataLength, encodedDataLength }) => {
      const entry = pending.get(requestId);
      if (!entry) return;
      entry.responseBytes += dataLength;
      entry.transferBytes += encodedDataLength;
    },
  );
  client.on('Network.loadingFinished', ({ requestId, encodedDataLength }) => {
    const entry = pending.get(requestId);
    if (!entry) return;
    entry.transferBytes = entry.cached ? 0 : encodedDataLength;
    entry.finished = true;
    pending.delete(requestId);
  });
  client.on('Network.loadingFailed', ({ requestId, errorText }) => {
    const entry = pending.get(requestId);
    if (!entry) return;
    entry.failure = errorText;
    entry.finished = true;
    pending.delete(requestId);
  });
}
function footprintSummary() {
  function summarize(entries) {
    const totals = Object.fromEntries(
      categories.map((category) => [
        category,
        {
          requests: 0,
          responseBytes: 0,
          transferBytes: 0,
          cacheHits: 0,
          failures: 0,
          unfinished: 0,
        },
      ]),
    );
    for (const entry of entries) {
      const count = totals[entry.category];
      count.requests++;
      count.responseBytes += entry.responseBytes;
      count.transferBytes += entry.transferBytes;
      count.cacheHits += Number(entry.cached);
      count.failures += Number(Boolean(entry.failure) || entry.status >= 400);
      count.unfinished += Number(!entry.finished);
    }
    totals.total = Object.fromEntries(
      Object.keys(totals[categories[0]]).map((key) => [
        key,
        categories.reduce((sum, category) => sum + totals[category][key], 0),
      ]),
    );
    return totals;
  }
  const measured = views.map((view) => ({
    ...view,
    ...summarize(requests.filter((r) => r.view === view.name)),
  }));
  const total = summarize(requests);
  const revisit = measured.find((view) => view.name === 'austin-revisit');
  const summary = {
    byteUnits:
      'MB = 1,000,000 bytes; responseBytes = decoded body; transferBytes = CDP encoded transfer including headers, zero for browser cache hits',
    scope:
      'Browser requests only; TomTom counts local /api responses, not upstream calls behind the server cache/budget. Fresh browser session; existing server caches retained.',
    views: measured,
    total,
    revisitDelta: revisit
      ? {
          openFreeMapRequests:
            revisit.ofmTileJSON.requests + revisit.ofmTiles.requests,
          openFreeMapResponseBytes:
            revisit.ofmTileJSON.responseBytes + revisit.ofmTiles.responseBytes,
          openFreeMapTransferBytes:
            revisit.ofmTileJSON.transferBytes + revisit.ofmTiles.transferBytes,
        }
      : null,
    requests,
  };
  const cell = (value) =>
    `${value.requests} / ${(value.responseBytes / 1e6).toFixed(3)}`;
  summary.table = [...measured, { name: 'TOTAL', ...total }].map((view) => ({
    view: view.name,
    'OFM JSON req/MB': cell(view.ofmTileJSON),
    'OFM tiles req/MB': cell(view.ofmTiles),
    'ALPR JSON req/MB': cell(view.alprTileJSON),
    'ALPR tiles req/MB': cell(view.alprTiles),
    'TomTom req/MB': cell(view.tomtom),
    'Total req/MB': cell(view.total),
    'Transfer MB': (view.total.transferBytes / 1e6).toFixed(3),
    'Cache hits': view.total.cacheHits,
    Failures: view.total.failures,
  }));
  console.table(summary.table);
  console.log('Austin revisit delta:', summary.revisitDelta);
  return summary;
}
let page;
try {
  page = await browser.newPage();
  await page.evaluateOnNewDocument(() => {
    sessionStorage.setItem('gev:first-run-mission-session:v1', 'dismissed');
  });
  await page.setViewport({ width: 1440, height: 1000 });
  beginView('startup');
  await observeNetwork(page);
  page.on('pageerror', (error) => result.errors.push(error.message));
  page.on('console', (message) => {
    if (message.type() === 'error' && result.consoleErrors.length < 30)
      result.consoleErrors.push(message.text());
  });
  page.on('requestfailed', (request) => {
    if (result.failedRequests.length < 30) {
      const target = new URL(request.url());
      result.failedRequests.push({
        target: target.origin + target.pathname,
        error: request.failure()?.errorText,
      });
    }
  });
  console.log('Loading viewer...');
  const navigationUrl = new URL(url);
  navigationUrl.searchParams.set('welcome', '0');
  await page.goto(navigationUrl.href, {
    waitUntil: 'domcontentloaded',
    timeout: 60_000,
  });
  await page.waitForFunction(
    () => window.__godsEyeView?.viewer && window.__godsEyeView?.dataManager,
    { timeout: 60_000, polling: 500 },
  );
  await page.waitForFunction(
    () =>
      document.getElementById('loading-screen')?.classList.contains('hidden'),
    { timeout: 60_000, polling: 250 },
  );
  // Startup restoration owns its camera flight until the loading cover is gone.
  await page.evaluate(
    () => window.__godsEyeView.styleManager.initialRestorePromise,
  );
  await page.evaluate(() =>
    window.__godsEyeView.styleManager.setDetection({ enabled: false }),
  );
  result.renderer = await page.evaluate(() => {
    const gl = window.__godsEyeView.viewer.scene.context._gl;
    const debug = gl.getExtension('WEBGL_debug_renderer_info');
    return debug
      ? gl.getParameter(debug.UNMASKED_RENDERER_WEBGL)
      : gl.getParameter(gl.RENDERER);
  });
  await page.keyboard.press('Escape');
  await page.waitForFunction(
    () => !document.querySelector('#first-run-launcher:not([hidden])'),
    { timeout: 10_000 },
  );
  async function fly(lat, lon, height = 2000, heading = 0, pitch = -75) {
    await page.evaluate(
      async (view) => {
        const { viewer } = window.__godsEyeView;
        viewer.camera.cancelFlight();
        await new Promise((resolve) =>
          viewer.camera.flyTo({
            destination: viewer.scene.globe.ellipsoid.cartographicToCartesian({
              latitude: (view.lat * Math.PI) / 180,
              longitude: (view.lon * Math.PI) / 180,
              height: view.height,
            }),
            orientation: {
              heading: (view.heading * Math.PI) / 180,
              pitch: (view.pitch * Math.PI) / 180,
              roll: 0,
            },
            duration: 0,
            complete: resolve,
            cancel: resolve,
          }),
        );
      },
      { lat, lon, height, heading, pitch },
    );
  }
  async function settleTiles() {
    await page.waitForFunction(
      () => {
        const { scene } = window.__godsEyeView.viewer;
        if (scene.globe.show) return scene.globe.tilesLoaded;
        let found = false;
        for (let i = 0; i < scene.primitives.length; i++) {
          const primitive = scene.primitives.get(i);
          if (!primitive.show || typeof primitive.tilesLoaded !== 'boolean')
            continue;
          found = true;
          if (!primitive.tilesLoaded) return false;
        }
        return found;
      },
      { timeout: 90_000, polling: 500 },
    );
  }
  async function shot(name) {
    await settleTiles();
    assert.equal(
      await page.evaluate(
        () => !document.querySelector('#first-run-launcher:not([hidden])'),
      ),
      true,
      'first-launch modal dismissed',
    );
    await page.evaluate(async () => {
      window.__godsEyeView.requestRender('qa-overpass-offload');
      await new Promise((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(resolve)),
      );
    });
    const filename = `overpass-offload-${name}.png`;
    await page.screenshot({ path: path.join(shots, filename) });
    result.screenshots.push(filename);
  }
  async function enableTrafficTimed(name) {
    const milliseconds = await page.evaluate(
      () =>
        new Promise((resolve, reject) => {
          const { viewer, dataManager } = window.__godsEyeView;
          const start = performance.now();
          const cleanup = () => {
            remove();
            clearTimeout(timer);
          };
          const remove = viewer.scene.postRender.addEventListener(() => {
            if (dataManager.layers.get('traffic').module.getStats().count <= 0)
              return;
            const elapsed = performance.now() - start;
            cleanup();
            resolve(elapsed);
          });
          const timer = setTimeout(() => {
            cleanup();
            reject(new Error('No traffic dots within 180 seconds'));
          }, 180_000);
          Promise.resolve(dataManager.setEnabled('traffic', true)).catch(
            (error) => {
              cleanup();
              reject(error);
            },
          );
        }),
    );
    result.loadTimes[name] = Math.round(milliseconds);
    console.log(
      `${name}: ${result.loadTimes[name]} ms from enable to first rendered dots`,
    );
  }
  async function waitForSources() {
    // Let camera-move debounces fire before trusting the previous view's ready state.
    await new Promise((resolve) => setTimeout(resolve, 1500));
    const deadline = Date.now() + 180_000;
    let quietSince = null;
    while (Date.now() < deadline) {
      const states = await page.evaluate(() =>
        ['traffic', 'military-installations', 'alpr-cameras'].map((id) => {
          const layer = window.__godsEyeView.dataManager.layers.get(id);
          return { id, enabled: layer.enabled, ...layer.module.getStats() };
        }),
      );
      const busy =
        states.some((state) => state.loading) ||
        requests.some((r) => !r.finished);
      if (busy) quietSince = null;
      else quietSince ??= Date.now();
      if (quietSince && Date.now() - quietSince >= 2000) return states;
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
    throw new Error(`Sources did not settle for ${currentView.name}`);
  }
  async function tourCity(name, lat, lon, height = 450) {
    const view = beginView(name, { lat, lon, height, heading: 0, pitch: -35 });
    console.log(`Measuring ${name} at ${height} m...`);
    await fly(lat, lon, height, 0, -35);
    for (const id of ['traffic', 'military-installations', 'alpr-cameras'])
      await page.evaluate(
        (layerId) => window.__godsEyeView.dataManager.setEnabled(layerId, true),
        id,
      );
    view.layers = await waitForSources();
    for (const state of view.layers) {
      assert.equal(state.enabled, true, `${name}: ${state.id} enabled`);
      assert.ok(!state.error, `${name}: ${state.id}: ${state.error}`);
    }
    const traffic = view.layers.find((layer) => layer.id === 'traffic');
    assert.ok(traffic.count > 0, `${name}: road dots rendered`);
    assert.equal(traffic.roadSource, 'OpenStreetMap');
    await shot(`tour-${name}`);
    view.layers = await waitForSources();
    view.actualCamera = await page.evaluate(() => {
      const camera = window.__godsEyeView.viewer.camera;
      const position = camera.positionCartographic;
      return {
        lat: (position.latitude * 180) / Math.PI,
        lon: (position.longitude * 180) / Math.PI,
        height: position.height,
        pitch: (camera.pitch * 180) / Math.PI,
      };
    });
    assert.ok(
      Math.abs(view.actualCamera.lat - lat) < 1e-6,
      `${name}: fixed latitude`,
    );
    assert.ok(
      Math.abs(view.actualCamera.lon - lon) < 1e-6,
      `${name}: fixed longitude`,
    );
    assert.ok(
      Math.abs(view.actualCamera.height - height) < 1,
      `${name}: fixed altitude`,
    );
    assert.ok(
      Math.abs(view.actualCamera.pitch + 35) < 0.01,
      `${name}: fixed pitch`,
    );
  }
  if (tour) {
    // A continent jump can temporarily use the previous city's terrain height
    // for collision avoidance (São Paulo -> Austin raises a 450 m target).
    // Pin the prescribed camera fixtures so the revisit covers identical tiles.
    await page.evaluate(() => {
      window.__godsEyeView.viewer.scene.screenSpaceCameraController.enableCollisionDetection = false;
    });
    for (const city of [
      ['austin', 30.2672, -97.7431],
      ['london', 51.5074, -0.1278],
      ['dubai', 25.2048, 55.2708],
      ['san-diego', 32.7157, -117.1611],
      ['tokyo', 35.6762, 139.6503],
      ['sao-paulo', -23.5505, -46.6333, 1250],
    ])
      await tourCity(...city);
    await tourCity('austin-revisit', 30.2672, -97.7431);
  } else {
    beginView('austin', {
      lat: 30.2672,
      lon: -97.7431,
      height: 2000,
      heading: 0,
      pitch: -75,
    });
    console.log('Checking Austin traffic and ALPR...');
    await fly(30.2672, -97.7431);
    await enableTrafficTimed('initialFirstDotsMs');
    for (const id of ['military-installations', 'alpr-cameras']) {
      console.log(`Enabling ${id}...`);
      await page.evaluate(
        (layerId) =>
          Promise.race([
            window.__godsEyeView.dataManager.setEnabled(layerId, true),
            new Promise((_, reject) =>
              setTimeout(
                () => reject(new Error('Layer enable timed out')),
                30_000,
              ),
            ),
          ]),
        id,
      );
    }
    await page.waitForFunction(
      () => {
        const layers = window.__godsEyeView.dataManager.layers;
        return ['traffic', 'alpr-cameras'].every((id) => {
          const s = layers.get(id).module.getStats();
          return s.count > 0 && !s.loading && !s.error;
        });
      },
      { timeout: 120_000, polling: 500 },
    );
    const austin = await page.evaluate(() => {
      const { viewer, dataManager } = window.__godsEyeView;
      const traffic = dataManager.layers.get('traffic').module.getStats();
      const alpr = dataManager.layers.get('alpr-cameras').module.getStats();
      let cameraEntities = 0;
      for (let i = 0; i < viewer.dataSources.length; i++)
        for (const entity of viewer.dataSources.get(i).entities.values) {
          if (
            String(entity.id).startsWith('alpr:') &&
            entity.billboard &&
            entity.show
          )
            cameraEntities++;
        }
      return {
        traffic,
        alpr,
        cameraEntities,
        sourceLabel: traffic.loadingLabel,
        cameraHeight: viewer.camera.positionCartographic.height,
      };
    });
    result.traffic = austin.traffic;
    result.loadTimes[
      `${austin.traffic.mode === 'live' ? 'keyed' : 'keyless'}FirstDotsMs`
    ] = result.loadTimes.initialFirstDotsMs;
    result.alpr = austin.alpr;
    result.sourceLabel = austin.sourceLabel;
    result.cameraHeight = austin.cameraHeight;
    assert.ok(
      austin.cameraHeight > 1500 && austin.cameraHeight < 2500,
      'Austin assertions run at approximately 2 km',
    );
    assert.ok(austin.traffic.count > 0, 'road dots rendered');
    assert.ok(austin.cameraEntities > 0, 'ALPR camera entities rendered');
    assert.equal(austin.traffic.roadSource, 'OpenStreetMap');
    assert.match(austin.sourceLabel, /Roads: OpenStreetMap/);
    await shot('austin');
    async function checkStreetSurface(name) {
      await waitForSources();
      beginView(name, {
        lat: 30.2685,
        lon: -97.7425,
        height: 350,
        heading: 10,
        pitch: -30,
      });
      await page.evaluate(async () =>
        window.__godsEyeView.dataManager.setEnabled('traffic', false),
      );
      await fly(30.2685, -97.7425, 350, 10, -30);
      await settleTiles();
      await enableTrafficTimed(`${name}WarmFirstDotsMs`);
      await page.waitForFunction(
        () => {
          const s = window.__godsEyeView.dataManager.layers
            .get('traffic')
            .module.getStats();
          return s.count > 0 && !s.loading && !s.error;
        },
        { timeout: 180_000, polling: 500 },
      );
      await settleTiles();
      const measured = await page.evaluate(async () => {
        const C = await import('/node_modules/cesium/Build/Cesium/index.js');
        const { viewer, dataManager } = window.__godsEyeView;
        const { scene } = viewer;
        const collections = [];
        for (let i = 0; i < scene.primitives.length; i++) {
          const p = scene.primitives.get(i);
          if (Array.isArray(p._pointPrimitives) && p.show && p.length > 100)
            collections.push(p);
        }
        let inView = 0,
          onMesh = 0,
          sampled = 0;
        const deltas = [];
        // Freeze the sampled positions: the animator continues while the bounded batches yield.
        const positions = collections.flatMap((p) =>
          Array.from({ length: p.length }, (_, i) => p.get(i))
            .filter((p) => p.show)
            .map((p) => C.Cartesian3.clone(p.position)),
        );
        for (const position of positions) {
          const screen = C.SceneTransforms.worldToWindowCoordinates(
            scene,
            position,
          );
          if (
            !screen ||
            screen.x < 0 ||
            screen.x >= scene.canvas.clientWidth ||
            screen.y < 0 ||
            screen.y >= scene.canvas.clientHeight
          )
            continue;
          inView++;
          const carto = C.Cartographic.fromCartesian(position);
          const height = scene.globe.show
            ? scene.globe.getHeight(carto)
            : scene.sampleHeight(carto, collections);
          if (Number.isFinite(height) && Math.abs(height) <= 9000) {
            sampled++;
            const delta = carto.height - height;
            deltas.push(delta);
            if (delta >= -3 && delta <= 25) onMesh++;
          }
          if (inView % 24 === 0)
            await new Promise((resolve) => setTimeout(resolve, 0));
        }
        deltas.sort((a, b) => a - b);
        return {
          inView,
          onMesh,
          sampled,
          medianDeltaM: deltas[Math.floor(deltas.length / 2)],
          stats: dataManager.layers.get('traffic').module.getStats(),
          photoreal: !scene.globe.show,
        };
      });
      result[name] = measured;
      assert.equal(measured.stats.roadSource, 'OpenStreetMap');
      if (measured.stats.mode === 'live') {
        assert.ok(
          measured.stats.flowCoveragePct > 0,
          'Austin has matched TomTom flow',
        );
        assert.match(
          measured.stats.loadingLabel,
          /LIVE · Roads: OpenStreetMap · Flow: TomTom/,
        );
      } else {
        assert.equal(measured.stats.flowCoveragePct, 0);
        assert.match(measured.stats.loadingLabel, /SIMULATED/);
      }
      const { free, slow, jam, sim } = measured.stats.flowBuckets;
      assert.equal(
        measured.stats.flowCoveragePct,
        Math.round((100 * (free + slow + jam)) / (free + slow + jam + sim)),
      );

      console.log(
        `${name}: ${measured.onMesh}/${measured.inView} projected dots on the surface; ${measured.stats.flowCoveragePct}% flow coverage`,
      );
      await shot(name);
      await waitForSources();
      beginView(`${name}-orbit`, {
        lat: 30.2685,
        lon: -97.7425,
        height: 350,
        heading: 65,
        pitch: -40,
      });
      await fly(30.2685, -97.7425, 350, 65, -40);
      await settleTiles();
      await page.waitForFunction(
        () => {
          const s = window.__godsEyeView.dataManager.layers
            .get('traffic')
            .module.getStats();
          return s.count > 0 && !s.loading && !s.error;
        },
        { timeout: 180_000, polling: 500 },
      );
      await shot(`${name}-orbit`);
      assert.ok(
        measured.onMesh >= 150,
        `${name}: at least 150 projected dots within -3/+25 m of the surface (got ${measured.onMesh})`,
      );
    }
    console.log(
      'Checking street-level traffic against the rendered surface...',
    );
    await checkStreetSurface('traffic-street');
    if (result.traffic.mode === 'live') {
      // A second isolated page models Google configured / TomTom absent. Geometry and mesh are real responses.
      await waitForSources();
      const keyedPage = page;
      beginView('keyless-startup');
      page = await browser.newPage();
      await page.setViewport({ width: 1440, height: 1000 });
      await page.evaluateOnNewDocument(() => {
        sessionStorage.setItem('gev:first-run-mission-session:v1', 'dismissed');
        const original = window.fetch;
        window.fetch = (input, init) =>
          new URL(typeof input === 'string' ? input : input.url, location.href)
            .pathname === '/api/tomtom/status'
            ? Promise.resolve(
                new Response(JSON.stringify({ hasKey: false }), {
                  headers: { 'content-type': 'application/json' },
                }),
              )
            : original(input, init);
      });
      page.on('pageerror', (error) => result.errors.push(error.message));
      await observeNetwork(page);
      await page.goto(navigationUrl.href, {
        waitUntil: 'domcontentloaded',
        timeout: 60_000,
      });
      await page.waitForFunction(
        () =>
          window.__godsEyeView?.dataManager &&
          document
            .getElementById('loading-screen')
            ?.classList.contains('hidden'),
        { timeout: 90_000 },
      );
      await page.evaluate(
        () => window.__godsEyeView.styleManager.initialRestorePromise,
      );
      await page.evaluate(() =>
        window.__godsEyeView.styleManager.setDetection({ enabled: false }),
      );
      beginView('austin-keyless', {
        lat: 30.2672,
        lon: -97.7431,
        height: 2000,
        heading: 0,
        pitch: -75,
      });
      console.log('Checking OpenFreeMap roads without TomTom flow...');
      await fly(30.2672, -97.7431);
      await enableTrafficTimed('keylessFirstDotsMs');
      await checkStreetSurface('traffic-street-ofm');
      assert.equal(
        result['traffic-street-ofm'].stats.roadSource,
        'OpenStreetMap',
      );
      await waitForSources();
      await page.close();
      page = keyedPage;
    }
    await waitForSources();
    beginView('camp-mabry', {
      lat: 30.3125,
      lon: -97.765,
      height: 3500,
      heading: 25,
      pitch: -80,
    });
    console.log('Checking Camp Mabry...');
    const before = await page.evaluate(
      () =>
        window.__godsEyeView.dataManager.layers
          .get('military-installations')
          .module.getStats().lastUpdate,
    );
    await fly(30.3125, -97.765, 3500, 25, -80);
    await page.waitForFunction(
      (prior) => {
        const s = window.__godsEyeView.dataManager.layers
          .get('military-installations')
          .module.getStats();
        return s.count > 0 && !s.loading && !s.error && s.lastUpdate !== prior;
      },
      { timeout: 120_000, polling: 500 },
      before,
    );
    result.military = await page.evaluate(() => {
      const { viewer, dataManager } = window.__godsEyeView;
      const center = viewer.scene.globe.ellipsoid.cartographicToCartesian({
        latitude: (30.314 * Math.PI) / 180,
        longitude: (-97.763 * Math.PI) / 180,
        height: 0,
      });
      const records = dataManager.layers
        .get('military-installations')
        .module.getNearby(center, 4000);
      const ids = new Set(records.map((r) => r.id));
      let markers = 0,
        outlines = 0;
      for (let i = 0; i < viewer.dataSources.length; i++)
        for (const entity of viewer.dataSources.get(i).entities.values) {
          if (!ids.has(entity.installationId || entity.id) || !entity.show)
            continue;
          if (entity.billboard || entity.point) markers++;
          if (entity.polyline) outlines++;
        }
      return {
        markers,
        outlines,
        names: records.map((r) => r.name),
        stats: dataManager.layers
          .get('military-installations')
          .module.getStats(),
      };
    });
    assert.ok(result.military.markers > 0, 'military markers near Camp Mabry');
    assert.ok(
      result.military.outlines > 0,
      'military polygon outlines near Camp Mabry',
    );
    await shot('camp-mabry');
    await waitForSources();
    beginView('camp-mabry-close', {
      lat: 30.314,
      lon: -97.763,
      height: 650,
      heading: 125,
      pitch: -45,
    });
    await fly(30.314, -97.763, 650, 125, -45);
    await shot('camp-mabry-close');
    await waitForSources();
    beginView('fort-cavazos', {
      lat: 31.135,
      lon: -97.78,
      height: 30000,
      heading: 0,
      pitch: -90,
    });
    console.log('Checking Fort Cavazos...');
    const priorFort = await page.evaluate(
      () =>
        window.__godsEyeView.dataManager.layers
          .get('military-installations')
          .module.getStats().lastUpdate,
    );
    await fly(31.135, -97.78, 30000, 0, -90);
    await settleTiles();
    await page.waitForFunction(
      (prior) => {
        const s = window.__godsEyeView.dataManager.layers
          .get('military-installations')
          .module.getStats();
        return !s.loading && !s.error && s.count > 0 && s.lastUpdate !== prior;
      },
      { timeout: 120_000, polling: 500 },
      priorFort,
    );
    result.fortCavazos = await page.evaluate(() => {
      const { viewer, dataManager } = window.__godsEyeView;
      let markers = 0,
        outlines = 0;
      for (let i = 0; i < viewer.dataSources.length; i++)
        for (const e of viewer.dataSources.get(i).entities.values) {
          if (!e.show || !String(e.id).startsWith('ofm:installation:'))
            continue;
          if (e.point || e.billboard) markers++;
          if (e.polyline) outlines++;
        }
      return {
        markers,
        outlines,
        stats: dataManager.layers
          .get('military-installations')
          .module.getStats(),
      };
    });
    await shot('fort-cavazos');
    assert.ok(
      result.fortCavazos.markers > 0 && result.fortCavazos.markers <= 12,
      `Fort Cavazos has 1–12 installation markers (got ${result.fortCavazos.markers})`,
    );
    await waitForSources();
    beginView('austin-revisit', {
      lat: 30.2672,
      lon: -97.7431,
      height: 2000,
      heading: 0,
      pitch: -75,
    });
    await fly(30.2672, -97.7431);
    await waitForSources();
    await shot('austin-revisit');
    await waitForSources();
  }
  assert.deepEqual(
    result.forbiddenRequests,
    [],
    'zero Overpass/Nominatim browser requests',
  );
  assert.deepEqual(result.errors, [], 'no browser JavaScript errors');
  result.passed = true;
  console.log(`${result.mode} checks passed`);
} catch (error) {
  result.passed = false;
  result.failure = error.message;
  if (page) {
    await page
      .screenshot({ path: path.join(shots, 'overpass-offload-failure.png') })
      .catch(() => {});
    result.diagnostic = await page
      .evaluate(() => ({
        text: document.body.innerText.slice(0, 3000),
        layers: [...(window.__godsEyeView?.dataManager?.layers || [])]
          .filter(([id]) =>
            ['traffic', 'military-installations', 'alpr-cameras'].includes(id),
          )
          .map(([id, entry]) => [id, entry.module.getStats()]),
      }))
      .catch(() => null);
  }
  console.error(error);
  process.exitCode = 1;
} finally {
  result.footprint = footprintSummary();
  await fs.writeFile(
    path.join(shots, `overpass-offload-${result.mode}-result.json`),
    JSON.stringify(result, null, 2),
  );
  await fs.writeFile(
    path.join(shots, 'overpass-offload-result.json'),
    JSON.stringify(result, null, 2),
  );
  await browser.close();
}
