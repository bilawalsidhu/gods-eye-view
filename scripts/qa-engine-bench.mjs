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
 *     [--navara-look=cinematic|photoreal|minimal]
 *
 * --server=dev (the default) starts this checkout's Vite dev server and
 * --server=preview a `vite preview` of dist/ (run `npm run build` first),
 * each on a free port (never 4185 or 4186), unless --base-url names a running server.
 * Each engine gets one discarded warm-up run (the dev server transforms
 * modules on first request), then --runs measured runs, each in a fresh
 * browser context. --navara-look picks Navara's look (`?look=`; the app's
 * default, cinematic, when omitted). Reports every run and the medians. Headless numbers are
 * indicative: no display, no vsync, a software-composited headless window.
 * Provider keys are never printed. Exits 1 when a run fails.
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
const navaraLook = argument('navara-look');
if (navaraLook && !['cinematic', 'photoreal', 'minimal'].includes(navaraLook)) {
  console.error(
    `Unknown Navara look "${navaraLook}"; known: cinematic, photoreal, minimal`,
  );
  process.exit(2);
}
const RESERVED_PORTS = new Set([4185, 4186]);
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
  runs: RUNS,
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
    const summary = {
      initialViewMs: median(runs.map((run) => run.initialViewMs)),
      engineReadyMs: median(runs.map((run) => run.engineReadyMs)),
      flightP50: median(runs.map((run) => run.flight.p50)),
      flightP95: median(runs.map((run) => run.flight.p95)),
      flightMax: median(runs.map((run) => run.flight.max)),
      flightFps: median(runs.map((run) => run.flight.fps)),
    };
    report.engines[engine] = { runs, median: summary };
    console.log(
      `[${engine}] median of ${runs.length}: ${JSON.stringify(summary)}`,
    );
  }
} finally {
  await browser.close();
  server.stop();
}
if (outFile) fs.writeFileSync(outFile, `${JSON.stringify(report, null, 2)}\n`);
process.exit(failed ? 1 : 0);
