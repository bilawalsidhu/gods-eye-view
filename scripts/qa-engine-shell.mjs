#!/usr/bin/env node
/**
 * The application shell on each globe engine, in headless Chrome: boots the
 * app with ?engine=cesium (the default) and ?engine=navara and checks, per
 * engine:
 *
 * - the engine kind, and a viewer for Cesium only (window.__godsEyeView);
 * - no console errors (KNOWN_NOISE lists the only ones tolerated);
 * - the map is drawn (the engine canvas is not blank);
 * - search: a city typed into the location search flies near it;
 * - navigation: north up, tilt, wheel zoom and reset to the globe;
 * - orbit: frames keep coming while it runs and stop when it stops;
 * - the HUD readouts follow the camera;
 * - share links: the hash written for a pose restores that pose on reload
 *   (Cesium within 1e-6; Navara's deltas are recorded);
 * - map stacks: base imagery and back to Google 3D.
 *
 *   node scripts/qa-engine-shell.mjs [--engine=cesium|navara|both]
 *     [--base-url=URL] [--out=DIR]
 *
 * Starts this checkout's Vite dev server on a free port (never 4185) unless
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
const RESERVED_PORTS = new Set([4185]);
const SEARCH = { query: 'Paris', lat: 48.8566, lon: 2.3522, withinKm: 60 };
const SHARE_TOLERANCE = 1e-6;

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
const KNOWN_GAPS = {
  navaraZoomFloor:
    'Navara 0.2.1 wheel zoom has no ground collision (its minimumZoomDistance is from the Earth centre); engine follow-up',
};

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

/** Smallest difference of two angles in degrees. */
const angleDelta = (a, b) => {
  const d = ((((a - b) % 360) + 540) % 360) - 180;
  return Math.abs(d);
};

async function runEngine(browser, baseUrl, engine) {
  const results = [];
  // A failing check with a known gap is reported as GAP and does not fail
  // the run; a passing one is reported as ok.
  const record = (name, ok, detail = {}, knownGap = undefined) => {
    const gap = !ok && knownGap ? knownGap : null;
    results.push({ name, ok: Boolean(ok) || Boolean(gap), gap, detail });
    const label = ok ? 'ok  ' : gap ? 'GAP ' : 'FAIL';
    console.log(
      `${label} [${engine}] ${name} ${redact(JSON.stringify(detail))}${gap ? ` (known gap: ${gap})` : ''}`,
    );
  };
  const context = await browser.createBrowserContext();
  const page = await context.newPage();
  await page.setViewport({ width: 1280, height: 800 });
  const errors = [];
  const ignored = [];
  const failedUrls = [];
  page.on('response', (response) => {
    if (response.status() >= 400) failedUrls.push(response.url());
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

  const query = engine === 'cesium' ? '' : `?engine=${engine}`;
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
  // Let tiles stream in before judging the picture.
  await sleep(4000);
  const startPose = await page.evaluate(readPose);
  const picture = await page.evaluate(canvasStats);
  record(
    `map is drawn (${boot.stack})`,
    picture.stddev > 8 && picture.colours > 40,
    picture,
  );
  if (outDir)
    await page.screenshot({
      path: path.join(outDir, `qa-engine-shell-${engine}.png`),
    });

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
  // Keep zooming: the camera must stop above the ground (ellipsoid height
  // above zero here; Paris lies about 80 m above the ellipsoid).
  const floor = await wheel(10, -400);
  record(
    'wheel zoom stops above the ground',
    floor.height > 0,
    { height: Math.round(floor.height) },
    engine === 'navara' ? KNOWN_GAPS.navaraZoomFloor : undefined,
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
  return results;
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
try {
  for (const engine of ENGINES) {
    try {
      const results = await runEngine(browser, baseUrl, engine);
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
} finally {
  await browser.close();
  server.stop();
}
process.exit(failed ? 1 : 0);
