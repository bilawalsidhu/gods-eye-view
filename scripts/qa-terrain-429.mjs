#!/usr/bin/env node
/**
 * Keyless terrain throttling probe.
 *
 * On the keyless map source the browser fetches Re:Earth quantized-mesh tiles
 * (`terrain.reearth.land/cesium-mesh/ellipsoid/{z}/{x}/{y}.terrain`) directly.
 * A zoom-out burst asks for a few dozen shallow tiles at once and the upstream
 * answers HTTP 429 for most of them. This harness drives that burst, counts the
 * throttled responses, keeps the first 429's headers as evidence, and then
 * checks whether every throttled tile eventually loaded — the contract the
 * client-side retry in `src/maps/terrain.js` provides.
 *
 * Run against a keyless dev server (no Google or ion credentials):
 *   env -u GOOGLE_MAPS_API_KEY -u CESIUM_ION_TOKEN npm run dev -- --port 4180
 *   QA_BASE_URL=http://localhost:4180 node scripts/qa-terrain-429.mjs
 *
 * Flags: `--mode zoomOut|wheel` (default zoomOut), `--notches N` (default 12),
 * `--settle MS` (default 25000), `--rounds N` (default 1), `--inject N`
 * (answer the first N tile requests of each burst with a synthetic 429),
 * `--headful`.
 * Exits 1 when a throttled tile never recovered or a terrain tile is left in
 * Cesium's FAILED state.
 */
import fs from 'node:fs';
import puppeteer from 'puppeteer';

const appUrl = process.env.QA_BASE_URL || 'http://localhost:4173';
const argv = process.argv.slice(2);
const flag = (name, fallback) => {
  const index = argv.indexOf(`--${name}`);
  return index >= 0 && argv[index + 1] !== undefined
    ? argv[index + 1]
    : fallback;
};
const mode = flag('mode', 'zoomOut');
const notches = Number(flag('notches', 12));
const settleMs = Number(flag('settle', 25000));
const rounds = Number(flag('rounds', 1));
// The upstream throttle is load-dependent and does not fire on demand. With
// `--inject N`, the first N tile requests of each burst are answered 429 by an
// XMLHttpRequest shim inside the page so the recovery contract can be proven
// deterministically; real 429s are still counted and kept as evidence. (CDP
// request interception is not used: it stalls Cesium's request scheduler.)
const inject = Number(flag('inject', 0));
const headful = argv.includes('--headful');
const TERRAIN_HOST = 'terrain.reearth.land';
const TILE_PATTERN = /\/cesium-mesh\/ellipsoid\/\d+\/\d+\/\d+\.terrain/;

const executablePath =
  process.env.PUPPETEER_EXECUTABLE_PATH ||
  (await puppeteer.executablePath().catch(() => null));
if (!executablePath || !fs.existsSync(executablePath)) {
  throw new Error('Puppeteer Chrome for Testing is unavailable');
}

const browser = await puppeteer.launch({
  headless: headful ? false : 'new',
  executablePath,
  args: [
    ...(process.platform === 'darwin'
      ? ['--use-angle=metal', '--enable-gpu']
      : ['--use-gl=angle', '--use-angle=swiftshader']),
    '--no-sandbox',
  ],
});
const page = await browser.newPage();
await page.setViewport({ width: 1280, height: 800 });

/** @type {Map<string, {statuses: number[], failures: number}>} per tile URL. */
const tiles = new Map();
const evidence = [];
let layerJsonSeen = false;
let recording = false;
let requestsInWindow = 0;
let throttledInWindow = 0;
const tileEntry = (url) => {
  if (!tiles.has(url)) tiles.set(url, { statuses: [], failures: 0 });
  return tiles.get(url);
};

if (inject > 0) {
  // Cesium fetches terrain through XMLHttpRequest and reads status, response
  // and getAllResponseHeaders() in its onload handler; shadowing those on the
  // instance is enough to make it see a throttled reply.
  await page.evaluateOnNewDocument((pattern) => {
    const tilePattern = new RegExp(pattern);
    const shim = { remaining: 0, injected: [] };
    window.__qaTerrainThrottle = shim;
    const open = XMLHttpRequest.prototype.open;
    const send = XMLHttpRequest.prototype.send;
    XMLHttpRequest.prototype.open = function (method, url, ...rest) {
      this.__qaUrl = String(url);
      return open.call(this, method, url, ...rest);
    };
    XMLHttpRequest.prototype.send = function (...args) {
      if (!(shim.remaining > 0 && tilePattern.test(this.__qaUrl || ''))) {
        return send.apply(this, args);
      }
      shim.remaining -= 1;
      shim.injected.push(this.__qaUrl);
      const xhr = this;
      setTimeout(() => {
        for (const [key, value] of [
          ['status', 429],
          ['readyState', 4],
          ['response', null],
        ]) {
          Object.defineProperty(xhr, key, { value, configurable: true });
        }
        xhr.getAllResponseHeaders = () => 'retry-after: 1\r\n';
        xhr.onload?.(new Event('load'));
      }, 30);
      return undefined;
    };
  }, TILE_PATTERN.source);
}

page.on('response', async (response) => {
  const url = response.url();
  if (!url.includes(TERRAIN_HOST)) return;
  if (url.endsWith('layer.json')) layerJsonSeen = true;
  if (!TILE_PATTERN.test(url)) return;
  const status = response.status();
  tileEntry(url).statuses.push(status);
  if (recording) requestsInWindow += 1;
  if (status !== 429) return;
  if (recording) throttledInWindow += 1;
  if (evidence.length < 3) {
    let body = '';
    try {
      body = (await response.text()).slice(0, 160);
    } catch {
      /* body unavailable */
    }
    evidence.push({ url, status, headers: response.headers(), body });
  }
});
page.on('requestfailed', (request) => {
  const url = request.url();
  if (!TILE_PATTERN.test(url)) return;
  tileEntry(url).failures += 1;
  if (recording) requestsInWindow += 1;
});

const consoleErrors = [];
page.on('pageerror', (error) => consoleErrors.push(error.message));
page.on('console', (message) => {
  if (message.type() === 'error') consoleErrors.push(message.text());
});

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const waitFor = async (predicate, timeoutMs, label) => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await sleep(250);
  }
  throw new Error(`timed out waiting for ${label}`);
};

const setCamera = (lon, lat, height) =>
  page.evaluate(
    ({ lon, lat, height }) => {
      const viewer = window.__godsEyeView.viewer;
      // The app's own startup flight would otherwise keep steering the camera
      // through the burst and turn the zoom-out into a zoom-in.
      viewer.camera.cancelFlight();
      const cartographic =
        viewer.camera.positionCartographic.constructor.fromDegrees(
          lon,
          lat,
          height,
        );
      viewer.camera.setView({
        destination:
          viewer.scene.globe.ellipsoid.cartographicToCartesian(cartographic),
        orientation: { heading: 0, pitch: -Math.PI / 2, roll: 0 },
      });
      window.__godsEyeView.requestRender?.();
    },
    { lon, lat, height },
  );

const cameraHeight = () =>
  page.evaluate(
    () => window.__godsEyeView.viewer.camera.positionCartographic.height,
  );

const globeState = () =>
  page.evaluate(() => {
    const viewer = window.__godsEyeView.viewer;
    const surface = viewer.scene.globe._surface;
    let failed = 0;
    let loaded = 0;
    const visit = (tile) => {
      if (!tile) return;
      const state = tile.data?.terrainState;
      if (state === 0) failed += 1;
      else if (state === 6) loaded += 1;
      for (const child of tile._children || []) visit(child);
    };
    for (const tile of surface._levelZeroTiles || []) visit(tile);
    return {
      failed,
      loaded,
      tilesLoaded: viewer.scene.globe.tilesLoaded,
      provider: viewer.terrainProvider?.constructor?.name,
    };
  });

const burst = async () => {
  if (mode === 'zoomOut') {
    for (let i = 0; i < notches; i += 1) {
      await page.evaluate(() => {
        const viewer = window.__godsEyeView.viewer;
        viewer.camera.zoomOut(viewer.camera.positionCartographic.height * 0.6);
        window.__godsEyeView.requestRender?.();
      });
      await sleep(40);
    }
    return;
  }
  await page.mouse.move(640, 400);
  for (let i = 0; i < notches; i += 1) {
    await page.mouse.wheel({ deltaY: 200 });
    await page.evaluate(() => window.__godsEyeView.requestRender?.());
    await sleep(40);
  }
};

try {
  await page.goto(appUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.waitForFunction(() => Boolean(window.__godsEyeView?.viewer), {
    timeout: 60000,
  });
  await waitFor(() => layerJsonSeen, 60000, 'the Re:Earth layer.json fetch');
  await waitFor(
    async () => (await globeState()).provider === 'CesiumTerrainProvider',
    30000,
    'the keyless terrain provider',
  );

  const summaries = [];
  for (let round = 1; round <= rounds; round += 1) {
    // Re-apply the view until it sticks: a still-running startup flight can
    // overwrite the first setView on the very next frame.
    for (let attempt = 0; attempt < 5; attempt += 1) {
      await setCamera(-97.7431, 30.2672, 40000);
      await sleep(1500);
      const height = await cameraHeight();
      if (Math.abs(height - 40000) < 1000) break;
    }
    await waitFor(
      async () => (await globeState()).tilesLoaded,
      30000,
      'the 40 km view to settle',
    ).catch(() => {});
    await sleep(2000);
    const settledHeight = await cameraHeight();
    if (Math.abs(settledHeight - 40000) > 1000) {
      throw new Error(
        `camera did not hold the 40 km start view (at ${Math.round(settledHeight)} m)`,
      );
    }
    const before = await globeState();
    tiles.clear();
    requestsInWindow = 0;
    throttledInWindow = 0;
    if (inject > 0) {
      await page.evaluate((count) => {
        window.__qaTerrainThrottle.remaining = count;
        window.__qaTerrainThrottle.injected = [];
      }, inject);
    }
    recording = true;
    const startHeight = await cameraHeight();
    await burst();
    const endHeight = await cameraHeight();
    await sleep(settleMs);
    recording = false;

    // Injected throttles never reach the network, so fold them in from the
    // page: a later real 200 for the same tile is the retry succeeding.
    const injected =
      inject > 0
        ? await page.evaluate(() => window.__qaTerrainThrottle.injected)
        : [];
    for (const url of injected) tileEntry(url).statuses.unshift(429);
    const throttled = [...tiles.entries()].filter(([, entry]) =>
      entry.statuses.includes(429),
    );
    const recovered = throttled.filter(([, entry]) =>
      entry.statuses.includes(200),
    );
    const unrecovered = throttled.filter(
      ([, entry]) => !entry.statuses.includes(200),
    );
    const after = await globeState();
    summaries.push({
      round,
      mode,
      notches,
      startHeightKm: Math.round(startHeight / 1000),
      endHeightKm: Math.round(endHeight / 1000),
      tileResponses: requestsInWindow,
      throttledResponses: throttledInWindow,
      injectedThrottles: injected.length,
      throttledTiles: throttled.length,
      recoveredTiles: recovered.length,
      unrecoveredTiles: unrecovered.length,
      failedTilesBefore: before.failed,
      failedTilesAfter: after.failed,
      loadedTilesAfter: after.loaded,
    });
    console.log(JSON.stringify(summaries.at(-1)));
    if (unrecovered.length) {
      console.log(
        '  unrecovered: ' +
          unrecovered
            .slice(0, 8)
            .map(
              ([url, entry]) =>
                `${new URL(url).pathname} [${entry.statuses.join(',')}]`,
            )
            .join(' · '),
      );
    }
  }
  if (evidence.length) {
    console.log('first 429 evidence:');
    for (const item of evidence) {
      const headers = Object.fromEntries(
        Object.entries(item.headers).filter(([name]) =>
          /^(cf-|retry-after|server|content-type|date|x-ratelimit|ratelimit|access-control)/i.test(
            name,
          ),
        ),
      );
      console.log(
        `  ${new URL(item.url).pathname} ${JSON.stringify(headers)} body=${JSON.stringify(item.body)}`,
      );
    }
  }
  const failures = summaries.filter(
    (summary) => summary.unrecoveredTiles > 0 || summary.failedTilesAfter > 0,
  );
  const terrainErrors = consoleErrors.filter((text) =>
    /terrain tile/i.test(text),
  );
  if (terrainErrors.length) {
    console.log(`terrain console errors: ${terrainErrors.length}`);
    console.log(`  ${terrainErrors[0].slice(0, 200)}`);
  }
  console.log(
    failures.length
      ? `FAIL — ${failures.length}/${summaries.length} round(s) left throttled terrain tiles unloaded`
      : `PASS — every throttled terrain tile recovered in ${summaries.length} round(s)`,
  );
  process.exitCode = failures.length ? 1 : 0;
} finally {
  await browser.close();
}
