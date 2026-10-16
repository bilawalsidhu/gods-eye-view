#!/usr/bin/env node
/**
 * The application shell on each globe engine, in headless Chrome: boots the
 * app with ?engine=cesium (the default) and ?engine=navara and checks, per
 * engine:
 *
 * - the engine kind, and a viewer for Cesium only (window.__godsEyeView);
 * - no console errors (KNOWN_NOISE lists the only ones tolerated);
 * - the map is drawn (the engine canvas is not blank) once the tiles load;
 * - idle: no frames for 2 s once the tiles have loaded;
 * - attributions: the Google line is on screen (Cesium's credit strip,
 *   Navara's attribution card);
 * - search: a city typed into the location search flies near it, and after
 *   searching Tokyo the HUD's own lat/lon text reads Tokyo;
 * - navigation: north up, tilt, wheel zoom and reset to the globe; the wheel
 *   stops above the ground (the smallest clearance on any frame: Cesium
 *   >= -1 m over the sampled surface, Navara >= 29 m over its ground floor's
 *   own ground, which it keeps 30 m below the camera);
 * - orbit: frames keep coming while it runs and stop when it stops;
 * - the HUD readouts follow the camera;
 * - share links: the hash written for a pose restores that pose on reload
 *   (Cesium within 1e-6; Navara's deltas are recorded);
 * - map stacks: base imagery and back to Google 3D;
 * - surface heights: surface.sampleHeight at points of the Austin startup
 *   pose, the ground under the camera included, is finite.
 *
 * With both engines, then across them: those heights agree within 2 m, the
 * share hash written on each engine opened on the other gives the same pose
 * (<= 1 m, <= 0.1°), and both engines
 * at one fixed pose are photographed side by side (--out keeps
 * qa-engine-side-by-side.png and .jpg).
 *
 *   node scripts/qa-engine-shell.mjs [--engine=cesium|navara|both]
 *     [--base-url=URL] [--out=DIR]
 *
 * Starts this checkout's Vite dev server on a free port (never 4185–4189) unless
 * --base-url names a running server (a `vite preview` of a build works too).
 * --out keeps a screenshot per engine. Browsers are always headless. Provider
 * keys are never printed: console text is redacted, and the map sources the
 * engine shows (engine.maps.current(), which holds keys) are never read.
 * Exits 1 on any failure.
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer';

const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
);
const argument = (name) =>
  process.argv
    .find((value) => value.startsWith(`--${name}=`))
    ?.slice(name.length + 3);

const engineArg = argument('engine') ?? 'both';
const ENGINES =
  engineArg === 'both' ? ['cesium', 'navara'] : engineArg.split(',');
for (const engine of ENGINES) {
  if (!['cesium', 'navara'].includes(engine)) {
    console.error(`Unknown engine "${engine}"; known: cesium, navara, both`);
    process.exit(2);
  }
}
const outDir = argument('out');
const BOOT_TIMEOUT_MS = Number(process.env.QA_BOOT_TIMEOUT_MS || 180000);
const RESERVED_PORTS = new Set([4185, 4186, 4187, 4188, 4189]);
const SEARCH = { query: 'Paris', lat: 48.8566, lon: 2.3522, withinKm: 60 };
const SHARE_TOLERANCE = 1e-6;
const TOKYO = { query: 'Tokyo', lat: 35.6762, lon: 139.6503, withinKm: 60 };
// Smallest clearance (m) on any frame of the wheel zoom. Cesium stops at the
// rendered surface (sampleHeight). Navara's floor keeps 30 m above the ground
// it sampled itself; 1 m allows for the camera moving within a frame.
const MIN_CLEARANCE = { cesium: -1, navara: 29 };
// Cross-engine share links: the same hash on the other engine.
const CROSS_TOLERANCE = { metres: 1, degrees: 0.1 };
// Idle: no frames over this long once the tiles have loaded.
const IDLE_MS = 2000;
// surface.sampleHeight at the Austin startup pose (600 m, looking ahead):
// the ground under the camera (outside the frustum) and points up to the
// view centre, in degrees. Both engines agree within 2 m where their tiles
// have loaded (S2).
const SURFACE_POINTS = [
  [30.2672, -97.7431],
  [30.268, -97.7428],
  [30.269, -97.7425],
  [30.27, -97.742],
  [30.2741, -97.741],
  [30.265, -97.744],
  [30.26, -97.746],
];
const SURFACE_TOLERANCE_M = 2;
// The pose both engines are photographed at for the side-by-side picture.
const SIDE_BY_SIDE_HASH =
  'v=2&lat=40.7060&lon=-74.0130&alt=900&heading=30&pitch=-25&roll=0';

/**
 * Console errors tolerated in either mode, each for a stated reason. Anything
 * else fails the run.
 */
const KNOWN_NOISE = [
  {
    // `vite preview` serves no app API; the provider-settings probe 404s.
    pattern: /Failed to load resource: .*404/,
    when: (entry) => /\/api\/setup\/status/.test(entry.url ?? ''),
    reason: 'vite preview has no /api/setup/status',
  },
];

/**
 * Known gaps: checks that fail on an engine for a documented reason. They are
 * reported as GAP and do not fail the run; each names its follow-up.
 */
const KNOWN_GAPS = {};

const redact = (text) =>
  String(text)
    .replace(/([?&](?:key|token|access_token|apiKey)=)[^&\s"')]+/gi, '$1…')
    .replace(/AIza[0-9A-Za-z_-]{20,}/g, 'AIza…')
    .replace(/eyJ[0-9A-Za-z_.-]{20,}/g, 'eyJ…');

function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      server.close(() =>
        RESERVED_PORTS.has(port) ? resolve(freePort()) : resolve(port),
      );
    });
  });
}

async function waitForHttp(url, child, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (child?.exitCode != null)
      throw new Error(`dev server exited with ${child.exitCode}`);
    try {
      const response = await fetch(url);
      if (response.ok) return;
    } catch {
      /* not listening yet */
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`dev server did not answer ${url}`);
}

async function startServer() {
  const port = await freePort();
  const child = spawn(
    process.execPath,
    [
      path.join(repoRoot, 'node_modules/vite/bin/vite.js'),
      '--port',
      String(port),
      '--strictPort',
      '--host',
      'localhost',
    ],
    { cwd: repoRoot, stdio: ['ignore', 'ignore', 'pipe'] },
  );
  let stderr = '';
  child.stderr.on('data', (chunk) => {
    stderr = (stderr + chunk).slice(-4000);
  });
  const url = `http://localhost:${port}/`;
  try {
    await waitForHttp(url, child, 60000);
  } catch (error) {
    child.kill('SIGTERM');
    throw new Error(`${error.message}\n${redact(stderr)}`);
  }
  return { url, stop: () => child.kill('SIGTERM') };
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// --- In-page probes (each runs in the page; no keys leave it) --------------

/** The camera as plain numbers: degrees, metres. */
function readPose() {
  const { engine } = window.__godsEyeView;
  const pose = engine.camera.pose();
  const deg = (radians) => (radians * 180) / Math.PI;
  return {
    lat: deg(pose.cartographic.latitude),
    lon: deg(pose.cartographic.longitude),
    height: pose.cartographic.height,
    heading: deg(pose.heading),
    pitch: deg(pose.pitch),
    roll: deg(pose.roll),
    x: pose.position.x,
    y: pose.position.y,
    z: pose.position.z,
  };
}

/** Resolves once the camera has been still for `stillMs`. */
async function waitForRest(stillMs = 1500, timeoutMs = 60000) {
  const { engine } = window.__godsEyeView;
  const read = () => {
    const pose = engine.camera.pose();
    return [
      pose.position.x,
      pose.position.y,
      pose.position.z,
      pose.direction.x,
      pose.direction.y,
      pose.direction.z,
    ];
  };
  let last = read();
  let stillSince = performance.now();
  const deadline = performance.now() + timeoutMs;
  while (performance.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 200));
    const now = read();
    if (now.some((value, index) => Math.abs(value - last[index]) > 1e-6)) {
      stillSince = performance.now();
      last = now;
    } else if (performance.now() - stillSince >= stillMs) return true;
  }
  return false;
}

/** Colour spread of the engine canvas (its drawing buffer is preserved). */
function canvasStats() {
  const source = window.__godsEyeView.engine.host.canvas;
  const probe = document.createElement('canvas');
  probe.width = 96;
  probe.height = 64;
  const context = probe.getContext('2d', { willReadFrequently: true });
  context.drawImage(source, 0, 0, probe.width, probe.height);
  const { data } = context.getImageData(0, 0, probe.width, probe.height);
  let sum = 0;
  let sumSq = 0;
  let lit = 0;
  const colours = new Set();
  const count = data.length / 4;
  for (let index = 0; index < data.length; index += 4) {
    const luma =
      0.2126 * data[index] +
      0.7152 * data[index + 1] +
      0.0722 * data[index + 2];
    sum += luma;
    sumSq += luma * luma;
    if (luma > 24) lit += 1;
    colours.add(
      ((data[index] >> 4) << 8) |
        ((data[index + 1] >> 4) << 4) |
        (data[index + 2] >> 4),
    );
  }
  const mean = sum / count;
  return {
    mean: Math.round(mean * 10) / 10,
    stddev:
      Math.round(Math.sqrt(Math.max(0, sumSq / count - mean * mean)) * 10) / 10,
    litFraction: Math.round((lit / count) * 1000) / 1000,
    colours: colours.size,
    width: source.width,
    height: source.height,
  };
}

/** Rendered frames (postRender) over `ms`, and whether the camera moved. */
async function countFrames(ms) {
  const { engine } = window.__godsEyeView;
  let frames = 0;
  const remove = engine.frames.postRender.addEventListener(() => {
    frames += 1;
  });
  const before = engine.camera.pose().heading;
  await new Promise((resolve) => setTimeout(resolve, ms));
  remove();
  return {
    frames,
    headingMoved: Math.abs(engine.camera.pose().heading - before) > 1e-4,
    continuous: engine.render.isContinuous(),
  };
}

/**
 * Records the camera's clearance above the sampled surface on every rendered
 * frame until stopClearanceWatch.
 */
function startClearanceWatch() {
  const { engine } = window.__godsEyeView;
  // Navara's floor keeps its margin above the ground it sampled itself
  // (engine.groundFloor, diagnostics); a fresh sample would also measure the
  // tiles streaming in under a still camera (about 8 m at Paris). Cesium
  // stops at the rendered surface: a fresh sampleHeight.
  const groundUnder = (pose) =>
    engine.groundFloor
      ? engine.groundFloor.ground()
      : engine.surface.sampleHeight(pose.cartographic);
  window.__qaGroundUnder = groundUnder;
  const watch = { min: null, sampled: 0, unsampled: 0, lowest: null };
  watch.remove = engine.frames.postRender.addEventListener(() => {
    const pose = engine.camera.pose();
    const ground = groundUnder(pose);
    if (!Number.isFinite(ground)) {
      watch.unsampled += 1;
      return;
    }
    const clearance = pose.cartographic.height - ground;
    watch.sampled += 1;
    if (watch.min == null || clearance < watch.min) {
      watch.min = clearance;
      watch.lowest = {
        height: pose.cartographic.height,
        ground,
        lat: (pose.cartographic.latitude * 180) / Math.PI,
        lon: (pose.cartographic.longitude * 180) / Math.PI,
        pitch: (pose.pitch * 180) / Math.PI,
      };
    }
  });
  window.__qaClearanceWatch = watch;
}

/** Ends the watch; the final pose's clearance and the smallest one seen. */
function stopClearanceWatch() {
  const { engine } = window.__godsEyeView;
  const watch = window.__qaClearanceWatch;
  watch.remove();
  delete window.__qaClearanceWatch;
  const pose = engine.camera.pose();
  const sampled = window.__qaGroundUnder(pose);
  delete window.__qaGroundUnder;
  const ground = Number.isFinite(sampled) ? sampled : null;
  const clearance = ground == null ? null : pose.cartographic.height - ground;
  const minClearance =
    clearance == null
      ? watch.min
      : watch.min == null
        ? clearance
        : Math.min(watch.min, clearance);
  return {
    height: pose.cartographic.height,
    ground,
    clearance,
    minClearance,
    lowest: watch.lowest,
    sampled: watch.sampled,
    unsampled: watch.unsampled,
  };
}

/**
 * The on-screen attribution that names Google: Cesium's credit strip
 * (#cesium-credits) or Navara's attribution card. Visible means displayed,
 * inside the viewport and, for Navara, the Google line inside the card's
 * scrolled list.
 */
function readAttribution() {
  const inViewport = (rect) =>
    rect.width > 0 &&
    rect.height > 0 &&
    rect.right > 0 &&
    rect.bottom > 0 &&
    rect.left < window.innerWidth &&
    rect.top < window.innerHeight;
  const shown = (element) => {
    for (let node = element; node; node = node.parentElement) {
      const style = getComputedStyle(node);
      if (
        node.hidden ||
        style.display === 'none' ||
        style.visibility === 'hidden' ||
        Number(style.opacity) === 0
      )
        return false;
    }
    return true;
  };
  const googleIn = (element) =>
    /google/i.test(element.textContent ?? '') ||
    [...element.querySelectorAll('img')].some((image) =>
      /google/i.test(`${image.alt} ${image.title} ${image.src}`),
    );
  const strip = document.getElementById('cesium-credits');
  const card = document.querySelector('.navara-attr-card');
  const container = card ?? strip;
  if (!container) return { found: false };
  const containerRect = container.getBoundingClientRect();
  // The smallest element that names Google.
  const candidates = [...container.querySelectorAll('*')].filter(
    (element) =>
      googleIn(element) && ![...element.children].some((c) => googleIn(c)),
  );
  const line = candidates.find((element) => {
    const rect = element.getBoundingClientRect();
    if (!shown(element) || !inViewport(rect)) return false;
    // Inside the scrolled part of its list, when there is one.
    const list = element.closest('.navara-attr-list');
    if (!list) return true;
    const listRect = list.getBoundingClientRect();
    return rect.bottom > listRect.top && rect.top < listRect.bottom;
  });
  return {
    found: true,
    which: card ? 'navara-attr-card' : 'cesium-credits',
    // The strip can be a zero-size box around fixed children; its own
    // display, visibility and opacity count, the Google line's box below.
    containerShown: shown(container),
    containerSize: [
      Math.round(containerRect.width),
      Math.round(containerRect.height),
    ],
    googleLines: candidates.length,
    googleLineVisible: Boolean(line),
    text: line
      ? (line.textContent || line.querySelector('img')?.alt || 'logo')
          .replace(/\s+/g, ' ')
          .trim()
          .slice(0, 80)
      : '',
  };
}

function readHud() {
  const text = (id) => document.getElementById(id)?.textContent?.trim() ?? '';
  return {
    latlon: text('hud-latlon'),
    alt: text('hud-alt'),
    mgrs: text('hud-mgrs'),
  };
}

// --- Runner -----------------------------------------------------------------

function distanceKm(a, b) {
  const rad = Math.PI / 180;
  const dLat = (b.lat - a.lat) * rad;
  const dLon = (b.lon - a.lon) * rad;
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(a.lat * rad) * Math.cos(b.lat * rad) * Math.sin(dLon / 2) ** 2;
  return 2 * 6371 * Math.asin(Math.sqrt(h));
}

/** Parses the HUD's `DD°MM'SS.SS"N DDD°MM'SS.SS"E` into degrees. */
function parseHudLatLon(text) {
  const match =
    /(\d+)°(\d+)'([\d.]+)"([NS])\s+(\d+)°(\d+)'([\d.]+)"([EW])/.exec(
      text ?? '',
    );
  if (!match) return null;
  const dms = (d, m, s, hemisphere, negative) =>
    (Number(d) + Number(m) / 60 + Number(s) / 3600) *
    (hemisphere === negative ? -1 : 1);
  return {
    lat: dms(match[1], match[2], match[3], match[4], 'S'),
    lon: dms(match[5], match[6], match[7], match[8], 'W'),
  };
}

/** Smallest difference of two angles in degrees. */
const angleDelta = (a, b) => {
  const d = ((((a - b) % 360) + 540) % 360) - 180;
  return Math.abs(d);
};

/** A results list and its recorder, which prints each check as it lands. */
function createRecorder(label) {
  const results = [];
  // A failing check with a known gap is reported as GAP and does not fail
  // the run; a passing one is reported as ok.
  const record = (name, ok, detail = {}, knownGap = undefined) => {
    const gap = !ok && knownGap ? knownGap : null;
    results.push({ name, ok: Boolean(ok) || Boolean(gap), gap, detail });
    const mark = ok ? 'ok  ' : gap ? 'GAP ' : 'FAIL';
    console.log(
      `${mark} [${label}] ${name} ${redact(JSON.stringify(detail))}${gap ? ` (known gap: ${gap})` : ''}`,
    );
  };
  return { results, record };
}

/**
 * A fresh browser context and page that collects console errors (less
 * KNOWN_NOISE) and the Navara requests, with the first-run welcome off.
 */
async function openPage(browser) {
  const context = await browser.createBrowserContext();
  const page = await context.newPage();
  await page.setViewport({ width: 1280, height: 800 });
  const errors = [];
  const ignored = [];
  const failedUrls = [];
  page.on('response', (response) => {
    if (response.status() >= 400) failedUrls.push(response.url());
  });
  // Navara's code, workers and wasm (dev: /src/globe/navara/, @navaramap;
  // build: the navaraMode and navara_wasm assets).
  const navaraRequests = new Set();
  page.on('request', (request) => {
    const { pathname } = new URL(request.url());
    if (/navara/i.test(pathname)) navaraRequests.add(pathname);
  });
  page.on('console', (message) => {
    if (message.type() !== 'error') return;
    const entry = {
      text: message.text(),
      url: message.location()?.url ?? failedUrls.at(-1),
    };
    const noise = KNOWN_NOISE.find(
      ({ pattern, when }) => pattern.test(entry.text) && (!when || when(entry)),
    );
    if (noise) ignored.push(noise.reason);
    else errors.push(redact(`${entry.text} (${entry.url ?? ''})`));
  });
  page.on('pageerror', (error) =>
    errors.push(redact(error.stack || error.message)),
  );
  // No first-run welcome over the controls.
  await page.evaluateOnNewDocument(() => {
    try {
      localStorage.setItem('gev:first-run-mission:v1', 'suppressed');
    } catch {
      /* storage blocked */
    }
  });
  return { context, page, errors, ignored, navaraRequests };
}

const engineQuery = (engine) =>
  engine === 'cesium' ? '' : `?engine=${engine}`;

/**
 * Waits until the engine reports its tiles loaded for 1.5 s in a row (an
 * engine can be idle for a moment between tile requests while it still
 * refines), polling for up to 90 s.
 */
async function waitForTiles(page) {
  const tilesStarted = Date.now();
  let loadedSince = null;
  while (Date.now() - tilesStarted < 90000) {
    const loaded = await page.evaluate(() =>
      window.__godsEyeView.engine.surface.tilesLoaded(),
    );
    if (!loaded) loadedSince = null;
    else if (loadedSince == null) loadedSince = Date.now();
    else if (Date.now() - loadedSince >= 1500)
      return { loaded: true, ms: loadedSince - tilesStarted };
    await sleep(250);
  }
  return { loaded: false, ms: Date.now() - tilesStarted };
}

async function runEngine(browser, baseUrl, engine) {
  const { results, record } = createRecorder(engine);
  const { context, page, errors, ignored, navaraRequests } =
    await openPage(browser);

  const query = engineQuery(engine);
  const started = Date.now();
  await page.goto(`${baseUrl}${query}`, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => Boolean(window.__godsEyeView?.engine), {
    timeout: BOOT_TIMEOUT_MS,
  });
  const bootMs = Date.now() - started;
  const boot = await page.evaluate(() => ({
    kind: window.__godsEyeView.engine.kind,
    viewerIsNull: window.__godsEyeView.viewer === null,
    stack: window.__godsEyeView.mapStackController?.getActiveId?.(),
    notice: document.getElementById('global-loading-status')?.innerText ?? '',
  }));
  record('boots on the chosen engine', boot.kind === engine, {
    kind: boot.kind,
    bootMs,
  });
  record(
    engine === 'navara' ? 'no viewer' : 'has a viewer',
    engine === 'navara' ? boot.viewerIsNull : !boot.viewerIsNull,
    { viewerIsNull: boot.viewerIsNull },
  );
  if (engine === 'navara')
    record(
      'shows the Navara notice',
      /navara/i.test(boot.notice) && /unavailable/i.test(boot.notice),
      { notice: boot.notice.replace(/\s+/g, ' ').trim() },
    );
  const bootRest = await page.evaluate(waitForRest, 1500, 90000);
  record('boot flight comes to rest', bootRest);
  // Judge the picture once the engine reports its tiles loaded (a cold dev
  // server and cache can take a while).
  const tiles = await waitForTiles(page);
  const tilesLoaded = tiles.loaded;
  const tilesLoadedMs = tiles.ms;
  record('tiles load', tilesLoaded, { tilesLoadedMs });
  console.log(
    `[${engine}] tiles loaded in ${tilesLoadedMs} ms after boot rest`,
  );
  await sleep(1000);
  const picture = await page.evaluate(canvasStats);
  record(
    `map is drawn (${boot.stack})`,
    picture.stddev > 8 && picture.colours > 40,
    { ...picture, tilesLoadedMs },
  );
  if (outDir)
    await page.screenshot({
      path: path.join(outDir, `qa-engine-shell-${engine}.png`),
    });

  // The rendered surface's height at the startup pose (compared across
  // engines in runCrossEngine).
  const surfaceHeights = await page.evaluate((points) => {
    const { engine } = window.__godsEyeView;
    const radians = Math.PI / 180;
    return points.map(([lat, lon]) => {
      // A src/geo cartographic (radians), built here so a build works too.
      const height = engine.surface.sampleHeight({
        longitude: lon * radians,
        latitude: lat * radians,
        height: 0,
      });
      return Number.isFinite(height) ? Math.round(height * 100) / 100 : null;
    });
  }, SURFACE_POINTS);
  record(
    'surface.sampleHeight is finite at the startup pose, under the camera too',
    surfaceHeights.every(Number.isFinite),
    { heights: surfaceHeights },
  );

  // Idle: once the tiles have loaded and the camera rests, nothing renders.
  const bootIdle = await page.evaluate(countFrames, IDLE_MS);
  record(`idle renders no frames for ${IDLE_MS} ms`, bootIdle.frames === 0, {
    frames: bootIdle.frames,
    framesPerSecond: Math.round((bootIdle.frames / IDLE_MS) * 1000 * 10) / 10,
    continuous: bootIdle.continuous,
  });

  // Attributions: the Google line is on screen.
  const attribution = await page.evaluate(readAttribution);
  record(
    'attribution shows the Google line',
    attribution.found &&
      attribution.containerShown &&
      attribution.googleLineVisible &&
      attribution.which ===
        (engine === 'navara' ? 'navara-attr-card' : 'cesium-credits'),
    attribution,
  );

  // HUD at boot.
  const hudBoot = await page.evaluate(readHud);

  // The location tray holds the search box and the city pills.
  const openLocationTray = async () => {
    const expanded = await page.$eval('#location-bar-toggle', (button) =>
      button.getAttribute('aria-expanded'),
    );
    if (expanded !== 'true') await page.click('#location-bar-toggle');
    await sleep(400);
  };

  // Search a city and fly.
  await openLocationTray();
  await page.click('#search-toggle');
  await page.waitForSelector('#location-search.expanded', { timeout: 5000 });
  await page.type('#location-search', SEARCH.query);
  await page.keyboard.press('Enter');
  await sleep(1500);
  await page.evaluate(waitForRest, 2000, 60000);
  const searched = await page.evaluate(readPose);
  const searchKm = distanceKm(searched, SEARCH);
  record(
    `search "${SEARCH.query}" flies there`,
    searchKm < SEARCH.withinKm && searched.height < 2e6,
    {
      km: Math.round(searchKm * 10) / 10,
      height: Math.round(searched.height),
    },
  );
  // Labels can lag a frame behind the pose; give the HUD a moment.
  await sleep(1000);
  const hudSearched = await page.evaluate(readHud);
  record(
    'HUD readouts follow the camera',
    hudSearched.latlon &&
      hudSearched.latlon !== hudBoot.latlon &&
      hudSearched.alt !== hudBoot.alt,
    { boot: hudBoot, searched: hudSearched },
  );

  // Share link: the hash written for this pose restores it on reload.
  await sleep(1200);
  const hash = await page.evaluate(() => location.hash);
  const params = new URLSearchParams(hash.slice(1));
  const shared = {
    lat: Number(params.get('lat')),
    lon: Number(params.get('lon')),
    alt: Number(params.get('alt')),
    heading: Number(params.get('heading')),
    pitch: Number(params.get('pitch')),
    roll: Number(params.get('roll')),
  };
  record(
    'share hash describes the pose',
    Math.abs(shared.lat - searched.lat) < 1e-4 &&
      Math.abs(shared.lon - searched.lon) < 1e-4 &&
      Math.abs(shared.alt - searched.height) <= 0.5,
    { shared },
  );
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => Boolean(window.__godsEyeView?.engine), {
    timeout: BOOT_TIMEOUT_MS,
  });
  await page.evaluate(waitForRest, 1500, 60000);
  const restored = await page.evaluate(readPose);
  // The hash and the pose it restored, for the cross-engine check.
  const share = { hash, restored };
  const shareDelta = {
    lat: Math.abs(restored.lat - shared.lat),
    lon: Math.abs(restored.lon - shared.lon),
    alt: Math.abs(restored.height - shared.alt),
    heading: angleDelta(restored.heading, shared.heading),
    pitch: Math.abs(restored.pitch - shared.pitch),
  };
  const shareWorst = Math.max(...Object.values(shareDelta));
  const restoredHash = await page.evaluate(() => location.hash);
  const cameraKeys = ['lat', 'lon', 'alt', 'heading', 'pitch', 'roll'];
  const sameCamera = cameraKeys.every(
    (key) =>
      new URLSearchParams(restoredHash.slice(1)).get(key) === params.get(key),
  );
  record(
    engine === 'cesium'
      ? `share link reload restores the pose (<= ${SHARE_TOLERANCE})`
      : 'share link reload restores the pose (deltas recorded)',
    engine === 'cesium'
      ? shareWorst <= SHARE_TOLERANCE && sameCamera
      : shareDelta.lat < 1e-3 && shareDelta.lon < 1e-3 && shareDelta.alt < 5,
    { delta: shareDelta, hashRoundTrip: sameCamera },
  );

  // Navigation buttons and wheel zoom.
  await page.click('#north-up-view');
  await sleep(500);
  await page.evaluate(waitForRest, 1200, 30000);
  const north = await page.evaluate(readPose);
  record('north up faces north', angleDelta(north.heading, 0) < 0.5, {
    heading: north.heading,
  });
  const tiltBefore = await page.evaluate(() => ({
    pressed: document
      .getElementById('tilt-map-view')
      ?.getAttribute('aria-pressed'),
  }));
  await page.click('#tilt-map-view');
  await sleep(500);
  await page.evaluate(waitForRest, 1200, 30000);
  const tilted = await page.evaluate(readPose);
  const tiltAfter = await page.evaluate(() => ({
    pressed: document
      .getElementById('tilt-map-view')
      ?.getAttribute('aria-pressed'),
  }));
  record(
    'tilt changes the pitch',
    Math.abs(tilted.pitch - north.pitch) > 5 &&
      tiltBefore.pressed !== tiltAfter.pressed,
    {
      pitchBefore: north.pitch,
      pitchAfter: tilted.pitch,
      pressed: [tiltBefore.pressed, tiltAfter.pressed],
    },
  );
  const wheel = async (ticks, deltaY) => {
    await page.mouse.move(640, 400);
    for (let step = 0; step < ticks; step++) {
      await page.mouse.wheel({ deltaY });
      await sleep(120);
    }
    await sleep(500);
    await page.evaluate(waitForRest, 1200, 30000);
    return page.evaluate(readPose);
  };
  const zoomed = await wheel(3, -100);
  record('wheel zooms in', zoomed.height < tilted.height * 0.95, {
    before: Math.round(tilted.height),
    after: Math.round(zoomed.height),
  });
  // Keep zooming: the camera must stop above the ground. Paris lies about
  // 80 m above the ellipsoid; the clearance is to the sampled surface, and
  // the smallest clearance of any frame rendered during the wheel counts.
  await page.evaluate(startClearanceWatch);
  const floor = await wheel(10, -400);
  await sleep(500);
  const floorState = await page.evaluate(stopClearanceWatch);
  record(
    `wheel zoom stops above the ground (clearance >= ${MIN_CLEARANCE[engine]} m)`,
    floorState.clearance != null &&
      floorState.minClearance != null &&
      floorState.clearance >= MIN_CLEARANCE[engine] &&
      floorState.minClearance >= MIN_CLEARANCE[engine],
    {
      height: Math.round(floorState.height),
      ground: floorState.ground == null ? null : Math.round(floorState.ground),
      clearance:
        floorState.clearance == null ? null : Math.round(floorState.clearance),
      minClearance:
        floorState.minClearance == null
          ? null
          : Math.round(floorState.minClearance * 10) / 10,
      lowest: floorState.lowest,
      framesSampled: floorState.sampled,
      framesWithoutGround: floorState.unsampled,
      afterWheel: Math.round(floor.height),
    },
  );

  // Search Tokyo: the HUD (its text, not the engine) reads Tokyo.
  await openLocationTray();
  if (!(await page.$('#location-search.expanded')))
    await page.click('#search-toggle');
  await page.waitForSelector('#location-search.expanded', { timeout: 5000 });
  await page.click('#location-search', { clickCount: 3 });
  await page.type('#location-search', TOKYO.query);
  await page.keyboard.press('Enter');
  await sleep(1500);
  await page.evaluate(waitForRest, 2000, 60000);
  await sleep(1000);
  const hudTokyo = await page.evaluate(readHud);
  const hudTokyoPoint = parseHudLatLon(hudTokyo.latlon);
  const hudTokyoKm = hudTokyoPoint ? distanceKm(hudTokyoPoint, TOKYO) : null;
  record(
    `search "${TOKYO.query}": the HUD reads Tokyo (< ${TOKYO.withinKm} km)`,
    hudTokyoKm != null && hudTokyoKm < TOKYO.withinKm,
    {
      hud: hudTokyo.latlon,
      alt: hudTokyo.alt,
      km: hudTokyoKm == null ? null : Math.round(hudTokyoKm * 10) / 10,
    },
  );

  // Orbit: fly to a POI, start, count frames, stop, count again.
  await openLocationTray();
  await page.click('[data-location-id="tokyo"]');
  await sleep(500);
  await page.waitForSelector('[data-poi-index="0"]', { timeout: 10000 });
  await page.evaluate(waitForRest, 1500, 60000);
  await openLocationTray();
  await page.click('[data-poi-index="0"]');
  await sleep(500);
  await page.evaluate(waitForRest, 1500, 60000);
  await page.keyboard.press('o');
  await sleep(500);
  const orbiting = await page.evaluate(countFrames, 1500);
  const orbitActive = await page.evaluate(
    () => window.__godsEyeView.styleManager.orbitController?.active === true,
  );
  await page.keyboard.press('o');
  await sleep(1500);
  // After orbit the camera holds still and rendering leaves continuous mode;
  // frames may still come while tiles stream in (recorded).
  const idle = await page.evaluate(countFrames, 1500);
  idle.framesPerSecond = Math.round((idle.frames / 1500) * 1000 * 10) / 10;
  record(
    'orbit animates and stops',
    orbitActive &&
      orbiting.frames >= 20 &&
      orbiting.headingMoved &&
      orbiting.continuous &&
      !idle.headingMoved &&
      !idle.continuous,
    { orbitActive, orbiting, idle },
  );

  // Reset to the whole globe.
  await page.click('#reset-globe-view');
  await sleep(500);
  await page.evaluate(waitForRest, 1500, 60000);
  const globe = await page.evaluate(readPose);
  record('reset flies out to the globe', globe.height > 1e7, {
    height: Math.round(globe.height),
  });

  // Map stacks: base imagery, then Google 3D again.
  for (const stack of ['esri-imagery', 'photoreal']) {
    const result = await page.evaluate(async (id) => {
      const { styleManager, mapStackController } = window.__godsEyeView;
      const outcome = await styleManager.setMapStack(id);
      return {
        ok: outcome?.ok !== false,
        active: mapStackController.getActiveId(),
        photoreal: window.__godsEyeView.engine.maps.photorealActive(),
      };
    }, stack);
    await sleep(3000);
    const stackPicture = await page.evaluate(canvasStats);
    record(
      `map stack ${stack}`,
      result.ok &&
        result.active === stack &&
        result.photoreal === (stack === 'photoreal') &&
        stackPicture.stddev > 8,
      { ...result, stddev: stackPicture.stddev },
    );
  }

  record(
    engine === 'cesium' ? 'loads no Navara code' : 'loads the Navara code',
    engine === 'cesium' ? navaraRequests.size === 0 : navaraRequests.size > 0,
    { navaraRequests: navaraRequests.size },
  );
  const viewerAccess =
    engine === 'navara'
      ? await page.evaluate(() => window.__godsEyeView.viewer === null)
      : true;
  if (engine === 'navara') record('the viewer stays null', viewerAccess, {});
  record('no console errors', errors.length === 0, {
    errors: errors.slice(0, 10),
    ignored: [...new Set(ignored)],
  });
  await context.close();
  return { results, share, surfaceHeights };
}

/** Position distance in metres and the worst angle difference in degrees. */
function poseDelta(a, b) {
  return {
    metres: Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z),
    degrees: Math.max(
      angleDelta(a.heading, b.heading),
      Math.abs(a.pitch - b.pitch),
      angleDelta(a.roll, b.roll),
    ),
  };
}

const roundDelta = ({ metres, degrees }) => ({
  metres: Math.round(metres * 1000) / 1000,
  degrees: Math.round(degrees * 1e5) / 1e5,
});

/** Opens `hash` on `engine`, lets the camera settle and returns the pose. */
async function openHash(
  browser,
  baseUrl,
  engine,
  hash,
  { tiles = false } = {},
) {
  const opened = await openPage(browser);
  const { page } = opened;
  await page.goto(`${baseUrl}${engineQuery(engine)}${hash}`, {
    waitUntil: 'domcontentloaded',
  });
  await page.waitForFunction(() => Boolean(window.__godsEyeView?.engine), {
    timeout: BOOT_TIMEOUT_MS,
  });
  await page.evaluate(waitForRest, 1500, 60000);
  const tileWait = tiles ? await waitForTiles(page) : null;
  if (tiles) await sleep(1000);
  const pose = await page.evaluate(readPose);
  return { ...opened, pose, tileWait };
}

/**
 * Share links across engines: the hash written on one engine, opened on the
 * other, gives the pose it gave on its own engine (within 1 m and 0.1°).
 * Then both engines at one fixed pose, photographed side by side.
 */
async function runCrossEngine(browser, baseUrl, shares, heights = {}) {
  const { results, record } = createRecorder('cross');
  if (heights.cesium && heights.navara) {
    const deltas = SURFACE_POINTS.map((_, index) =>
      Number.isFinite(heights.cesium[index]) &&
      Number.isFinite(heights.navara[index])
        ? Math.round(
            Math.abs(heights.cesium[index] - heights.navara[index]) * 100,
          ) / 100
        : null,
    );
    record(
      `surface.sampleHeight at the Austin startup pose agrees across engines (<= ${SURFACE_TOLERANCE_M} m)`,
      deltas.every(
        (delta) => Number.isFinite(delta) && delta <= SURFACE_TOLERANCE_M,
      ),
      { deltas, cesium: heights.cesium, navara: heights.navara },
    );
  }
  for (const [from, to] of [
    ['cesium', 'navara'],
    ['navara', 'cesium'],
  ]) {
    const source = shares[from];
    if (!source) continue;
    const opened = await openHash(browser, baseUrl, to, source.hash);
    const delta = poseDelta(opened.pose, source.restored);
    record(
      `share link written on ${from} opens on ${to} at the same pose (<= ${CROSS_TOLERANCE.metres} m, ${CROSS_TOLERANCE.degrees}°)`,
      delta.metres <= CROSS_TOLERANCE.metres &&
        delta.degrees <= CROSS_TOLERANCE.degrees &&
        opened.errors.length === 0,
      {
        ...roundDelta(delta),
        height: Math.round(opened.pose.height),
        errors: opened.errors.slice(0, 5),
      },
    );
    await opened.context.close();
  }

  // Side by side at one pose.
  const shots = {};
  for (const engine of ['cesium', 'navara']) {
    const opened = await openHash(
      browser,
      baseUrl,
      engine,
      `#${SIDE_BY_SIDE_HASH}`,
      { tiles: true },
    );
    shots[engine] = {
      pose: opened.pose,
      tileWait: opened.tileWait,
      png: await opened.page.screenshot({ type: 'png' }),
      errors: opened.errors,
    };
    await opened.context.close();
  }
  const sameDelta = poseDelta(shots.cesium.pose, shots.navara.pose);
  record(
    'the side-by-side pose is the same on both engines',
    sameDelta.metres <= CROSS_TOLERANCE.metres &&
      sameDelta.degrees <= CROSS_TOLERANCE.degrees &&
      shots.cesium.tileWait.loaded &&
      shots.navara.tileWait.loaded &&
      shots.cesium.errors.length === 0 &&
      shots.navara.errors.length === 0,
    {
      ...roundDelta(sameDelta),
      tilesLoadedMs: {
        cesium: shots.cesium.tileWait.ms,
        navara: shots.navara.tileWait.ms,
      },
      errors: [...shots.cesium.errors, ...shots.navara.errors].slice(0, 5),
    },
  );
  if (outDir) await composeSideBySide(browser, shots);
  return results;
}

/**
 * Both screenshots in one picture, labelled, rendered by the browser. Writes
 * qa-engine-side-by-side.png and .jpg to --out.
 */
async function composeSideBySide(browser, shots) {
  const context = await browser.createBrowserContext();
  const page = await context.newPage();
  const width = 800;
  const height = 500;
  await page.setViewport({ width: width * 2, height: height + 28 });
  const image = (engine) =>
    `data:image/png;base64,${Buffer.from(shots[engine].png).toString('base64')}`;
  const pose = shots.cesium.pose;
  const caption = `lat ${pose.lat.toFixed(4)} lon ${pose.lon.toFixed(4)} alt ${Math.round(pose.height)} m heading ${Math.round(pose.heading)} pitch ${Math.round(pose.pitch)}`;
  await page.setContent(`<!doctype html><html><body style="margin:0;background:#111;color:#eee;font:13px system-ui">
    <div style="display:flex">${['cesium', 'navara']
      .map(
        (
          engine,
        ) => `<figure style="margin:0;position:relative;width:${width}px">
        <img src="${image(engine)}" style="display:block;width:${width}px;height:${height}px">
        <figcaption style="position:absolute;top:8px;left:8px;background:rgba(0,0,0,.65);padding:3px 8px;border-radius:4px">${engine === 'cesium' ? 'Cesium (default)' : 'Navara (?engine=navara)'}</figcaption>
      </figure>`,
      )
      .join('')}</div>
    <div style="height:28px;line-height:28px;padding:0 8px">${caption}</div>
  </body></html>`);
  await page.evaluate(() =>
    Promise.all([...document.images].map((img) => img.decode())),
  );
  await page.screenshot({
    path: path.join(outDir, 'qa-engine-side-by-side.png'),
    type: 'png',
  });
  await page.screenshot({
    path: path.join(outDir, 'qa-engine-side-by-side.jpg'),
    type: 'jpeg',
    quality: 82,
  });
  await context.close();
}

const executablePath =
  process.env.PUPPETEER_EXECUTABLE_PATH ||
  (await puppeteer.executablePath().catch(() => null));
if (!executablePath || !fs.existsSync(executablePath))
  throw new Error('Puppeteer Chrome for Testing is unavailable');
if (outDir) fs.mkdirSync(outDir, { recursive: true });

const server = argument('base-url')
  ? { url: argument('base-url'), stop: () => {} }
  : await startServer();
const baseUrl = server.url.endsWith('/') ? server.url : `${server.url}/`;
const browser = await puppeteer.launch({
  headless: true,
  executablePath,
  args: ['--use-angle=metal', '--window-size=1280,800'],
});
let failed = 0;
const shares = {};
const heights = {};
try {
  for (const engine of ENGINES) {
    try {
      const { results, share, surfaceHeights } = await runEngine(
        browser,
        baseUrl,
        engine,
      );
      shares[engine] = share;
      heights[engine] = surfaceHeights;
      const bad = results.filter(({ ok }) => !ok);
      const gaps = results.filter(({ gap }) => gap);
      failed += bad.length;
      console.log(
        `[${engine}] ${results.length - bad.length - gaps.length}/${results.length} passed` +
          (gaps.length ? `, ${gaps.length} known gap(s)` : ''),
      );
    } catch (error) {
      failed += 1;
      console.log(`FAIL [${engine}] ${redact(error.stack || error.message)}`);
    }
  }
  if (shares.cesium && shares.navara) {
    try {
      const results = await runCrossEngine(browser, baseUrl, shares, heights);
      const bad = results.filter(({ ok }) => !ok);
      failed += bad.length;
      console.log(
        `[cross] ${results.length - bad.length}/${results.length} passed`,
      );
    } catch (error) {
      failed += 1;
      console.log(`FAIL [cross] ${redact(error.stack || error.message)}`);
    }
  }
} finally {
  await browser.close();
  server.stop();
}
process.exit(failed ? 1 : 0);
