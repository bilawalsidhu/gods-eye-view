#!/usr/bin/env node
/**
 * qa-traffic-baseline.mjs — Traffic Phase 0 causal-chain capture.
 *
 * Drives four client/cache conditions and prints the User Timing segments
 * emitted by `src/data/traffic.js` when `?trafficDebug=1` is present:
 *
 *   1. exact-viewport revisit (traffic module's full-road cache),
 *   2. adjacent 0.4–2 km pan (new exact bbox with heavy spatial overlap),
 *   3. cold city (no traffic-module entry for that city),
 *   4. degraded upstream (synthetic delay on the road requests: OpenFreeMap's
 *      host, which only traffic reads in this capture, or the Overpass proxy).
 *
 * Keyless roads come from OpenFreeMap vector tiles (`tiles.openfreemap.org`);
 * a build that still reads them through the Overpass proxy has its
 * `X-Overpass-Cache` result printed for every network pass, so
 * HIT/DISK/MISS/STALE/INFLIGHT is evidence rather than inference ("—" for
 * tiles). The degraded leg delays the road requests' release in Puppeteer;
 * it exercises the same fetch-start→response boundary without adding a
 * failure switch to the application or proxy. Pass `--degraded-delay-ms 0` to skip that leg.
 * TomTom status is intercepted as keyless so no live-flow key is required and
 * the capture isolates the OSM road-to-visible-dot chain.
 *
 * Measurement caveat: durations include instrumentation overhead (observer
 * effect), and timestamps are subject to browser clock-floor quantization.
 * Per-road clock observations also sit inside `road-parse-total` and
 * `waypoint-materialization`, so those segments slightly overstate production.
 *
 * Run with deterministic software GL (relative comparisons only):
 *   node scripts/qa-traffic-baseline.mjs --url http://localhost:4173
 *
 * Run headful on the owner's real-GPU browser surface for reportable numbers:
 *   node scripts/qa-traffic-baseline.mjs --url http://localhost:4173 --headful
 *
 * SwiftShader `scene.sampleHeight` durations are NOT representative of a real
 * GPU. The script prints the detected renderer and repeats this warning when
 * software rendering is detected. It does not write baseline numbers or edit
 * the latency plan.
 */

import puppeteer from 'puppeteer';
import fs from 'node:fs';

const argv = process.argv.slice(2);
const getOpt = (name, dflt) => {
  const index = argv.indexOf(name);
  return index >= 0 && argv[index + 1] ? argv[index + 1] : dflt;
};
const getNumberOpt = (name, dflt) => {
  const value = Number(getOpt(name, dflt));
  return Number.isFinite(value) ? value : dflt;
};

const APP_URL = getOpt('--url', 'http://localhost:4173');
const HEADFUL = argv.includes('--headful');
const TIMEOUT_MS = Math.max(10_000, getNumberOpt('--timeout-ms', 120_000));
const DEGRADED_DELAY_MS = Math.max(0, getNumberOpt('--degraded-delay-ms', 2500));

const CHROME_EXECUTABLE_CANDIDATES = [
  process.env.PUPPETEER_EXECUTABLE_PATH,
  await puppeteer.executablePath().catch(() => null),
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Google Chrome Canary.app/Contents/MacOS/Google Chrome Canary',
  '/Applications/Chromium.app/Contents/MacOS/Chromium',
].filter(Boolean);

function findChromeExecutable() {
  for (const candidate of CHROME_EXECUTABLE_CANDIDATES) {
    try { if (fs.existsSync(candidate)) return candidate; } catch { /* ignore */ }
  }
  return null;
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const VIEWS = {
  austin: {
    lon: -97.7431, lat: 30.2672, height: 1500, heading: 8, pitch: -78,
  },
  adjacent: {
    // 0.0105° longitude at Austin's latitude is ~1.0 km.
    lon: -97.7326, lat: 30.2672, height: 1500, heading: 8, pitch: -78,
  },
  coldCity: {
    lon: -122.4194, lat: 37.7749, height: 1500, heading: 18, pitch: -78,
  },
  degraded: {
    lon: -98.4936, lat: 29.4241, height: 1500, heading: 12, pitch: -78,
  },
};

/** Add `trafficDebug=1` while preserving the caller's path/query/hash. */
function debugUrl(rawUrl) {
  const url = new URL(rawUrl);
  url.searchParams.set('trafficDebug', '1');
  return url.toString();
}

/**
 * Let the camera report a move the way a user's does: traffic hears the
 * camera port's `changed` at its own 5% threshold (layers/traffic/policy.js
 * CAMERA_CHANGED_THRESHOLD), which the port measures on every scene tick
 * (the first measurement after a listener subscribes only records its
 * baseline pose). Waiting for two drawn frames after the move is the sync
 * point that the port has measured it. Cesium's own moveEnd (500 ms after
 * stillness) is left to Cesium, as in the app; traffic re-checks the view
 * on it. Installed in the page as `window.__qaRenderAfterMove`; throws when
 * the frames do not draw within 5 s.
 */
function installRenderAfterMove() {
  window.__qaRenderAfterMove = (gev) => new Promise((resolve, reject) => {
    const scene = gev.viewer.scene;
    let frames = 0;
    let remove = null;
    const timer = setTimeout(() => {
      remove();
      reject(new Error(`the camera move rendered ${frames} frame(s) in 5 s`));
    }, 5000);
    remove = scene.postRender.addEventListener(() => {
      if (++frames >= 2) {
        clearTimeout(timer);
        remove();
        resolve(frames);
        return;
      }
      scene.requestRender();
    });
    scene.requestRender();
  });
}

/** Position the camera and render, so the layer hears the move as it would a user's. */
async function moveCamera(page, view) {
  return page.evaluate(async (v) => {
    const gev = window.__godsEyeView;
    const module = gev.dataManager.layers.get('traffic').module;
    const beforeLastUpdate = module.getStats().lastUpdate;
    const boundaryTime = performance.now();
    const ellipsoid = gev.viewer.scene.globe.ellipsoid;
    const radians = Math.PI / 180;
    try { gev.viewer.camera.cancelFlight(); } catch { /* no active flight */ }
    gev.viewer.camera.setView({
      destination: ellipsoid.cartographicToCartesian({
        longitude: v.lon * radians,
        latitude: v.lat * radians,
        height: v.height,
      }),
      orientation: {
        heading: (v.heading || 0) * radians,
        pitch: (v.pitch ?? -90) * radians,
        roll: 0,
      },
    });
    await window.__qaRenderAfterMove(gev);
    return { beforeLastUpdate, boundaryTime };
  }, view);
}

/** Wait until the triggered load finishes and its final render reaches postRender. */
async function waitForTrafficCapture(page, beforeLastUpdate, boundaryTime) {
  await page.waitForFunction(
    (before, boundary) => {
      const module = window.__godsEyeView?.dataManager?.layers?.get('traffic')?.module;
      if (!module) return false;
      const stats = module.getStats();
      if (stats.lastUpdate === before || stats.count <= 0 || stats.loading) return false;
      const entries = performance.getEntriesByType('measure')
        .filter((entry) => entry.startTime >= boundary);
      const renderCount = entries.filter((entry) => entry.name.startsWith('traffic:dot-construction:')).length;
      const postRenderCount = entries.filter((entry) => entry.name.startsWith('traffic:render-to-post-render:')).length;
      return renderCount > 0 && postRenderCount >= renderCount;
    },
    { timeout: TIMEOUT_MS, polling: 100 },
    beforeLastUpdate,
    boundaryTime,
  );
  // Let a final full-pass postRender land after `_fetching` flips false.
  await sleep(150);
}

/** Return serializable Traffic User Timing measures created after a boundary. */
function readTrafficMeasures(page, boundaryTime) {
  return page.evaluate((boundary) => performance.getEntriesByType('measure')
    .filter((entry) => entry.name.startsWith('traffic:') && entry.startTime >= boundary)
    .map((entry) => ({
      name: entry.name,
      startTime: entry.startTime,
      duration: entry.duration,
      detail: entry.detail,
    })), boundaryTime);
}

/**
 * Road requests the page sent, counted by the request interceptor: `sent` is
 * every road request that reached the network, `delayed` those it held for
 * the degraded leg. `requestRoads()` can be answered from decoded tiles
 * already in memory, so a `fetch-to-response` measure alone does not prove
 * the network was used.
 */
const roadRequests = { sent: 0, delayed: 0 };

/** Drive one measured state and return its raw User Timing measures. */
async function captureState(page, name, view, setDelay) {
  setDelay(name === 'degraded-upstream' ? DEGRADED_DELAY_MS : 0);
  const before = { ...roadRequests };
  const { beforeLastUpdate, boundaryTime } = await moveCamera(page, view);
  await waitForTrafficCapture(page, beforeLastUpdate, boundaryTime);
  const measures = await readTrafficMeasures(page, boundaryTime);
  setDelay(0);
  return {
    name,
    measures,
    sent: roadRequests.sent - before.sent,
    delayed: roadRequests.delayed - before.delayed,
  };
}

/** Format a duration without hiding zero-duration measurements. */
function ms(value) {
  return Number.isFinite(value) ? value.toFixed(1) : '—';
}

/** Find one segment for the same trace/pass as a render measure. */
function matchingMeasure(measures, render, segment) {
  return measures.find((entry) => (
    entry.detail?.segment === segment
    && entry.detail?.traceId === render.detail?.traceId
    && entry.detail?.interactionId === render.detail?.interactionId
    && entry.detail?.generation === render.detail?.generation
    && entry.detail?.pass === render.detail?.pass
  ));
}

/** Fail loudly instead of filtering away a structurally mispaired trace. */
function assertInteractionIntegrity(capture) {
  const interactionByTrace = new Map();
  for (const entry of capture.measures) {
    const traceId = entry.detail?.traceId;
    if (traceId == null) continue;
    const interactionId = entry.detail?.interactionId;
    if (interactionId == null) {
      throw new Error(`${capture.name}: trace ${traceId} has no scheduling interactionId`);
    }
    const prior = interactionByTrace.get(traceId);
    if (prior != null && prior !== interactionId) {
      throw new Error(
        `${capture.name}: trace ${traceId} crossed interactions ${prior} and ${interactionId}`,
      );
    }
    interactionByTrace.set(traceId, interactionId);
  }
}

/** Convert raw measures into one table row per major/full visible render. */
function rowsForCapture(capture) {
  // Correlation violations are capture failures, never rows silently removed
  // by generation/settle predicates that are tautological after the guard.
  assertInteractionIntegrity(capture);
  const renders = capture.measures.filter((entry) => (
    entry.detail?.segment === 'dot-construction'
    && entry.detail?.interactionId != null
  ));
  return renders.map((render) => {
    const get = (segment) => matchingMeasure(capture.measures, render, segment);
    const fetchStart = get('last-camera-change-to-fetch-start');
    const response = get('fetch-to-response');
    const responseJson = get('response-json');
    const sample = get('sample-height-total');
    const materialize = get('waypoint-materialization');
    const flowRace = get('flow-render-race');
    const postRender = capture.measures.find((entry) => (
      entry.detail?.segment === 'render-to-post-render'
      && entry.detail?.traceId === render.detail?.traceId
      && entry.detail?.interactionId === render.detail?.interactionId
      && entry.detail?.generation === render.detail?.generation
      && entry.detail?.renderId === render.detail?.renderId
    ));
    const visible = capture.measures.find((entry) => (
      entry.detail?.segment === 'last-camera-change-to-first-visible'
      && entry.detail?.traceId === render.detail?.traceId
      && entry.detail?.interactionId === render.detail?.interactionId
      && entry.detail?.generation === render.detail?.generation
      && entry.detail?.renderId === render.detail?.renderId
    ));
    const heatLines = capture.measures.find((entry) => (
      entry.detail?.segment === 'rebuild-heat-lines'
      && entry.detail?.traceId === render.detail?.traceId
      && entry.detail?.interactionId === render.detail?.interactionId
      && entry.detail?.generation === render.detail?.generation
      && entry.detail?.renderId === render.detail?.renderId
    ));
    const metadata = response?.detail || sample?.detail || render.detail || {};
    return {
      State: capture.name,
      Pass: render.detail?.pass || '—',
      Source: render.detail?.source || '—',
      'Proxy cache': metadata.proxyCache || '—',
      Upstream: metadata.proxyUpstream || '—',
      'Last change→fetch ms': ms(fetchStart?.duration),
      'Fetch→response ms': ms(response?.duration),
      'response.json ms': ms(responseJson?.duration),
      'Flow race ms': ms(flowRace?.duration),
      'sampleHeight ms': ms(sample?.duration),
      Calls: sample?.detail?.sampleHeightCalls ?? '—',
      'Mean/call ms': ms(sample?.detail?.sampleHeightMeanMs),
      Cells: sample?.detail?.distinctCells ?? '—',
      'Waypoints ms': ms(materialize?.duration),
      'Dots ms': ms(render.duration),
      'Heat lines ms': ms(heatLines?.duration),
      'Render→postRender ms': ms(postRender?.duration),
      'Last change→visible ms': ms(visible?.duration),
      Roads: render.detail?.roadCount ?? sample?.detail?.roadCount ?? '—',
      Dots: render.detail?.dotCount ?? '—',
    };
  });
}

/** Read the active WebGL renderer for the real-GPU/SwiftShader warning. */
function readRenderer(page) {
  return page.evaluate(() => {
    const gl = window.__godsEyeView?.viewer?.scene?.context?._gl;
    if (!gl) return 'unknown';
    const extension = gl.getExtension('WEBGL_debug_renderer_info');
    return extension
      ? gl.getParameter(extension.UNMASKED_RENDERER_WEBGL)
      : gl.getParameter(gl.RENDERER);
  });
}

async function main() {
  const url = debugUrl(APP_URL);
  console.log('\nTraffic Phase 0 — causal-chain baseline capture');
  console.log(`  App URL          : ${url}`);
  console.log(`  Browser mode     : ${HEADFUL ? 'headful (real GPU expected)' : 'headless SwiftShader (relative-only)'}`);
  console.log(`  Degraded delay   : ${DEGRADED_DELAY_MS ? `${DEGRADED_DELAY_MS} ms/request` : 'skipped'}`);

  try {
    const response = await fetch(APP_URL);
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
  } catch (error) {
    console.error(`\nDev server not reachable at ${APP_URL} (${error.message}).`);
    process.exit(2);
  }

  const executablePath = findChromeExecutable();
  const browser = await puppeteer.launch({
    headless: HEADFUL ? false : 'new',
    ...(executablePath ? { executablePath } : {}),
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-background-timer-throttling',
      '--disable-renderer-backgrounding',
      '--window-size=1440,900',
      ...(HEADFUL ? [] : ['--use-gl=angle', '--use-angle=swiftshader']),
    ],
  });

  let activeProxyDelayMs = 0;
  const captures = [];
  const consoleErrors = [];
  try {
    const page = await browser.newPage();
    await page.setViewport({ width: 1440, height: 900 });
    await page.evaluateOnNewDocument(() => localStorage.clear());
    await page.evaluateOnNewDocument(installRenderAfterMove);
    page.on('console', (message) => {
      if (message.type() === 'error') consoleErrors.push(message.text());
    });
    page.on('pageerror', (error) => consoleErrors.push(error.message));

    // Force keyless traffic and optionally hold the road requests to model a
    // degraded upstream. No server key or proxy debug endpoint is needed.
    await page.setRequestInterception(true);
    page.on('request', async (request) => {
      if (request.url().includes('/api/tomtom/status')) {
        await request.respond({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({ hasKey: false }),
        });
        return;
      }
      const roadRequest = request.url().includes('/api/overpass')
        || new URL(request.url()).hostname === 'tiles.openfreemap.org';
      if (roadRequest) roadRequests.sent += 1;
      if (activeProxyDelayMs > 0 && roadRequest) {
        roadRequests.delayed += 1;
        await sleep(activeProxyDelayMs);
      }
      try { await request.continue(); } catch { /* page closed or already handled */ }
    });

    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60_000 });
    await page.waitForFunction(
      () => window.__godsEyeView?.viewer && window.__godsEyeView?.dataManager,
      { timeout: 60_000 },
    );

    // Disable all persisted overlays, park above traffic's activation ceiling,
    // then enable traffic without accidentally starting an unmeasured load.
    await page.evaluate(async (highView) => {
      const gev = window.__godsEyeView;
      await gev.dataManager.restoreEnabledLayerIds([]);
      const ellipsoid = gev.viewer.scene.globe.ellipsoid;
      const radians = Math.PI / 180;
      gev.viewer.camera.setView({
        destination: ellipsoid.cartographicToCartesian({
          longitude: highView.lon * radians,
          latitude: highView.lat * radians,
          height: 9000,
        }),
        orientation: { heading: 0, pitch: -Math.PI / 2, roll: 0 },
      });
      await gev.dataManager.setEnabled('traffic', true);
      // Also records the baseline pose traffic's new `changed` listener
      // measures the first measured move against.
      await window.__qaRenderAfterMove(gev);
    }, VIEWS.austin);
    await sleep(500);

    const renderer = await readRenderer(page);
    const softwareRenderer = /swiftshader|software/i.test(renderer);
    console.log(`  WebGL renderer   : ${renderer}`);
    if (!HEADFUL || softwareRenderer) {
      console.log('  WARNING          : sampleHeight timings are relative-only under SwiftShader/software GL.');
    }

    // Prime Austin once. Its measurements are deliberately not reported.
    console.log('\nPriming the exact Austin viewport (not part of the table)...');
    const prime = await captureState(page, 'prime', VIEWS.austin, (msValue) => {
      activeProxyDelayMs = msValue;
    });
    if (!prime.measures.some((entry) => entry.detail?.segment === 'dot-construction')) {
      throw new Error('trafficDebug instrumentation emitted no dot-construction measure');
    }

    // Clear the last-bounds gate without clearing the module's road cache, then
    // revisit the byte-identical camera pose for a true client-cache hit.
    await page.evaluate(async (view) => {
      const gev = window.__godsEyeView;
      const ellipsoid = gev.viewer.scene.globe.ellipsoid;
      const radians = Math.PI / 180;
      gev.viewer.camera.setView({
        destination: ellipsoid.cartographicToCartesian({
          longitude: view.lon * radians,
          latitude: view.lat * radians,
          height: 9000,
        }),
        orientation: { heading: 0, pitch: -Math.PI / 2, roll: 0 },
      });
      await window.__qaRenderAfterMove(gev);
    }, VIEWS.austin);
    await sleep(500);

    captures.push(await captureState(page, 'exact-viewport revisit', VIEWS.austin, (msValue) => {
      activeProxyDelayMs = msValue;
    }));
    captures.push(await captureState(page, 'adjacent ~1.0 km pan', VIEWS.adjacent, (msValue) => {
      activeProxyDelayMs = msValue;
    }));
    captures.push(await captureState(page, 'cold city (client)', VIEWS.coldCity, (msValue) => {
      activeProxyDelayMs = msValue;
    }));
    if (DEGRADED_DELAY_MS > 0) {
      captures.push(await captureState(page, 'degraded-upstream', VIEWS.degraded, (msValue) => {
        activeProxyDelayMs = msValue;
      }));
    }

    const missingStates = captures.filter((capture) => rowsForCapture(capture).length === 0);
    if (missingStates.length) {
      throw new Error(`no visible render captured for: ${missingStates.map((capture) => capture.name).join(', ')}`);
    }
    const exactRows = rowsForCapture(captures[0]);
    if (!exactRows.some((row) => row.Source === 'client-cache' && row['Fetch→response ms'] === '—')) {
      throw new Error('exact-viewport revisit did not use the traffic module cache');
    }
    for (const capture of captures.slice(1)) {
      if (!capture.measures.some((entry) => entry.detail?.segment === 'fetch-to-response')) {
        throw new Error(`${capture.name} did not issue a road request`);
      }
    }
    if (DEGRADED_DELAY_MS > 0) {
      const degraded = captures.find((capture) => capture.name === 'degraded-upstream');
      const delayed = degraded?.measures.some((entry) => (
        entry.detail?.segment === 'fetch-to-response'
        && entry.duration >= DEGRADED_DELAY_MS * 0.9
      ));
      if (!delayed) throw new Error('degraded-upstream leg did not observe the synthetic delay');
      // The delay has to come from held road requests, not from processing
      // that happened to run long.
      if (!degraded.delayed) throw new Error('degraded-upstream leg sent no road request to hold');
    }
    // A city the client has never seen has no tiles in memory: it must reach
    // the network. The other legs may legitimately be answered from tiles
    // already decoded, so their counts are reported, not asserted.
    const cold = captures.find((capture) => capture.name === 'cold city (client)');
    if (!cold?.sent) throw new Error('cold city leg sent no road request to the network');

    const rows = captures.flatMap(rowsForCapture);
    if (!rows.length) throw new Error('no measured traffic renders were captured');
    console.log('\nCausal segments (one row per visible major/full pass)');
    console.table(rows);
    console.log('\nRoad requests sent to the network per leg (held by the degraded leg)');
    console.table(captures.map((capture) => ({
      State: capture.name,
      Sent: capture.sent,
      Held: capture.delayed,
    })));
    console.log('\nNotes:');
    console.log('  - Render→postRender is the first visible-frame boundary used by Phase 0.');
    console.log('  - Proxy cache is read from X-Overpass-Cache; “—” means the client cache avoided fetch, or the roads came from OpenFreeMap tiles.');
    console.log('  - Through the Overpass proxy, Fetch→response is the HTTP response and response.json is body transfer plus JSON decoding.');
    console.log('  - From OpenFreeMap tiles, Fetch→response spans the tile requests, body reads, decoding and composition, and response.json only hands back the built object; a held leg can stack the delay over tiles fetched in turn.');
    console.log('  - Last change→fetch is the 320 ms FETCH_DEBOUNCE for the first fetch by construction, plus timer and main-thread latency (larger under SwiftShader).');
    console.log('  - Full-pass Last change→fetch also includes the intentionally sequential major pass.');
    console.log('  - Cesium moveEnd is raised ~500 ms after stillness, typically after fetch starts; fetch never waits for it, and traffic only re-checks the view on it.');
    console.log('  - Moves are setView plus rendered frames: the camera port measures traffic\'s own 5% changed threshold as for a user move (inertia is bypassed).');
    console.log('  - The keyless capture zeroes Flow race and Heat lines work; live-keyed numbers will differ.');
    console.log('  - Measurement caveat: timings include instrumentation overhead (observer effect) and browser clock-floor quantization.');
    console.log('  - Per-road clock observations inside road-parse-total/waypoint-materialization slightly overstate production work.');
    const timingDiagnostics = await page.evaluate(() => (
      window.__godsEyeView.dataManager.layers.get('traffic').module.getStats().trafficTiming
    ));
    console.log(`  - Correlation drops: ${timingDiagnostics?.uncorrelatedTracesDropped ?? 'unavailable'} scheduling-anchor mismatch(es).`);
    if (!HEADFUL || softwareRenderer) {
      console.log('  - Do not copy these GPU-side numbers into the plan; rerun headful on a real-GPU surface.');
    }
    if (consoleErrors.length) {
      console.log(`  - Browser console errors observed: ${consoleErrors.length}`);
      for (const error of consoleErrors.slice(0, 5)) console.log(`      ${error}`);
    }
  } finally {
    await browser.close();
  }
}

main().catch((error) => {
  console.error('\nTraffic baseline capture failed:', error);
  process.exit(3);
});
