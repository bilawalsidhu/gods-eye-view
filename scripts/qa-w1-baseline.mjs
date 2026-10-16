#!/usr/bin/env node
/**
 * The Cesium-mode baseline of the W1 layers (phase 3, Task 0): what each
 * layer shows today, recorded so the extraction tasks (`*a`) can show that
 * Cesium mode did not change. For each of flights, military, localAdsb,
 * vessels, satellites and launches, in a fresh page:
 *
 *   - the layer is enabled and given time to fill (live sources until the
 *     fixture sources of Task 8 exist; the report says which);
 *   - at the poses global / city (New York, JFK) / orbit: a JPEG of the
 *     canvas (path, size and sha256 recorded), the layer's object count, and
 *     the position and screen point of 5 known objects (the first five ids in
 *     sorted order that the layer reports at the city pose);
 *   - layers with trackById: one object is tracked and the camera pose read
 *     2 s later; the URL hash is kept as the share link and opened in a fresh
 *     page, which reports what it tracks once it has settled.
 *
 * Output: qa-artifacts/w1-baseline/<run>/{summary.json, *.jpg} (git-ignored).
 *
 * Comparable runs: --record=DIR keeps every /api response of each layer's run
 * (DIR/<layer>.json); --replay=DIR answers /api from them and freezes the page
 * clock (Date.now and new Date(), hence JulianDate.now and the app clock) at
 * the recording's time, so a run of another commit sees the same objects at
 * the same positions. --compare=A/summary.json,B/summary.json diffs two runs
 * (counts, known objects' positions and screen points, tracking poses;
 * src/tooling/w1Baseline.js tolerances) and exits 1 on a difference.
 *
 *   node scripts/qa-w1-baseline.mjs [--layers=flights,vessels] [--base-url=URL]
 *     [--fill-ms=60000] [--out=qa-artifacts/w1-baseline]
 *     [--record=DIR | --replay=DIR] [--compare=A,B]
 *
 * Starts this checkout's Vite dev server on a free port (never 4185–4189)
 * unless --base-url names one. Browsers are always headless. Provider keys are
 * never printed: server output is not echoed and URLs are redacted.
 */
import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer';
import {
  compareBaselines,
  feedRequestKey,
  frozenClockScript,
  createFeedActivity,
  feedsSettled,
  isFeedRequest,
  replayEntry,
  requestDigest,
} from '../src/tooling/w1Baseline.js';
import { syntheticRecordings } from '../src/tooling/w1Feeds.js';

const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
);
const argument = (name) =>
  process.argv
    .find((value) => value.startsWith(`--${name}=`))
    ?.slice(name.length + 3);

/** W1 layers by plan name → their id in the app's catalog. */
export const W1_LAYER_IDS = Object.freeze({
  flights: 'flights',
  military: 'military',
  localAdsb: 'local-adsb',
  vessels: 'ais-live-vessels',
  satellites: 'satellites',
  launches: 'rocket-launches',
});
const W1_LAYERS = Object.keys(W1_LAYER_IDS);
const LAYERS = (argument('layers') ?? W1_LAYERS.join(','))
  .split(',')
  .filter(Boolean);
for (const layer of LAYERS)
  if (!W1_LAYERS.includes(layer)) {
    console.error(`Unknown W1 layer "${layer}"; known: ${W1_LAYERS}`);
    process.exit(2);
  }
const FILL_MS = Number(argument('fill-ms') ?? 60000);
// --record=DIR keeps every /api response per layer (DIR/<layer>.json);
// --replay=DIR answers /api from those files and freezes the page clock at
// the recording's time, so two runs (two commits) see the same objects.
const RECORD_DIR = argument('record');
const REPLAY_DIR = argument('replay');
if (RECORD_DIR && REPLAY_DIR) {
  console.error('--record and --replay exclude each other');
  process.exit(2);
}
const BOOT_TIMEOUT_MS = Number(process.env.QA_BOOT_TIMEOUT_MS || 180000);
const RESERVED_PORTS = new Set([4185, 4186, 4187, 4188, 4189]);
const VIEWPORT = { width: 1280, height: 800 };
const KNOWN_OBJECTS = 5;
const TRACK_SETTLE_MS = 2000;

/** The poses every layer is photographed at (degrees, metres). */
export const W1_POSES = Object.freeze({
  global: { lat: 25, lon: -60, alt: 20_000_000, heading: 0, pitch: -90 },
  city: { lat: 40.58, lon: -73.78, alt: 6000, heading: 0, pitch: -35 },
  orbit: { lat: 35, lon: -95, alt: 3_000_000, heading: 0, pitch: -90 },
});
const poseHash = ({ lat, lon, alt, heading, pitch }) =>
  `v=2&lat=${lat}&lon=${lon}&alt=${alt}&heading=${heading}&pitch=${pitch}&roll=0`;

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
  const deadline = Date.now() + 60000;
  for (;;) {
    if (child.exitCode != null)
      throw new Error(`dev server exited: ${redact(stderr)}`);
    try {
      if ((await fetch(url)).ok) break;
    } catch {
      /* not listening yet */
    }
    if (Date.now() > deadline) {
      child.kill('SIGTERM');
      throw new Error(`dev server did not answer: ${redact(stderr)}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  return { url, stop: () => child.kill('SIGTERM') };
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// --- In-page probes ---------------------------------------------------------

/** A page that records its /api responses into `feed.entries`. */
function recordFeeds(page, feed) {
  page.on('response', async (response) => {
    const request = response.request();
    const url = response.url();
    if (!isFeedRequest(url)) return;
    try {
      const body = await response.buffer();
      const key = feedRequestKey(request.method(), url);
      const entry = {
        key,
        path: new URL(url).pathname,
        status: response.status(),
        contentType: response.headers()['content-type'] ?? 'application/json',
        body: body.toString('base64'),
        atMs: Date.now(),
      };
      const index = feed.entries.findIndex((other) => other.key === key);
      if (index >= 0) feed.entries.splice(index, 1);
      feed.entries.push(entry);
    } catch (error) {
      // No body (redirect, aborted): the replay answers it as unavailable.
      (feed.unrecorded ??= []).push(
        `${request.method()} ${new URL(url).pathname}: ${error.message}`,
      );
    }
  });
}

/** A page whose /api requests are answered from a recording, at its time. */
async function replayFeeds(page, recording, served) {
  await page.evaluateOnNewDocument(frozenClockScript(recording.frozenMs));
  await page.setRequestInterception(true);
  page.on('request', (request) => {
    const url = request.url();
    if (!isFeedRequest(url)) return request.continue();
    const entry = replayEntry(recording, request.method(), url);
    // What this page asked and how it was answered, for --compare.
    const key = feedRequestKey(request.method(), url);
    served.set(
      key,
      !entry ? 'none' : entry.key === key ? 'exact' : `as ${entry.key}`,
    );
    if (!entry)
      return request.respond({
        status: 503,
        contentType: 'application/json',
        body: '{"error":"not in the recording"}',
      });
    return request.respond({
      status: entry.status,
      contentType: entry.contentType,
      body: Buffer.from(entry.body, 'base64'),
    });
  });
}

async function bootPage(browser, baseUrl, hash, feed = null) {
  const context = await browser.createBrowserContext();
  const page = await context.newPage();
  await page.setViewport(VIEWPORT);
  if (feed?.mode === 'record') recordFeeds(page, feed.recording);
  // Per page: the shared-link page's requests are kept apart.
  const served = new Map();
  if (feed?.mode === 'replay') await replayFeeds(page, feed.recording, served);
  // The feed requests this page makes: the waits below settle on them.
  const activity = createFeedActivity();
  page.on('request', (request) => {
    if (isFeedRequest(request.url()))
      activity.note(feedRequestKey(request.method(), request.url()));
  });
  const errors = [];
  page.on('console', (message) => {
    if (message.type() === 'error') errors.push(redact(message.text()));
  });
  page.on('pageerror', (error) => errors.push(redact(error.message)));
  await page.goto(`${baseUrl}#${hash}`, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(
    () =>
      window.__godsEyeView?.engine &&
      window.__godsEyeView?.dataManager &&
      window.__godsEyeView?.viewer,
    { timeout: BOOT_TIMEOUT_MS, polling: 250 },
  );
  return { context, page, errors, activity, served };
}

/** Sets the view, then waits for rest and loaded tiles (bounded). */
async function goToPose(page, pose) {
  return page.evaluate(async ({ lat, lon, alt, heading, pitch }) => {
    const geo = await import('/src/geo/index.js');
    const { engine } = window.__godsEyeView;
    const rad = geo.math.toRadians;
    engine.camera.setView({
      destination: geo.cartesian3.fromDegrees(lon, lat, alt),
      orientation: { heading: rad(heading), pitch: rad(pitch), roll: 0 },
    });
    engine.render.request('qa-w1-baseline');
    const started = performance.now();
    let loadedSince = null;
    while (performance.now() - started < 20000) {
      await new Promise((resolve) => setTimeout(resolve, 200));
      engine.render.request('qa-w1-baseline');
      if (engine.surface.tilesLoaded()) {
        loadedSince ??= performance.now();
        if (performance.now() - loadedSince > 1000) break;
      } else loadedSince = null;
    }
    return {
      tilesLoaded: engine.surface.tilesLoaded(),
      waitedMs: Math.round(performance.now() - started),
    };
  }, pose);
}

/** The layer's count and (some of) its objects with screen points. */
async function readLayer(page, layer) {
  return page.evaluate(async (layer) => {
    const geo = await import('/src/geo/index.js');
    const { engine, dataManager } = window.__godsEyeView;
    const module = dataManager.layers.get(layer)?.module;
    const stats = module?.getStats?.() ?? null;
    const rows =
      typeof module?.getAllPositions === 'function'
        ? module.getAllPositions(100000)
        : [];
    const round = (value, digits) =>
      Number.isFinite(value) ? Number(value.toFixed(digits)) : null;
    const describe = (row) => {
      const position =
        row.position ??
        (Number.isFinite(row.longitude) && Number.isFinite(row.latitude)
          ? geo.cartesian3.fromDegrees(
              row.longitude,
              row.latitude,
              row.altitudeM ?? 0,
            )
          : null);
      const screen = position
        ? engine.projector.worldToWindow(position)
        : undefined;
      return {
        id: String(row.id ?? row.icao24 ?? row.mmsi ?? row.noradId),
        lat: round(row.latitude, 6),
        lon: round(row.longitude, 6),
        altitudeM: round(row.altitudeM, 1),
        screen: screen
          ? { x: round(screen.x, 1), y: round(screen.y, 1) }
          : null,
        visible: Boolean(
          screen &&
          position &&
          engine.projector.horizonVisible(position) &&
          screen.x >= 0 &&
          screen.y >= 0 &&
          screen.x <= engine.host.size().width &&
          screen.y <= engine.host.size().height,
        ),
      };
    };
    const all = rows.map(describe);
    return {
      stats: stats ? JSON.parse(JSON.stringify(stats)) : null,
      rows: rows.length,
      onScreen: all.filter((row) => row.visible).length,
      all,
    };
  }, layer);
}

/**
 * The known objects: the first KNOWN_OBJECTS ids, in sorted order, visible at
 * the first pose (city, global, orbit) that shows any.
 */
function chooseKnownIds(reads) {
  for (const name of ['city', 'global', 'orbit']) {
    const visible = (reads[name]?.all ?? [])
      .filter((row) => row.visible)
      .map((row) => row.id)
      .sort();
    if (visible.length)
      return { pose: name, ids: visible.slice(0, KNOWN_OBJECTS) };
  }
  return { pose: null, ids: [] };
}

async function waitForFill(page, layer) {
  const started = Date.now();
  let last = null;
  while (Date.now() - started < FILL_MS) {
    last = await page.evaluate((layer) => {
      const module = window.__godsEyeView.dataManager.layers.get(layer)?.module;
      const stats = module?.getStats?.() ?? {};
      const rows =
        typeof module?.getAllPositions === 'function'
          ? module.getAllPositions(1).length
          : 0;
      return { count: Number(stats.count) || 0, rows };
    }, layer);
    if (last.count > 0 || last.rows > 0) break;
    await sleep(1000);
  }
  return { ...last, ms: Date.now() - started };
}

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

async function trackOne(page, layer, id) {
  return page.evaluate(
    async (layer, id, settleMs) => {
      const { dataManager, viewer } = window.__godsEyeView;
      const module = dataManager.layers.get(layer)?.module;
      if (typeof module?.trackById !== 'function') return { supported: false };
      const ok = Boolean(await module.trackById(id, { origin: 'qa' }));
      await new Promise((resolve) => setTimeout(resolve, settleMs));
      const info = module.getTrackedInfo?.() ?? null;
      return {
        supported: true,
        ok,
        trackedEntity: Boolean(viewer.trackedEntity),
        info: info ? JSON.parse(JSON.stringify(info)) : null,
      };
    },
    layer,
    id,
    TRACK_SETTLE_MS,
  );
}

const trackedSummary = (info) =>
  info
    ? {
        id: info.icao24 ?? info.noradId ?? info.id ?? info.mmsi ?? null,
        keys: Object.keys(info).sort(),
      }
    : null;

// --- Run ----------------------------------------------------------------------

async function runLayer(browser, baseUrl, name, outDir) {
  const layer = W1_LAYER_IDS[name];
  const recordingFile = (dir) => path.resolve(repoRoot, dir, `${name}.json`);
  const feed = RECORD_DIR
    ? { mode: 'record', recording: { layer: name, entries: [] } }
    : REPLAY_DIR
      ? {
          mode: 'replay',
          recording: JSON.parse(
            fs.readFileSync(recordingFile(REPLAY_DIR), 'utf8'),
          ),
        }
      : null;
  const result = {
    layer: name,
    id: layer,
    source: feed?.mode === 'replay' ? `replay ${REPLAY_DIR}` : 'live',
    ...(feed?.mode === 'replay' ? { frozenMs: feed.recording.frozenMs } : {}),
    poses: {},
    errors: [],
  };
  const opened = await bootPage(
    browser,
    baseUrl,
    poseHash(W1_POSES.city),
    feed,
  );
  const { page } = opened;
  try {
    await page.evaluate(
      (layer) =>
        window.__godsEyeView.dataManager.setEnabled(layer, true, {
          origin: 'user',
        }),
      layer,
    );
    result.fill = await waitForFill(page, layer);
    if (feed?.mode === 'record') {
      // The replay clock: the last feed answer of the fill.
      const recording = feed.recording;
      recording.frozenMs = Math.max(
        Date.now() - 1000,
        ...recording.entries.map((entry) => entry.atMs),
      );
      fs.mkdirSync(path.resolve(repoRoot, RECORD_DIR), { recursive: true });
      fs.writeFileSync(recordingFile(RECORD_DIR), JSON.stringify(recording));
      result.recorded = {
        unrecorded: recording.unrecorded ?? [],
        entries: recording.entries.length,
        frozenMs: recording.frozenMs,
      };
    }
    const reads = {};
    for (const name of ['city', 'global', 'orbit']) {
      const wait = await goToPose(page, W1_POSES[name]);
      // The feeds this pose asks (viewport queries, terrain heights).
      await feedsSettled(opened.activity, { quietMs: 3000, maxMs: 30000 });
      const read = await readLayer(page, layer);
      reads[name] = read;
      const file = `${result.layer}-${name}.jpg`;
      const jpeg = await page.screenshot({ type: 'jpeg', quality: 70 });
      fs.writeFileSync(path.join(outDir, file), jpeg);
      result.poses[name] = {
        ...wait,
        pose: await page.evaluate(readPose),
        stats: read.stats,
        rows: read.rows,
        onScreen: read.onScreen,
        shot: {
          file,
          bytes: jpeg.length,
          sha256: crypto.createHash('sha256').update(jpeg).digest('hex'),
        },
      };
    }
    const known = chooseKnownIds(reads);
    result.knownFrom = known.pose;
    for (const [name, read] of Object.entries(reads))
      result.poses[name].known = known.ids.map(
        (id) => read.all.find((row) => row.id === id) ?? { id, missing: true },
      );
    // Tracking: at the pose the known objects came from, the first of them.
    const trackId = known.ids[0];
    if (trackId) {
      await goToPose(page, W1_POSES[known.pose]);
      const tracked = await trackOne(page, layer, trackId);
      if (tracked.supported) {
        const pose = await page.evaluate(readPose);
        await sleep(1500); // the share hash is written on a debounce
        const hash = new URL(page.url()).hash;
        // What tracking asks (track history, type enrichment), settled.
        await feedsSettled(opened.activity, { quietMs: 3000, maxMs: 30000 });
        result.tracking = {
          id: trackId,
          ok: tracked.ok,
          trackedEntity: tracked.trackedEntity,
          info: trackedSummary(tracked.info),
          poseAfter2s: pose,
          shareHash: redact(hash),
        };
        const shared = await bootPage(
          browser,
          baseUrl,
          hash.slice(1),
          feed?.mode === 'replay' ? feed : null,
        );
        try {
          // Event-based: the shared page has the layer on, has asked the
          // layer's own feed, and asks nothing new for 3 s (bounded). The
          // link carries no tracked object (src/sharelink.js has no field
          // for one, also at 512c5d18), so tracking cannot be what it
          // restores: sharedOpen.trackedEntity is false on every commit, a
          // known gap recorded as `trackingInLink: false`.
          await shared.page.waitForFunction(
            (layer) => window.__godsEyeView.dataManager.isEnabled(layer),
            { timeout: 60000, polling: 250 },
            layer,
          );
          const ownPaths = new Set(
            (feed?.recording?.entries ?? []).map((entry) => entry.path),
          );
          result.tracking.sharedSettled = await feedsSettled(shared.activity, {
            ready: () =>
              ownPaths.size === 0 ||
              shared.activity.asked((key) =>
                ownPaths.has(key.split(' ')[1].split('?')[0]),
              ),
            quietMs: 3000,
            maxMs: 60000,
          });
          result.tracking.sharedOpen = await shared.page.evaluate((layer) => {
            const { dataManager, viewer } = window.__godsEyeView;
            const module = dataManager.layers.get(layer)?.module;
            const info = module?.getTrackedInfo?.() ?? null;
            return {
              enabled: Boolean(dataManager.isEnabled(layer)),
              trackedEntity: Boolean(viewer.trackedEntity),
              trackedId: info
                ? (info.icao24 ?? info.noradId ?? info.id ?? null)
                : null,
            };
          }, layer);
          result.tracking.sharedOpen.errors = shared.errors.slice(0, 5);
          result.tracking.sharedOpen.trackingInLink =
            /[?&#](?:track|trk)=/.test(hash);
          if (feed?.mode === 'replay')
            result.tracking.sharedRequests = requestDigest(shared.served);
        } finally {
          await shared.context.close();
        }
      } else result.tracking = { supported: false };
    }
  } catch (error) {
    result.failure = redact(error.stack ?? error.message);
  } finally {
    result.errors = opened.errors.slice(0, 10);
    if (feed?.mode === 'replay') result.requests = requestDigest(opened.served);
    await opened.context.close();
  }
  return result;
}

// --compare=A,B compares two summary.json runs and exits.
// --synthesize=DIR writes the seeded synthetic recordings of flights
// (global OpenSky snapshot), vessels (12 000 AIS rows, with and without the
// city area) and local ADS-B (1090 MHz and 978 MHz UAT) into DIR, beside
// the recorded military, satellites and launches, and exits.
const synthesizeDir = argument('synthesize');
if (synthesizeDir) {
  const dir = path.resolve(repoRoot, synthesizeDir);
  fs.mkdirSync(dir, { recursive: true });
  for (const [layer, recording] of Object.entries(syntheticRecordings()))
    fs.writeFileSync(
      path.join(dir, `${layer}.json`),
      JSON.stringify(recording),
    );
  console.log(`[w1-baseline] synthetic flights, vessels, localAdsb in ${dir}`);
  process.exit(0);
}

const compareArg = argument('compare');
if (compareArg) {
  const [a, b] = compareArg
    .split(',')
    .map((file) => JSON.parse(fs.readFileSync(file, 'utf8')));
  const { ok, differences } = compareBaselines(a, b);
  for (const difference of differences)
    console.log(`[w1-baseline] DIFF ${JSON.stringify(difference)}`);
  console.log(
    ok
      ? '[w1-baseline] the runs agree within the tolerances'
      : `[w1-baseline] ${differences.length} difference(s)`,
  );
  process.exit(ok ? 0 : 1);
}

const executablePath =
  process.env.PUPPETEER_EXECUTABLE_PATH ||
  (await puppeteer.executablePath().catch(() => null));
if (!executablePath || !fs.existsSync(executablePath))
  throw new Error('Puppeteer Chrome for Testing is unavailable');
const runId = new Date().toISOString().replace(/[:.]/g, '-');
const outDir = path.resolve(
  repoRoot,
  argument('out') ?? 'qa-artifacts/w1-baseline',
  runId,
);
fs.mkdirSync(outDir, { recursive: true });

const server = argument('base-url')
  ? { url: argument('base-url'), stop: () => {} }
  : await startServer();
const browser = await puppeteer.launch({
  headless: true,
  executablePath,
  args: [
    '--use-angle=metal',
    `--window-size=${VIEWPORT.width},${VIEWPORT.height}`,
  ],
});
const summary = {
  run: runId,
  engine: 'cesium',
  poses: W1_POSES,
  layers: {},
};
let failed = 0;
try {
  for (const layer of LAYERS) {
    console.log(`[w1-baseline] ${layer}…`);
    const result = await runLayer(browser, server.url, layer, outDir);
    summary.layers[layer] = result;
    if (result.failure) failed++;
    const counts = Object.entries(result.poses)
      .map(([name, pose]) => `${name} ${pose.rows}/${pose.onScreen}`)
      .join(', ');
    console.log(
      `[w1-baseline] ${layer}: fill ${JSON.stringify(result.fill)}; rows/on-screen ${counts}` +
        (result.tracking
          ? `; tracking ${JSON.stringify({ ok: result.tracking.ok, shared: result.tracking.sharedOpen })}`
          : '') +
        (result.failure ? `; FAILED ${result.failure.split('\n')[0]}` : '') +
        (result.errors.length
          ? `; ${result.errors.length} console errors`
          : ''),
    );
  }
} finally {
  await browser.close();
  server.stop();
}
fs.writeFileSync(
  path.join(outDir, 'summary.json'),
  JSON.stringify(summary, null, 2),
);
console.log(
  `[w1-baseline] ${path.relative(repoRoot, outDir)}/summary.json` +
    (failed ? ` — ${failed} layer(s) failed` : ''),
);
process.exitCode = failed ? 1 : 0;
