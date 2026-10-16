#!/usr/bin/env node
/**
 * S2 surface heights on both engines, in the app (headless Chrome): at 20
 * places (the JFK, SFO and AUS airfields, roofs and streets) the camera
 * looks straight down from 800 m above the ground, waits for the tiles, and
 * reads engine.surface.sampleHeightDetailed; then again from 15 km with
 * lod 'finest'. Cesium at 800 m is the reference. Gates (plan Task 6): at
 * 800 m at least 18 of 20 Navara heights within 2 m of Cesium, at 15 km
 * (finest) at least 15. Also prints each answer's tile size and whether
 * the floor rule (meshFloorSampler's MAX_FLOOR_TILE_SIZE_M) would take it.
 *
 *   node scripts/qa-surface-heights.mjs --base-url=http://localhost:PORT/
 *     [--out=qa-artifacts/surface-heights.json] [--settle-ms=20000]
 *
 * The server is the caller's (never on ports 4185–4188). Browsers are always
 * headless. Keys are never printed. Exits 1 when a gate fails.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer';
import { MAX_FLOOR_TILE_SIZE_M } from '../src/services/meshFloorSampler.js';

const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
);
const argument = (name) =>
  process.argv
    .find((value) => value.startsWith(`--${name}=`))
    ?.slice(name.length + 3);

const RESERVED_PORTS = new Set([4185, 4186, 4187, 4188]);
const baseUrl = argument('base-url');
if (!baseUrl) {
  console.error('--base-url=http://localhost:PORT/ is required');
  process.exit(2);
}
if (RESERVED_PORTS.has(Number(new URL(baseUrl).port))) {
  console.error('ports 4185–4188 are reserved');
  process.exit(2);
}
const outFile = argument('out');
const SETTLE_MS = Number(argument('settle-ms') ?? 20000);
const BOOT_TIMEOUT_MS = 180000;
const TOLERANCE_M = 2;
const GATES = { near: 18, far: 15 };

// [name, lon, lat, rough ground height above the ellipsoid (m)].
const PLACES = [
  ['JFK apron T4', -73.79, 40.644, -25],
  ['JFK runway 31L', -73.77, 40.635, -25],
  ['JFK runway 13R', -73.792, 40.648, -25],
  ['JFK T5 roof', -73.7787, 40.6455, 0],
  ['SFO runway 28L', -122.375, 37.613, -30],
  ['SFO apron', -122.388, 37.616, -30],
  ['SFO terminal roof', -122.3895, 37.6155, -10],
  ['SFO taxiway', -122.36, 37.618, -30],
  ['AUS runway 17R', -97.67, 30.199, 120],
  ['AUS terminal roof', -97.666, 30.203, 140],
  ['AUS apron', -97.668, 30.201, 120],
  ['AUS runway 17L', -97.656, 30.195, 120],
  ['Austin Congress Ave', -97.743, 30.27, 140],
  ['Austin downtown roof', -97.7431, 30.2672, 280],
  ['Austin Capitol lawn', -97.7404, 30.274, 150],
  ['Empire State roof', -73.9857, 40.7484, 410],
  ['Broadway at Times Sq', -73.987, 40.757, -15],
  ['Central Park lawn', -73.968, 40.781, 0],
  ['Market St SF', -122.4194, 37.7749, -15],
  ['Salesforce Tower roof', -122.397, 37.7897, 300],
];

async function runEngine(browser, engine) {
  const context = await browser.createBrowserContext();
  const page = await context.newPage();
  await page.setViewport({ width: 1280, height: 800 });
  await page.evaluateOnNewDocument(() => {
    try {
      localStorage.setItem('gev:first-run-mission:v1', 'suppressed');
    } catch {
      /* storage blocked */
    }
  });
  const url = new URL(baseUrl);
  url.searchParams.set('engine', engine);
  await page.goto(url.href, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => Boolean(window.__godsEyeView?.engine), {
    timeout: BOOT_TIMEOUT_MS,
    polling: 250,
  });
  // The startup fly-in ends before the checks move the camera.
  await new Promise((resolve) => setTimeout(resolve, 8000));
  const startup = await page.evaluate(async () => {
    const geo = await import('/src/geo/index.js');
    const { engine } = window.__godsEyeView;
    return engine.surface.sampleHeightDetailed(
      geo.cartographic.fromDegrees(-97.7431, 30.2672, 0),
    );
  });
  const results = [];
  for (const [name, lon, lat, ground] of PLACES) {
    const row = { name };
    for (const [key, height, lod] of [
      ['near', ground + 800, 'visible'],
      ['far', 15000, 'finest'],
    ])
      row[key] = await page.evaluate(
        async ({ lon, lat, height, lod, settleMs }) => {
          const geo = await import('/src/geo/index.js');
          const { engine } = window.__godsEyeView;
          engine.camera.setView({
            destination: geo.cartesian3.fromDegrees(lon, lat, height),
            orientation: { heading: 0, pitch: -Math.PI / 2, roll: 0 },
          });
          const place = geo.cartographic.fromDegrees(lon, lat, 0);
          const started = performance.now();
          let loadedSince = null;
          // Tiles loaded for 1 s (bounded by settleMs).
          while (performance.now() - started < settleMs) {
            engine.render.request('qa-surface-heights');
            await new Promise((resolve) => setTimeout(resolve, 200));
            if (!engine.surface.tilesLoaded()) loadedSince = null;
            else if (loadedSince === null) loadedSince = performance.now();
            else if (performance.now() - loadedSince >= 1000) break;
          }
          return {
            settled: loadedSince !== null,
            ms: Math.round(performance.now() - started),
            detail: engine.surface.sampleHeightDetailed(place, { lod }) ?? null,
          };
        },
        { lon, lat, height, lod, settleMs: SETTLE_MS },
      );
    results.push(row);
    console.log(
      `[surface-heights] ${engine} ${name}: 800 m ${format(row.near)}; 15 km ${format(row.far)}`,
    );
  }
  await context.close();
  return { startup, results };
}

const format = ({ detail, settled }) =>
  detail
    ? `${detail.height.toFixed(2)} m ${detail.source}${
        detail.tileSizeM ? ` tile ${Math.round(detail.tileSizeM)} m` : ''
      }${settled ? '' : ' (unsettled)'}`
    : 'none';

const browser = await puppeteer.launch({
  headless: true,
  args: ['--use-angle=metal', '--ignore-gpu-blocklist'],
});
let failed = false;
try {
  const runs = {};
  for (const engine of ['cesium', 'navara'])
    runs[engine] = await runEngine(browser, engine);
  const summary = { near: 0, far: 0, floorTaken: 0, rows: [] };
  for (let i = 0; i < PLACES.length; i++) {
    const reference = runs.cesium.results[i].near.detail?.height;
    const navara = runs.navara.results[i];
    const diff = (entry) =>
      Number.isFinite(reference) && entry.detail
        ? entry.detail.height - reference
        : null;
    const near = diff(navara.near);
    const far = diff(navara.far);
    if (near !== null && Math.abs(near) <= TOLERANCE_M) summary.near++;
    if (far !== null && Math.abs(far) <= TOLERANCE_M) summary.far++;
    const size = navara.near.detail?.tileSizeM;
    if (
      navara.near.detail?.source === 'tiles' &&
      !(size > MAX_FLOOR_TILE_SIZE_M)
    )
      summary.floorTaken++;
    summary.rows.push({
      name: PLACES[i][0],
      cesium: reference ?? null,
      navaraNear: navara.near.detail,
      navaraFar: navara.far.detail,
      cesiumFar: runs.cesium.results[i].far.detail,
      diffNear: near,
      diffFar: far,
    });
    console.log(
      `[surface-heights] ${PLACES[i][0]}: Navara − Cesium ${
        near === null ? '—' : near.toFixed(2)
      } m at 800 m, ${far === null ? '—' : far.toFixed(2)} m at 15 km`,
    );
  }
  console.log(
    `[surface-heights] startup Austin: cesium ${JSON.stringify(runs.cesium.startup)}, navara ${JSON.stringify(runs.navara.startup)}`,
  );
  console.log(
    `[surface-heights] within ${TOLERANCE_M} m: ${summary.near}/20 at 800 m (gate ${GATES.near}), ${summary.far}/20 at 15 km finest (gate ${GATES.far}); floor rule takes ${summary.floorTaken}/20 Navara answers at 800 m`,
  );
  failed =
    summary.near < GATES.near ||
    summary.far < GATES.far ||
    !runs.navara.startup ||
    !runs.cesium.startup;
  if (outFile) {
    const file = path.resolve(repoRoot, outFile);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify({ runs, summary }, null, 2));
  }
} finally {
  await browser.close();
}
process.exit(failed ? 1 : 0);
