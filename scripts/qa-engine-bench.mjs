#!/usr/bin/env node
/**
 * Startup and flight timings of the application shell on each globe engine,
 * in headless Chrome without a frame-rate limit:
 *
 * - initial view: navigation start to the startup pose with its tiles loaded
 *   (the camera still and engine.surface.tilesLoaded() true, both for 1.5 s
 *   in a row; the time is when the later of the two began);
 * - flight: frame times (postRender to postRender) over a scripted simple
 *   flight, Austin to Paris at 20 km, 10 s, cubicInOut, started once the
 *   Austin tiles have loaded; p50, p95, max and frames per second.
 *
 *   node scripts/qa-engine-bench.mjs [--engine=cesium|navara|both]
 *     [--server=dev|preview] [--base-url=URL] [--runs=3] [--out=FILE.json]
 *     [--navara-look=cinematic|photoreal|minimal] [--navara-sharpen=off|0..100]
 *
 * --server=dev (the default) starts this checkout's Vite dev server and
 * --server=preview a `vite preview` of dist/ (run `npm run build` first),
 * each on a free port (never 4185–4188), unless --base-url names a running server.
 * Each engine gets one discarded warm-up run (the dev server transforms
 * modules on first request), then --runs measured runs, each in a fresh
 * browser context. --navara-look picks Navara's look (`?look=`; the app's
 * default, cinematic, when omitted). --navara-sharpen sets Navara's Sharpen
 * control before the flight, through the shell's setSharpen as the slider
 * does: `off`, or on at a slider value (the app's default, on at 80 %, when
 * omitted). Reports every run and the medians. Headless numbers are
 * indicative: no display, no vsync, a software-composited headless window.
 * Provider keys are never printed. Exits 1 when a run fails.
 *
 * --scenario=movers (phase 3 Task 2) measures engine.movers instead of the
 * flight: --count (10000) synthetic aircraft (src/bench/syntheticFlights.js,
 * the same fleet on both engines) as one sprite set, every instance moved
 * and committed every frame, at each --scene (global,city,orbit) with the
 * app's layers off; frame times over 10 s after a 3 s warm-up while the
 * engine renders continuously; then, still running, the post-GC JS heap
 * every 10 s for --heap-seconds (60) and its slope in MB per minute. Cesium draws with the app's
 * default style (no post stages on) and without its 60 fps cap for the
 * measurement; Navara with --navara-look (pass minimal for the gate).
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
const serverKind = argument('server') ?? 'dev';
if (!['dev', 'preview'].includes(serverKind)) {
  console.error(`Unknown server "${serverKind}"; known: dev, preview`);
  process.exit(2);
}
const RUNS = Math.max(1, Number(argument('runs') ?? 3));
const outFile = argument('out');
const scenario = argument('scenario') ?? 'flight';
if (!['flight', 'movers'].includes(scenario)) {
  console.error(`Unknown scenario "${scenario}"; known: flight, movers`);
  process.exit(2);
}
const MOVER_COUNT = Number(argument('count') ?? 10000);
const MOVER_SCENES = (argument('scene') ?? 'global,city,orbit').split(',');
// Post-GC heap sampling per movers scene (0 skips it).
const HEAP_SECONDS = Number(argument('heap-seconds') ?? 60);
// Camera poses (degrees, metres) of the movers scenario.
const SCENES = {
  global: { lat: 20, lon: -40, height: 20_000_000, pitch: -90, near: null },
  city: {
    lat: 40.64,
    lon: -73.78,
    height: 3_000,
    pitch: -30,
    near: { lat: 40.7, lng: -73.8, radiusM: 30_000, count: 2_000 },
  },
  orbit: { lat: 35, lon: -95, height: 3_000_000, pitch: -90, near: null },
};
for (const scene of MOVER_SCENES)
  if (!SCENES[scene]) {
    console.error(`Unknown scene "${scene}"; known: ${Object.keys(SCENES)}`);
    process.exit(2);
  }
const navaraLook = argument('navara-look');
if (navaraLook && !['cinematic', 'photoreal', 'minimal'].includes(navaraLook)) {
  console.error(
    `Unknown Navara look "${navaraLook}"; known: cinematic, photoreal, minimal`,
  );
  process.exit(2);
}
const navaraSharpenArg = argument('navara-sharpen');
const navaraSharpen =
  navaraSharpenArg === undefined
    ? null
    : navaraSharpenArg === 'off'
      ? { enabled: false }
      : { enabled: true, intensityPct: Number(navaraSharpenArg) };
if (
  navaraSharpen?.intensityPct !== undefined &&
  !(navaraSharpen.intensityPct >= 0 && navaraSharpen.intensityPct <= 100)
) {
  console.error(
    `Unknown Navara sharpen "${navaraSharpenArg}"; known: off, 0..100`,
  );
  process.exit(2);
}
const RESERVED_PORTS = new Set([4185, 4186, 4187, 4188]);
const BOOT_TIMEOUT_MS = 180000;
const FLIGHT = {
  from: { lat: 30.2672, lon: -97.7431, height: 20000 },
  to: { lat: 48.8566, lon: 2.3522, height: 20000 },
  seconds: 10,
  easing: 'cubicInOut',
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

async function startServer(kind) {
  if (kind === 'preview' && !fs.existsSync(path.join(repoRoot, 'dist')))
    throw new Error('dist/ is missing: run `npm run build` first');
  const port = await freePort();
  const child = spawn(
    process.execPath,
    [
      path.join(repoRoot, 'node_modules/vite/bin/vite.js'),
      ...(kind === 'preview' ? ['preview'] : []),
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
  const deadline = Date.now() + 60000;
  while (Date.now() < deadline) {
    if (child.exitCode != null) break;
    try {
      if ((await fetch(url)).ok) return { url, stop: () => child.kill() };
    } catch {
      /* not listening yet */
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  child.kill();
  throw new Error(`${kind} server did not answer ${url}\n${redact(stderr)}`);
}

// --- In-page probes ---------------------------------------------------------

/**
 * Installed before the app loads: once window.__godsEyeView.engine exists,
 * polls every 100 ms and sets window.__qaInitialView when the camera has been
 * still and the tiles loaded for 1.5 s.
 */
function installInitialViewProbe() {
  const STILL_MS = 1500;
  const probe = { engineAt: null, done: null };
  window.__qaInitialView = probe;
  let last = null;
  let stillSince = null;
  let loadedSince = null;
  const timer = setInterval(() => {
    const engine = window.__godsEyeView?.engine;
    if (!engine) return;
    const now = performance.now();
    if (probe.engineAt == null) probe.engineAt = now;
    const pose = engine.camera.pose();
    const read = [
      pose.position.x,
      pose.position.y,
      pose.position.z,
      pose.direction.x,
      pose.direction.y,
      pose.direction.z,
    ];
    if (
      !last ||
      read.some((value, index) => Math.abs(value - last[index]) > 1e-6)
    ) {
      last = read;
      stillSince = now;
    }
    if (!engine.surface.tilesLoaded()) loadedSince = null;
    else if (loadedSince == null) loadedSince = now;
    if (
      loadedSince != null &&
      now - loadedSince >= STILL_MS &&
      now - stillSince >= STILL_MS
    ) {
      clearInterval(timer);
      probe.done = {
        initialViewMs: Math.max(stillSince, loadedSince),
        stillAt: stillSince,
        tilesLoadedAt: loadedSince,
        height: pose.cartographic.height,
      };
    }
  }, 100);
}

/**
 * Places the camera at the flight start, waits for its tiles, flies and
 * returns the postRender times of the flight.
 */
async function runFlight(flight) {
  // WGS84 degrees and metres to an Earth-fixed position.
  const cartesian = ({ lat, lon, height }) => {
    const a = 6378137;
    const e2 = 0.0066943799901413165;
    const phi = (lat * Math.PI) / 180;
    const lambda = (lon * Math.PI) / 180;
    const n = a / Math.sqrt(1 - e2 * Math.sin(phi) ** 2);
    return {
      x: (n + height) * Math.cos(phi) * Math.cos(lambda),
      y: (n + height) * Math.cos(phi) * Math.sin(lambda),
      z: (n * (1 - e2) + height) * Math.sin(phi),
    };
  };
  const { engine } = window.__godsEyeView;
  const nadir = { heading: 0, pitch: -Math.PI / 2, roll: 0 };
  engine.camera.setView({
    destination: cartesian(flight.from),
    orientation: nadir,
  });
  engine.render.request('bench');
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const waitStart = performance.now();
  let loadedSince = null;
  while (performance.now() - waitStart < 60000) {
    await sleep(100);
    if (!engine.surface.tilesLoaded()) loadedSince = null;
    else if (loadedSince == null) loadedSince = performance.now();
    else if (performance.now() - loadedSince >= 1500) break;
  }
  const startTilesMs = performance.now() - waitStart;
  const times = [];
  const remove = engine.frames.postRender.addEventListener(() => {
    times.push(performance.now());
  });
  // Browser animation frames over the same time, to tell an engine that
  // skips frames from a capped browser.
  let animationFrames = 0;
  let counting = true;
  const tick = () => {
    if (!counting) return;
    animationFrames += 1;
    requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
  const started = performance.now();
  const ended = await new Promise((resolve) => {
    engine.camera.flyTo({
      destination: cartesian(flight.to),
      orientation: nadir,
      duration: flight.seconds,
      easing: flight.easing,
      complete: () => resolve('complete'),
      cancel: () => resolve('cancel'),
    });
    setTimeout(() => resolve('timeout'), flight.seconds * 1000 + 15000);
  });
  const finished = performance.now();
  counting = false;
  remove();
  const pose = engine.camera.pose();
  return {
    ended,
    startTilesMs,
    wallMs: finished - started,
    animationFrames,
    times: times.filter((time) => time >= started && time <= finished),
    landed: {
      lat: (pose.cartographic.latitude * 180) / Math.PI,
      lon: (pose.cartographic.longitude * 180) / Math.PI,
    },
  };
}

/**
 * In the page: the movers scenario at one scene. Layers off, the camera at
 * the scene, tiles loaded; then `count` aircraft as one sprite set, moved and
 * committed on every frame while the engine renders continuously.
 */
async function runMovers({ scene, count, warmMs, measureMs, hold }) {
  const { engine, dataManager, viewer } = window.__godsEyeView;
  const geo = await import('/src/geo/index.js');
  // The app caps Cesium at 60 fps (viewer.targetFrameRate); Navara has no
  // cap. Uncapped for the measurement, so both report their frame cost.
  const targetFrameRate = viewer?.targetFrameRate;
  if (viewer) viewer.targetFrameRate = undefined;
  const { createSyntheticFlights } =
    await import('/src/bench/syntheticFlights.js');
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  for (const [id] of dataManager?.layers ?? [])
    if (dataManager.isEnabled?.(id)) await dataManager.setEnabled(id, false);
  const rad = geo.math.toRadians;
  engine.camera.setView({
    destination: geo.cartesian3.fromDegrees(scene.lon, scene.lat, scene.height),
    orientation: { heading: 0, pitch: rad(scene.pitch), roll: 0 },
  });
  engine.render.request('bench');
  const waitStart = performance.now();
  let loadedSince = null;
  while (performance.now() - waitStart < 60000) {
    await sleep(100);
    if (!engine.surface.tilesLoaded()) loadedSince = null;
    else if (loadedSince == null) loadedSince = performance.now();
    else if (performance.now() - loadedSince >= 1500) break;
  }
  const atlas = document.createElement('canvas');
  atlas.width = 32;
  atlas.height = 32;
  const context = atlas.getContext('2d');
  context.fillStyle = '#ffffff';
  context.beginPath();
  context.moveTo(16, 1);
  context.lineTo(29, 30);
  context.lineTo(16, 23);
  context.lineTo(3, 30);
  context.closePath();
  context.fill();
  const flights = createSyntheticFlights({ count, seed: 1, near: scene.near });
  const set = engine.movers.createSet({
    id: 'bench-movers',
    kind: 'sprite',
    capacity: count,
    sprite: {
      atlas: { canvas: atlas, cells: { plane: [0, 0, 1, 1] } },
      sizePx: 16,
    },
  });
  const position = geo.cartesian3.create();
  const fields = { position, rotation: 0, color: [0.5, 0.86, 1, 1] };
  let last = performance.now();
  const step = () => {
    const now = performance.now();
    flights.advance((now - last) / 1000);
    last = now;
    for (let index = 0; index < count; index++) {
      geo.cartesian3.fromDegrees(
        flights.lon[index],
        flights.lat[index],
        flights.alt[index],
        geo.ellipsoid.WGS84,
        position,
      );
      fields.rotation = rad(-flights.heading[index]);
      set.set(index, fields);
    }
    set.setCount(count);
    set.commit();
  };
  const memory = () => performance.memory?.usedJSHeapSize ?? null;
  step();
  const removeTick = engine.frames.preUpdate.addEventListener(step);
  const times = [];
  const removeFrame = engine.frames.postRender.addEventListener(() =>
    times.push(performance.now()),
  );
  engine.render.setContinuous(true);
  const stop = () => {
    engine.render.setContinuous(false);
    if (viewer) viewer.targetFrameRate = targetFrameRate;
    removeTick();
    removeFrame();
    set.destroy();
  };
  let holding = false;
  try {
    await sleep(warmMs);
    const from = performance.now();
    await sleep(measureMs);
    const to = performance.now();
    // `hold`: the scene keeps running for the heap samples the runner
    // takes over CDP; window.__benchStop() ends it.
    const result = {
      startTilesMs: Math.round(loadedSince ? loadedSince - waitStart : -1),
      wallMs: to - from,
      times: times.filter((time) => time >= from && time <= to),
    };
    if (hold) {
      holding = true;
      // No more frame times: the heap samples must not count them.
      removeFrame();
      times.length = 0;
      window.__benchStop = stop;
    }
    return result;
  } finally {
    if (!holding) stop();
  }
}

/**
 * Post-GC JS heap while the movers scene keeps running: a forced GC (CDP
 * HeapProfiler.collectGarbage) and Runtime.getHeapUsage every 10 s for
 * `seconds`, then the least-squares slope in MB per minute.
 */
async function heapSlope(page, seconds) {
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const cdp = await page.createCDPSession();
  const samples = [];
  const started = Date.now();
  try {
    for (;;) {
      await cdp.send('HeapProfiler.collectGarbage');
      const { usedSize } = await cdp.send('Runtime.getHeapUsage');
      samples.push([(Date.now() - started) / 60000, usedSize / 1e6]);
      if (Date.now() - started >= seconds * 1000) break;
      await sleep(10000);
    }
  } finally {
    await cdp.detach();
  }
  const n = samples.length;
  const mx = samples.reduce((sum, [x]) => sum + x, 0) / n;
  const my = samples.reduce((sum, [, y]) => sum + y, 0) / n;
  const sxx = samples.reduce((sum, [x]) => sum + (x - mx) ** 2, 0);
  const slope =
    sxx > 0
      ? samples.reduce((sum, [x, y]) => sum + (x - mx) * (y - my), 0) / sxx
      : 0;
  return {
    postGcMB: round(samples.at(-1)[1], 1),
    slopeMBPerMin: round(slope, 2),
    samples: n,
  };
}

// --- Runner -----------------------------------------------------------------

const quantile = (sorted, q) =>
  sorted.length
    ? sorted[
        Math.min(
          sorted.length - 1,
          Math.max(0, Math.ceil(q * sorted.length) - 1),
        )
      ]
    : null;
const median = (values) => {
  const sorted = values.filter(Number.isFinite).sort((a, b) => a - b);
  if (!sorted.length) return null;
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2
    ? sorted[middle]
    : (sorted[middle - 1] + sorted[middle]) / 2;
};
const round = (value, digits = 1) =>
  value == null ? null : Math.round(value * 10 ** digits) / 10 ** digits;

async function runOnce(browser, baseUrl, engine) {
  const context = await browser.createBrowserContext();
  const page = await context.newPage();
  await page.setViewport({ width: 1280, height: 800 });
  const errors = [];
  page.on('pageerror', (error) =>
    errors.push(redact(error.message).slice(0, 200)),
  );
  await page.evaluateOnNewDocument(() => {
    try {
      localStorage.setItem('gev:first-run-mission:v1', 'suppressed');
    } catch {
      /* storage blocked */
    }
  });
  await page.evaluateOnNewDocument(installInitialViewProbe);
  try {
    const query =
      engine === 'cesium'
        ? ''
        : `?engine=${engine}${navaraLook ? `&look=${navaraLook}` : ''}`;
    await page.goto(`${baseUrl}${query}`, { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => Boolean(window.__qaInitialView?.done), {
      timeout: BOOT_TIMEOUT_MS,
      polling: 250,
    });
    const initial = await page.evaluate(() => ({
      engineAt: window.__qaInitialView.engineAt,
      ...window.__qaInitialView.done,
      kind: window.__godsEyeView.engine.kind,
    }));
    if (initial.kind !== engine)
      throw new Error(`booted ${initial.kind}, not ${engine}`);
    if (engine === 'navara' && navaraSharpen) {
      const result = await page.evaluate(
        (options) => window.__godsEyeView.styleManager.setSharpen(options),
        navaraSharpen,
      );
      if (!result?.ok)
        throw new Error(`setSharpen failed: ${JSON.stringify(result)}`);
    }
    const sharpen =
      engine === 'navara'
        ? await page.evaluate(() =>
            window.__godsEyeView.engine.render.sharpen(),
          )
        : null;
    if (scenario === 'movers') {
      const scenes = {};
      for (const name of MOVER_SCENES) {
        const measured = await page.evaluate(runMovers, {
          scene: SCENES[name],
          count: MOVER_COUNT,
          warmMs: 3000,
          measureMs: 10000,
          hold: HEAP_SECONDS > 0,
        });
        let heap = null;
        if (HEAP_SECONDS > 0) {
          try {
            heap = await heapSlope(page, HEAP_SECONDS);
          } finally {
            await page.evaluate(() => window.__benchStop?.());
          }
        }
        const deltas = measured.times
          .slice(1)
          .map((time, index) => time - measured.times[index])
          .sort((a, b) => a - b);
        scenes[name] = {
          frames: measured.times.length,
          fps: round((measured.times.length / measured.wallMs) * 1000),
          p50: round(quantile(deltas, 0.5), 2),
          p95: round(quantile(deltas, 0.95), 2),
          max: round(deltas.at(-1), 1),
          ...(heap
            ? {
                heapPostGcMB: heap.postGcMB,
                heapSlopeMBPerMin: heap.slopeMBPerMin,
              }
            : {}),
          startTilesMs: measured.startTilesMs,
        };
      }
      return {
        ok: errors.length === 0,
        initialViewMs: round(initial.initialViewMs, 0),
        scenes,
        errors,
      };
    }
    const flight = await page.evaluate(runFlight, FLIGHT);
    const deltas = flight.times
      .slice(1)
      .map((time, index) => time - flight.times[index])
      .sort((a, b) => a - b);
    return {
      ok: flight.ended === 'complete' && errors.length === 0,
      engineReadyMs: round(initial.engineAt, 0),
      initialViewMs: round(initial.initialViewMs, 0),
      startupHeight: round(initial.height, 0),
      ...(sharpen ? { sharpen } : {}),
      flight: {
        ended: flight.ended,
        startTilesMs: round(flight.startTilesMs, 0),
        wallMs: round(flight.wallMs, 0),
        frames: flight.times.length,
        fps: round((flight.times.length / flight.wallMs) * 1000),
        browserFps: round((flight.animationFrames / flight.wallMs) * 1000),
        p50: round(quantile(deltas, 0.5), 2),
        p95: round(quantile(deltas, 0.95), 2),
        max: round(deltas.at(-1), 1),
        landed: {
          lat: round(flight.landed.lat, 3),
          lon: round(flight.landed.lon, 3),
        },
      },
      errors,
    };
  } finally {
    await context.close();
  }
}

const executablePath =
  process.env.PUPPETEER_EXECUTABLE_PATH ||
  (await puppeteer.executablePath().catch(() => null));
if (!executablePath || !fs.existsSync(executablePath))
  throw new Error('Puppeteer Chrome for Testing is unavailable');

const server = argument('base-url')
  ? { url: argument('base-url'), stop: () => {} }
  : await startServer(serverKind);
const baseUrl = server.url.endsWith('/') ? server.url : `${server.url}/`;
const browser = await puppeteer.launch({
  headless: true,
  executablePath,
  args: [
    '--use-angle=metal',
    '--disable-gpu-vsync',
    '--disable-frame-rate-limit',
    '--window-size=1280,800',
  ],
});
const report = {
  server: argument('base-url') ? 'base-url' : serverKind,
  navaraLook: navaraLook ?? 'default',
  navaraSharpen: navaraSharpenArg ?? 'default',
  runs: RUNS,
  scenario,
  ...(scenario === 'movers'
    ? { count: MOVER_COUNT, scenes: MOVER_SCENES }
    : {}),
  flight: FLIGHT,
  engines: {},
};
let failed = 0;
try {
  for (const engine of ENGINES) {
    const runs = [];
    try {
      const warmUp = await runOnce(browser, baseUrl, engine);
      console.log(
        `[${engine}] warm-up (discarded): initial view ${warmUp.initialViewMs} ms`,
      );
    } catch (error) {
      console.log(
        `[${engine}] warm-up failed: ${redact(error.message).slice(0, 200)}`,
      );
    }
    for (let run = 1; run <= RUNS; run++) {
      try {
        const result = await runOnce(browser, baseUrl, engine);
        runs.push(result);
        if (!result.ok) failed += 1;
        console.log(
          `${result.ok ? 'ok  ' : 'FAIL'} [${engine}] run ${run}: ${JSON.stringify(result)}`,
        );
      } catch (error) {
        failed += 1;
        console.log(
          `FAIL [${engine}] run ${run}: ${redact(error.stack || error.message)}`,
        );
      }
    }
    const summary =
      scenario === 'movers'
        ? Object.fromEntries(
            MOVER_SCENES.map((name) => {
              const of = (key) =>
                median(runs.map((run) => run.scenes?.[name]?.[key]));
              return [
                name,
                {
                  p50: of('p50'),
                  p95: of('p95'),
                  max: of('max'),
                  fps: of('fps'),
                  heapPostGcMB: of('heapPostGcMB'),
                  heapSlopeMBPerMin: of('heapSlopeMBPerMin'),
                },
              ];
            }),
          )
        : flightSummary(runs);
    report.engines[engine] = { runs, median: summary };
    console.log(
      `[${engine}] median of ${runs.length}: ${JSON.stringify(summary)}`,
    );
  }
  if (scenario === 'movers' && report.engines.cesium && report.engines.navara) {
    report.gate = Object.fromEntries(
      MOVER_SCENES.map((name) => {
        const cesium = report.engines.cesium.median[name]?.p95;
        const navara = report.engines.navara.median[name]?.p95;
        const ratio = cesium && navara ? round(navara / cesium, 2) : null;
        return [
          name,
          { cesium, navara, ratio, pass: ratio != null && ratio <= 1.1 },
        ];
      }),
    );
    console.log(
      `[gate] p95 Navara / Cesium <= 1.1: ${JSON.stringify(report.gate)}`,
    );
  }
} finally {
  await browser.close();
  server.stop();
}
if (outFile) fs.writeFileSync(outFile, `${JSON.stringify(report, null, 2)}\n`);
process.exit(failed ? 1 : 0);

function flightSummary(runs) {
  return {
    initialViewMs: median(runs.map((run) => run.initialViewMs)),
    engineReadyMs: median(runs.map((run) => run.engineReadyMs)),
    flightP50: median(runs.map((run) => run.flight.p50)),
    flightP95: median(runs.map((run) => run.flight.p95)),
    flightMax: median(runs.map((run) => run.flight.max)),
    flightFps: median(runs.map((run) => run.flight.fps)),
  };
}
