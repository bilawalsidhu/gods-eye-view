#!/usr/bin/env node
/**
 * qa-traffic-viewport-budget.mjs — where the traffic dot budget actually lands.
 *
 * `MAX_DOTS` is a hard cap on rendered dot primitives, and every dot costs the
 * same per-frame animation work whether or not the user can see it. The layer
 * fetches one clamped tile (up to 0.05° per axis) centered on the camera's
 * look-at point, but the camera only ever shows part of that tile — so the
 * interesting question for dense-city performance is not "how many dots are
 * there" but "how many of them are on screen".
 *
 * This probe answers that with the running app. For each camera it waits for a
 * settled traffic render, reads every rendered dot through the layer's public
 * `getDetectableObjects()` API, and classifies each one against the live
 * camera:
 *
 *   on-screen  — in front of the camera and inside the canvas rectangle,
 *   off-canvas — in front of the camera but outside the canvas rectangle,
 *   behind     — behind the camera plane.
 *
 * `onScreenPct` is the share of the cap the user can actually see. It is pure
 * allocation arithmetic — no GPU timing — so it is directly comparable between
 * two builds on the same machine, which is what makes it usable as a
 * before/after number for allocation changes.
 *
 * Frame time is sampled too, but it is reported as relative-only: under
 * SwiftShader it says nothing about a real GPU. The script prints the detected
 * renderer and repeats that warning when software rendering is detected.
 *
 * What this capture is NOT:
 *
 *  - Occlusion is not tested. A dot standing behind a building still counts as
 *    on-screen, so `onScreenPct` is an UPPER bound on what is visible.
 *  - Roads come from an axis-aligned fixture grid, where the allocator's
 *    bounding-box reachability test is very nearly exact. Real ways curve and
 *    run diagonally, and their boxes reach into the camera rectangle more
 *    often than their geometry does, so a gain measured here is an upper bound
 *    as well. `--real-overpass` swaps in live road data, at the cost of
 *    run-to-run comparability.
 *  - One sample per camera. Dot placement along a road is random, so re-run
 *    before reading anything into a delta of a point or two.
 *
 * The run exits non-zero when its own preconditions fail — most importantly
 * when no camera reached the dot cap, since allocation order cannot change a
 * capture where the cap never bound.
 *
 *   node scripts/qa-traffic-viewport-budget.mjs --url http://localhost:4173
 *   node scripts/qa-traffic-viewport-budget.mjs --json > before.json
 *   node scripts/qa-traffic-viewport-budget.mjs --real-overpass
 *
 * Requires a dev server already serving the app; the harness does not start one.
 */

import puppeteer from 'puppeteer';
import fs from 'node:fs';

/** Requests the road fixture could not answer; named on the failure path. */
const fixtureErrors = [];

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
const AS_JSON = argv.includes('--json');
const REAL_OVERPASS = argv.includes('--real-overpass');
const TIMEOUT_MS = Math.max(10_000, getNumberOpt('--timeout-ms', 120_000));
const FRAME_SAMPLES = Math.max(10, getNumberOpt('--frame-samples', 40));

/**
 * Blocks per axis in the synthetic grid. Chosen so the fetched tile carries a
 * dense-core road count (~2.4k ways) whose ideal dot demand is comfortably
 * above `MAX_DOTS`: allocation ORDER is only observable once the cap binds.
 */
const GRID_BLOCKS = 35;

/**
 * Serve a deterministic dense street grid for the requested Overpass bbox.
 *
 * Live Overpass is unusable as a measurement surface here: the mirrors rate-limit
 * under repeated dense-core queries, and two runs of the same camera do not
 * return the same roads, so a before/after difference could never be attributed
 * to the code under test. The grid instead fills the whole fetched tile with
 * block-length ways, which is what makes the off-screen share meaningful — a
 * tile-spanning road would sit in every viewport by construction.
 *
 * @param {string} query - The Overpass QL body the layer posted.
 * @returns {{elements:Array}} An Overpass-shaped response for that bbox.
 */
function syntheticGrid(query) {
  const match = query.match(/\((-?[\d.]+),(-?[\d.]+),(-?[\d.]+),(-?[\d.]+)\)/);
  if (!match) throw new Error('Missing road fixture viewport');
  const [south, west, north, east] = match.slice(1).map(Number);
  const latStep = (north - south) / GRID_BLOCKS;
  const lonStep = (east - west) / GRID_BLOCKS;
  const elements = [];
  let id = 1;
  // Every fifth line is an avenue, matching the density mix of a real core.
  const highwayFor = (line) => (line % 5 === 0 ? 'primary' : 'residential');
  for (let row = 0; row <= GRID_BLOCKS; row++) {
    const lat = south + row * latStep;
    for (let col = 0; col < GRID_BLOCKS; col++) {
      elements.push({
        type: 'way',
        id: id++,
        tags: { highway: highwayFor(row) },
        geometry: [
          { lat, lon: west + col * lonStep },
          { lat, lon: west + (col + 1) * lonStep },
        ],
      });
    }
  }
  for (let col = 0; col <= GRID_BLOCKS; col++) {
    const lon = west + col * lonStep;
    for (let row = 0; row < GRID_BLOCKS; row++) {
      elements.push({
        type: 'way',
        id: id++,
        tags: { highway: highwayFor(col) },
        geometry: [
          { lat: south + row * latStep, lon },
          { lat: south + (row + 1) * latStep, lon },
        ],
      });
    }
  }
  return { elements };
}

/**
 * Cameras spanning both allocation regimes.
 *
 * Dot spacing tightens from 80 m to 30 m below 1 km altitude, so a dense core
 * seen from ~700 m demands several times the dot cap and the allocator has to
 * choose; the same core from ~1.5 km stays under the cap and every road gets
 * its ideal count. Both regimes are captured on purpose: a change to allocation
 * ORDER can only move the capped rows, and a report that shows only those would
 * overstate it.
 *
 * Pitch is varied as well — an oblique camera shows a ground trapezoid that
 * shares only part of its area with the fetched tile.
 */
const VIEWS = [
  {
    name: 'manhattan low oblique',
    lon: -73.9857,
    lat: 40.7484,
    height: 650,
    heading: 20,
    pitch: -30,
  },
  {
    name: 'london low oblique',
    lon: -0.1276,
    lat: 51.5072,
    height: 650,
    heading: 35,
    pitch: -35,
  },
  {
    name: 'manhattan mid pitch',
    lon: -73.9857,
    lat: 40.7484,
    height: 1500,
    heading: 20,
    pitch: -55,
  },
  {
    name: 'austin reference',
    lon: -97.7431,
    lat: 30.2672,
    height: 1500,
    heading: 8,
    pitch: -78,
  },
];

/** Mirrors MAX_DOTS in src/layers/traffic/policy.js — used only to label rows. */
const MAX_DOTS = 6000;

const CHROME_EXECUTABLE_CANDIDATES = [
  process.env.PUPPETEER_EXECUTABLE_PATH,
  await puppeteer.executablePath().catch(() => null),
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Chromium.app/Contents/MacOS/Chromium',
].filter(Boolean);

function findChromeExecutable() {
  for (const candidate of CHROME_EXECUTABLE_CANDIDATES) {
    try {
      if (fs.existsSync(candidate)) return candidate;
    } catch {
      /* ignore */
    }
  }
  return null;
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Position the camera and raise the boundaries the traffic layer observes. */
function moveCamera(page, view) {
  return page.evaluate((v) => {
    const gev = window.__godsEyeView;
    const module = gev.dataManager.layers.get('traffic').module;
    const beforeLastUpdate = module.getStats().lastUpdate;
    const ellipsoid = gev.viewer.scene.globe.ellipsoid;
    const radians = Math.PI / 180;
    try {
      gev.viewer.camera.cancelFlight();
    } catch {
      /* no active flight */
    }
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
    gev.viewer.camera.changed.raiseEvent();
    gev.viewer.camera.moveEnd.raiseEvent();
    return beforeLastUpdate;
  }, view);
}

/**
 * Wait until the triggered load has finished and painted dots.
 *
 * On timeout, report what the layer was actually doing. "Never settled" on its
 * own sends the reader to the layer when the cause is usually elsewhere — a
 * fixture that answered 500, a failed road request, or a host too loaded to
 * finish a software-rendered frame inside the window.
 */
async function waitForSettledRender(page, beforeLastUpdate, viewName) {
  try {
    await waitForSettledRenderInner(page, beforeLastUpdate);
  } catch (error) {
    const state = await page
      .evaluate(() => {
        const module =
          window.__godsEyeView?.dataManager?.layers?.get('traffic')?.module;
        if (!module) return { reached: false };
        const stats = module.getStats();
        return {
          reached: true,
          count: stats.count,
          loading: stats.loading,
          error: stats.error ?? null,
          lastUpdate: stats.lastUpdate,
        };
      })
      .catch(() => ({ reached: false }));
    const detail = state.reached
      ? `layer stats: count=${state.count} loading=${state.loading} error=${state.error} lastUpdate ${state.lastUpdate === beforeLastUpdate ? 'never changed (no load was triggered)' : 'changed'}`
      : 'the traffic layer was not reachable on the page';
    const fixture = fixtureErrors.length
      ? ` — the road fixture failed ${fixtureErrors.length} request(s), first: ${fixtureErrors[0]}`
      : '';
    throw new Error(
      `"${viewName}" never settled: ${error.message}. ${detail}${fixture}`,
    );
  }
}

async function waitForSettledRenderInner(page, beforeLastUpdate) {
  await page.waitForFunction(
    (before) => {
      const module =
        window.__godsEyeView?.dataManager?.layers?.get('traffic')?.module;
      if (!module) return false;
      const stats = module.getStats();
      return stats.lastUpdate !== before && stats.count > 0 && !stats.loading;
    },
    { timeout: TIMEOUT_MS, polling: 100 },
    beforeLastUpdate,
  );
  // Let the full pass land after the major pass flips `_fetching` false.
  await sleep(600);
}

/**
 * Classify every rendered dot against the live camera.
 *
 * Two hazards are handled explicitly, and both were observed rather than
 * assumed:
 *
 *  - Dots are re-projected at ellipsoid height 0 instead of at their rendered
 *    height. `parseRoads` plants each road at one `scene.sampleHeight()` probe
 *    guarded only by `Number.isFinite`, and a headless SwiftShader context with
 *    no terrain or 3D tiles loaded answers that probe with a finite but absurd
 *    value — measured here at −16 825 m, which drops every dot far underground
 *    and pushes its projection off the bottom of the canvas. Flattening to the
 *    ellipsoid removes that environment artifact and leaves the horizontal
 *    placement, which is exactly what dot allocation controls.
 *  - The behind-camera test is an explicit dot product against the camera
 *    direction: `cartesianToCanvasCoordinates` projects points behind the eye
 *    to mirrored canvas coordinates that would otherwise count as visible.
 */
function classifyDots(page) {
  return page.evaluate(() => {
    const gev = window.__godsEyeView;
    const module = gev.dataManager.layers.get('traffic').module;
    const scene = gev.viewer.scene;
    const camera = scene.camera;
    const canvas = scene.canvas;
    const ellipsoid = scene.globe.ellipsoid;
    const width = canvas.clientWidth || canvas.width;
    const height = canvas.clientHeight || canvas.height;
    const stats = module.getStats();
    const objects = module.getDetectableObjects({ maxCount: stats.count });

    const eye = camera.positionWC;
    const dir = camera.directionWC;
    let onScreen = 0;
    let offCanvas = 0;
    let behind = 0;
    let groundHeightSum = 0;
    for (const object of objects) {
      const rendered = object.position;
      if (!rendered) continue;
      const carto = ellipsoid.cartesianToCartographic(rendered);
      if (!carto) continue;
      groundHeightSum += carto.height;
      const p = ellipsoid.cartographicToCartesian({
        longitude: carto.longitude,
        latitude: carto.latitude,
        height: 0,
      });
      const vx = p.x - eye.x;
      const vy = p.y - eye.y;
      const vz = p.z - eye.z;
      if (vx * dir.x + vy * dir.y + vz * dir.z <= 0) {
        behind++;
        continue;
      }
      const c = scene.cartesianToCanvasCoordinates(p);
      if (c && c.x >= 0 && c.x <= width && c.y >= 0 && c.y <= height)
        onScreen++;
      else offCanvas++;
    }
    return {
      dotsTotal: stats.count,
      dotsClassified: objects.length,
      onScreen,
      offCanvas,
      behind,
      // Reported so a contaminated sampleHeight context is visible rather than
      // silently folded into the percentages.
      meanRenderedHeightM: objects.length
        ? groundHeightSum / objects.length
        : NaN,
      canvas: { width, height },
    };
  });
}

/** Sample animation-frame deltas; relative-only under software rendering. */
function sampleFrameMs(page, samples) {
  return page.evaluate(
    (count) =>
      new Promise((resolve) => {
        const deltas = [];
        let last = performance.now();
        const tick = (now) => {
          deltas.push(now - last);
          last = now;
          if (deltas.length < count) requestAnimationFrame(tick);
          else resolve(deltas);
        };
        requestAnimationFrame(tick);
      }),
    samples,
  );
}

/** Median of a numeric sample, without mutating the caller's array. */
function median(values) {
  if (!values.length) return NaN;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
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
  try {
    const response = await fetch(APP_URL);
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
  } catch (error) {
    console.error(
      `\nDev server not reachable at ${APP_URL} (${error.message}).`,
    );
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

  const results = [];
  const consoleErrors = [];
  let roadCount = null;
  try {
    const page = await browser.newPage();
    await page.setViewport({ width: 1440, height: 900 });
    await page.evaluateOnNewDocument(() => localStorage.clear());
    page.on('console', (message) => {
      const text = message.text();
      if (message.type() === 'error') consoleErrors.push(text);
      const match = /\[Data:Traffic\].*roads=(\d+)/.exec(text);
      if (match) roadCount = Number(match[1]);
    });
    page.on('pageerror', (error) => consoleErrors.push(error.message));

    // Force the keyless path so the capture needs no TomTom key and isolates
    // the OSM road-to-dot chain, exactly as qa-traffic-baseline.mjs does, and
    // (unless --real-overpass) answer Overpass from the deterministic grid.
    await page.setRequestInterception(true);
    page.on('request', async (request) => {
      const url = request.url();
      if (url.includes('/api/tomtom/status')) {
        await request.respond({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({ hasKey: false }),
        });
        return;
      }
      if (!REAL_OVERPASS && url.includes('/api/overpass')) {
        const query =
          new URLSearchParams(request.postData() || '').get('data') || '';
        let body;
        try {
          body = JSON.stringify(syntheticGrid(query));
        } catch (error) {
          // Throwing here would reject inside Puppeteer's handler, leave the
          // request unanswered, and surface minutes later as "never settled"
          // — pointing at the layer instead of at this fixture.
          fixtureErrors.push(`${error.message}: ${query.slice(0, 120)}`);
          await request.respond({ status: 500, body: 'fixture error' });
          return;
        }
        await request.respond({
          status: 200,
          contentType: 'application/json',
          body,
        });
        return;
      }
      try {
        await request.continue();
      } catch {
        /* page closed or already handled */
      }
    });

    await page.goto(APP_URL, {
      waitUntil: 'domcontentloaded',
      timeout: 60_000,
    });
    await page.waitForFunction(
      () => window.__godsEyeView?.viewer && window.__godsEyeView?.dataManager,
      { timeout: 60_000 },
    );

    await page.evaluate(async () => {
      const gev = window.__godsEyeView;
      await gev.dataManager.restoreEnabledLayerIds([]);
      await gev.dataManager.setEnabled('traffic', true);
    });

    const renderer = await readRenderer(page);
    const softwareRenderer = /swiftshader|software/i.test(renderer);

    for (const view of VIEWS) {
      // Park above the activation ceiling first so every leg is a cold arrival
      // rather than a partially satisfied overlap gate.
      await moveCamera(page, { ...view, height: 9000, pitch: -90 });
      await sleep(400);
      roadCount = null;
      const before = await moveCamera(page, view);
      await waitForSettledRender(page, before, view.name);
      const classified = await classifyDots(page);
      const frames = await sampleFrameMs(page, FRAME_SAMPLES);
      results.push({
        view: view.name,
        pitch: view.pitch,
        height: view.height,
        roads: roadCount,
        ...classified,
        onScreenPct: classified.dotsClassified
          ? (100 * classified.onScreen) / classified.dotsClassified
          : NaN,
        // Allocation order can only matter once demand exceeds the cap; rows
        // below it are reported so an unchanged result stays visible.
        atCap: classified.dotsTotal >= MAX_DOTS * 0.95,
        frameMsMedian: median(frames),
      });
    }

    // A capture only means something if its preconditions held. Without these
    // the table still prints numbers, and the first reading of this harness
    // was exactly that: percentages taken at cameras where the cap never
    // bound, where allocation order cannot change anything.
    //
    // Resource-load failures are split out: a keyless checkout cannot reach
    // the tile providers, so those are environment noise rather than a defect
    // in the build under test.
    const RESOURCE_FAILURE = /Failed to load resource/i;
    const scriptErrors = consoleErrors.filter((e) => !RESOURCE_FAILURE.test(e));
    const resourceErrors = consoleErrors.length - scriptErrors.length;
    const problems = [];
    if (fixtureErrors.length) {
      problems.push(
        `the road fixture failed ${fixtureErrors.length} request(s): ${fixtureErrors[0]}`,
      );
    }
    if (!results.some((row) => row.atCap)) {
      problems.push(
        `no camera reached the ${MAX_DOTS}-dot cap, so this capture cannot ` +
          'show anything about allocation order',
      );
    }
    for (const row of results) {
      if (!Number.isFinite(row.onScreenPct)) {
        problems.push(`"${row.view}" classified no dots`);
      }
    }
    if (scriptErrors.length) {
      problems.push(`browser script errors: ${scriptErrors[0]}`);
    }

    const payload = {
      url: APP_URL,
      renderer,
      softwareRenderer,
      roadSource: REAL_OVERPASS
        ? 'real overpass'
        : `synthetic grid ${GRID_BLOCKS}`,
      frameSamples: FRAME_SAMPLES,
      results,
      problems,
      resourceErrors,
      consoleErrors,
    };

    // Exit status, not just a table: the repo's other QA scripts fail loudly
    // rather than leaving a reader to notice a bad row.
    if (problems.length) process.exitCode = 1;

    if (AS_JSON) {
      console.log(JSON.stringify(payload, null, 2));
      for (const problem of problems) console.error(`PROBLEM: ${problem}`);
      return;
    }

    console.log('\nTraffic dot budget — where the cap actually lands');
    console.log(`  App URL        : ${APP_URL}`);
    console.log(`  Road source    : ${payload.roadSource}`);
    console.log(`  WebGL renderer : ${renderer}`);
    console.table(
      results.map((row) => ({
        View: row.view,
        Pitch: row.pitch,
        Roads: row.roads ?? '—',
        Dots: row.dotsTotal,
        'At cap': row.atCap ? 'yes' : 'no',
        'On screen': row.onScreen,
        'Off canvas': row.offCanvas,
        Behind: row.behind,
        'On screen %': Number.isFinite(row.onScreenPct)
          ? row.onScreenPct.toFixed(1)
          : '—',
        'Mean dot height m': Number.isFinite(row.meanRenderedHeightM)
          ? Math.round(row.meanRenderedHeightM)
          : '—',
        'Frame ms (median)': Number.isFinite(row.frameMsMedian)
          ? row.frameMsMedian.toFixed(1)
          : '—',
      })),
    );
    console.log('\nNotes:');
    console.log(
      REAL_OVERPASS
        ? '  - On screen % is allocation arithmetic, not a GPU measurement.'
        : '  - On screen % is allocation arithmetic, not a GPU measurement: comparable across builds.',
    );
    console.log(
      '  - Occlusion is not tested, so On screen % is an upper bound on what is really visible.',
    );
    if (!REAL_OVERPASS) {
      console.log(
        "  - The fixture grid is axis-aligned, where the allocator's bounding-box",
      );
      console.log(
        '    test is near exact. Real curved and diagonal ways land in the visible',
      );
      console.log(
        '    tier more often, so a measured gain here is an upper bound too.',
      );
    } else {
      console.log(
        '  - --real-overpass: road sets differ between runs and the cap may not bind,',
      );
      console.log('    so these rows are NOT comparable across builds.');
    }
    console.log(
      '  - One sample per camera. Re-run to judge the noise floor before trusting a small delta.',
    );
    if (!HEADFUL || softwareRenderer) {
      console.log(
        '  - Frame ms is relative-only under SwiftShader; rerun --headful on a real GPU to report it.',
      );
    }
    if (resourceErrors) {
      console.log(
        `  - ${resourceErrors} resource-load failure(s) — expected without provider keys.`,
      );
    }
    if (problems.length) {
      console.log('\nPROBLEMS — this capture does not support a conclusion:');
      for (const problem of problems) console.log(`  - ${problem}`);
    }
  } finally {
    await browser.close();
  }
}

main().catch((error) => {
  console.error('\nTraffic viewport-budget capture failed:', error);
  process.exit(3);
});
