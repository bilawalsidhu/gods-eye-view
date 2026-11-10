#!/usr/bin/env node
import { evaluateWithGeo } from './qa/geometry.mjs';
import { whenFramesDrawn } from './qa/ready.mjs';
/**
 * qa-vessel-cards.mjs — operator-side visual proof harness for AIS cards in
 * the shared world-overlay host.
 *
 * Drives the REAL app in headless Chromium, frames a busy port, waits for the
 * photoreal tileset + vessel refresh to settle, and captures a full-viewport
 * screenshot to the gitignored qa-shots/. Live AISStream data remains the
 * default. An explicit synthetic mode uses the layer's dev-only evidence seam
 * to exercise the production reconciliation/render path when AISStream is open
 * but silent (https://github.com/aisstream/aisstream/issues/23 and
 * https://github.com/aisstream/aisstream/issues/15).
 *
 * Usage:
 *   node scripts/qa-vessel-cards.mjs --tag new              # current code
 *   node scripts/qa-vessel-cards.mjs --tag old              # from a checkout of the comparison revision
 *   node scripts/qa-vessel-cards.mjs --ports rotterdam      # subset
 *   node scripts/qa-vessel-cards.mjs --url http://localhost:4173
 *   node scripts/qa-vessel-cards.mjs --data synthetic       # deterministic test fixture
 *   node scripts/qa-vessel-cards.mjs --data synthetic --headful  # real-GPU capture
 *
 * A/B flow: run each accepted revision from a separate checkout, using the
 * same source configuration and camera fixtures with distinct --tag values.
 * Retained screenshots and same-basename JSON manifests land at
 * qa-shots/vessel-cards-<live-aisstream|synthetic-fixture>-<tag>-<port>.*.
 * The name and manifest both record the data source; the manifest also records
 * headless/headful launch mode and the browser's WebGL renderer.
 */
import { launchBrowser, closeBrowser } from './qa/browser.mjs';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const argv = process.argv.slice(2);
const getOpt = (name, dflt) => {
  const i = argv.indexOf(name);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : dflt;
};

const APP_URL = getOpt('--url', 'http://localhost:4173');
// --engine cesium|navara: frame, settle and read the renderer
// through window.__godsEyeView.engine (either engine) instead of the Cesium
// viewer; the URL gets ?engine=. Without it, as before.
const ENGINE = getOpt('--engine', null);
const PAGE_URL = (() => {
  if (!ENGINE) return APP_URL;
  const url = new URL(APP_URL);
  url.searchParams.set('engine', ENGINE);
  return url.href;
})();
const TAG = getOpt('--tag', 'new');
const PORT_KEYS = getOpt('--ports', 'rotterdam,houston').split(',').map((s) => s.trim()).filter(Boolean);
const OUT_DIR = getOpt('--out', 'qa-shots');
export function isHeadfulMode(args = []) {
  return args.includes('--headful');
}

const HEADFUL = isHeadfulMode(argv);
export const DEFAULT_DATA_MODE = 'live';

const DATA_PROVENANCE_SLUGS = Object.freeze({
  live: 'live-aisstream',
  synthetic: 'synthetic-fixture',
});

/** Parse the explicit evidence-source mode, defaulting to the live feed. */
export function parseDataMode(args = []) {
  const index = args.indexOf('--data');
  const mode = index >= 0 && args[index + 1] ? args[index + 1] : DEFAULT_DATA_MODE;
  if (!Object.hasOwn(DATA_PROVENANCE_SLUGS, mode)) {
    throw new Error(`Unknown --data mode '${mode}' (have: live, synthetic)`);
  }
  return mode;
}

/** A synthetic card capture owns its source instead of competing with qaFeed. */
export function vesselCardCaptureUrl(pageUrl, dataMode) {
  const url = new URL(pageUrl);
  if (dataMode === 'synthetic') url.searchParams.delete('qaFeed');
  return url.href;
}

/** Install before navigation; every asynchronous refresh keeps the same rows. */
export function installSyntheticVesselFeed(rows) {
  const realFetch = window.fetch.bind(window);
  window.fetch = (input, init) => {
    const url = new URL(
      typeof input === 'string' ? input : (input.url ?? input),
      location.href,
    );
    if (url.origin === location.origin && url.pathname === '/api/vessels') {
      const nowMs = Date.now();
      return Promise.resolve(
        new Response(
          JSON.stringify({
            rows: rows.map((row) => ({
              ...row,
              last_position_epoch: nowMs / 1000,
            })),
            newestPositionAt: nowMs,
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        ),
      );
    }
    return realFetch(input, init);
  };
}

/** Build a screenshot name whose data provenance cannot collide with another mode. */
export function vesselCardScreenshotFilename({ dataMode, tag, portKey }) {
  const provenanceSlug = DATA_PROVENANCE_SLUGS[dataMode];
  if (!provenanceSlug) throw new Error(`Unsupported vessel-card data mode '${dataMode}'`);
  return `vessel-cards-${provenanceSlug}-${tag}-${portKey}.png`;
}

/** Build the same-basename provenance manifest filename for one PNG. */
export function vesselCardManifestFilename(screenshotFilename) {
  if (!/\.png$/i.test(screenshotFilename)) {
    throw new Error(`Expected a PNG screenshot filename, received '${screenshotFilename}'`);
  }
  return screenshotFilename.replace(/\.png$/i, '.json');
}

/** True when renderer evidence is available and does not identify a software rasterizer. */
export function isHardwareRenderer(renderer = {}) {
  const description = `${renderer.vendor || ''} ${renderer.renderer || ''}`.trim();
  return Boolean(description)
    && !/(swiftshader|software|llvmpipe|unavailable|unknown)/i.test(description);
}

/** Human-readable provenance emitted before any screenshot is captured. */
export function vesselCardProvenanceLines(dataMode) {
  if (dataMode === 'live') {
    return ['[PROVENANCE] LIVE AISStream feed; no synthetic vessel rows are injected.'];
  }
  if (dataMode === 'synthetic') {
    return [
      '[PROVENANCE] SYNTHETIC FIXTURE; this is not evidence of live AISStream availability.',
      '[UPSTREAM] AISStream Issue #23: https://github.com/aisstream/aisstream/issues/23',
      '[UPSTREAM] AISStream Issue #15: https://github.com/aisstream/aisstream/issues/15',
    ];
  }
  throw new Error(`Unsupported vessel-card data mode '${dataMode}'`);
}

/** Build the provenance record retained beside one screenshot. */
export function buildVesselCardManifest({
  dataMode,
  tag,
  portKey,
  screenshot,
  headful,
  renderer,
  captureEvidence,
  appUrl,
  capturedAt,
}) {
  const provenanceSlug = DATA_PROVENANCE_SLUGS[dataMode];
  if (!provenanceSlug) throw new Error(`Unsupported vessel-card data mode '${dataMode}'`);
  return {
    schemaVersion: 1,
    screenshot,
    dataMode,
    provenance: provenanceSlug,
    source: dataMode === 'live' ? 'AISStream live feed' : 'GEV synthetic AIS fixture',
    liveAisStreamAvailabilityAsserted: dataMode === 'live',
    launchMode: headful ? 'headful' : 'headless',
    renderer,
    captureEvidence,
    tag,
    port: portKey,
    appUrl,
    capturedAt,
    upstreamContext: dataMode === 'synthetic' ? [
      'https://github.com/aisstream/aisstream/issues/23',
      'https://github.com/aisstream/aisstream/issues/15',
    ] : [],
  };
}

let DATA_MODE;

try {
  DATA_MODE = parseDataMode(argv);
} catch (error) {
  console.error(error.message);
  process.exit(2);
}

/** Busy-port camera framings (lon/lat deg, height m, heading/pitch rad). */
const PORTS = {
  rotterdam: { lon: 4.05, lat: 51.93, height: 18000, heading: 0.3, pitch: -1.25 },
  houston: { lon: -95.08, lat: 29.72, height: 16000, heading: 5.9, pitch: -1.3 },
};

const SYNTHETIC_OFFSETS = [
  [0, 0],
  [-0.055, -0.025],
  [-0.02, 0.045],
  [0.045, -0.04],
  [0.065, 0.03],
  [-0.08, 0.055],
  [0.01, -0.075],
  [0.09, -0.015],
];

function syntheticVesselRows(portKey, port) {
  const mmsiBase = portKey === 'rotterdam' ? 990100000 : 990200000;
  return SYNTHETIC_OFFSETS.map(([lonOffset, latOffset], index) => ({
    mmsi: String(mmsiBase + index),
    name: `QA ${portKey.toUpperCase()} ${String(index + 1).padStart(2, '0')}`,
    lat: port.lat + latOffset,
    lon: port.lon + lonOffset,
    speed: 3 + index,
    course: (25 + index * 41) % 360,
    heading: (25 + index * 41) % 360,
    type: index % 3 === 0 ? 'Cargo' : index % 3 === 1 ? 'Tug' : 'Tanker',
    destination: portKey.toUpperCase(),
  }));
}



async function main() {
  console.log(`\nAIS Vessel Cards — visual proof harness`);
  console.log(`  App URL : ${APP_URL}`);
  console.log(`  Tag     : ${TAG}`);
  console.log(`  Engine  : ${ENGINE ?? 'viewer (Cesium)'}`);
  console.log(`  Data    : ${DATA_MODE}`);
  console.log(`  Browser : ${HEADFUL ? 'headful (hardware renderer requested)' : 'headless (Metal)'}`);
  console.log(`  Ports   : ${PORT_KEYS.join(', ')}\n`);
  for (const line of vesselCardProvenanceLines(DATA_MODE)) console.log(`  ${line}`);
  console.log('');

  try {
    const res = await fetch(APP_URL, { method: 'GET' });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
  } catch (e) {
    console.error(`\x1b[31mDev server not reachable at ${APP_URL} (${e.message}).\x1b[0m`);
    console.error(`Start it first:  ./scripts/dev-fresh.sh`);
    process.exit(2);
  }

  fs.mkdirSync(OUT_DIR, { recursive: true });

  const browser = await launchBrowser({
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', '--disable-background-timer-throttling', '--disable-renderer-backgrounding', '--window-size=1600,900'],
  });

  let failures = 0;
  try {
    for (const key of PORT_KEYS) {
      const port = PORTS[key];
      if (!port) {
        console.error(`  [\x1b[31mFAIL\x1b[0m] unknown port '${key}' (have: ${Object.keys(PORTS).join(', ')})`);
        failures += 1;
        continue;
      }
      const outPath = path.join(OUT_DIR, vesselCardScreenshotFilename({
        dataMode: DATA_MODE,
        tag: TAG,
        portKey: key,
      }));
      console.log(`  ▸ ${key} → ${outPath}`);

      const syntheticRows = DATA_MODE === 'synthetic' ? syntheticVesselRows(key, port) : [];
      const captureUrl = vesselCardCaptureUrl(PAGE_URL, DATA_MODE);
      const page = await browser.newPage();
      await page.setViewport({ width: 1600, height: 900 });
      await page.evaluateOnNewDocument(() => {
        // This harness inspects cards, so keep first-run chrome out of the view.
        localStorage.setItem('gev:first-run-mission:v1', 'suppressed');
      });
      if (DATA_MODE === 'synthetic')
        await page.evaluateOnNewDocument(installSyntheticVesselFeed, syntheticRows);
      page.on('pageerror', (err) => console.error(`    [page-error] ${err.message}`));

      await page.goto(captureUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });
      if (ENGINE)
        await page.waitForFunction(() => !!window.__godsEyeView?.layers, { timeout: 180000 });
      else
        await page.waitForFunction(() => !!window.__godsEyeView?.engine, { timeout: 60000 });

      // Frame the port (kill the intro flight first) and enable the layer.
      const dataEvidence = await evaluateWithGeo(page, async (qaGeo, { p, dataMode, fixtureRows, engineNeutral }) => {
        const gev = window.__godsEyeView;
        if (engineNeutral) {
          const geo = await import('/src/geo/index.js');
          gev.engine.camera.cancelFlight?.();
          gev.engine.camera.setView({
            destination: geo.cartesian3.fromDegrees(p.lon, p.lat, p.height),
            orientation: { heading: p.heading, pitch: p.pitch, roll: 0 },
          });
        } else {
        window.__godsEyeView.engine.camera.cancelFlight?.();
        const carto = {
          longitude: (p.lon * Math.PI) / 180,
          latitude: (p.lat * Math.PI) / 180,
          height: p.height,
        };
        window.__godsEyeView.engine.camera.setView({
          destination: qaGeo.cartographic.toCartesian(carto),
          orientation: { heading: p.heading, pitch: p.pitch, roll: 0 },
        });
        }
        await gev.dataManager.setEnabled('ais-live-vessels', true);
        if (dataMode !== 'synthetic') return { mode: 'live', injected: 0 };
        const seam = gev.dataManager.layers.get('ais-live-vessels')?.module?.__focusEvidence;
        if (!seam?.setVessels) throw new Error('Synthetic AIS evidence seam is unavailable');
        const result = seam.setVessels(fixtureRows);
        if (!result?.ok || result.count !== fixtureRows.length) {
          throw new Error(`Synthetic AIS injection failed (${result?.count || 0}/${fixtureRows.length})`);
        }
        if (engineNeutral) gev.engine.render.request('qa-vessel-cards');
        else window.__godsEyeView.engine.render.request?.();
        return { mode: 'synthetic', injected: result.count };
      }, { p: port, dataMode: DATA_MODE, fixtureRows: syntheticRows, engineNeutral: Boolean(ENGINE) });
      console.log(
        `    [DATA] ${dataEvidence.mode}${dataEvidence.injected ? ` (${dataEvidence.injected} injected)` : ''}; `
        + `artifact provenance=${DATA_PROVENANCE_SLUGS[DATA_MODE]}`,
      );

      // Wait for the photoreal tileset and at least one vessel refresh.
      const settled = await page
        .waitForFunction((engineNeutral) => {
          const gev = window.__godsEyeView;
          const tilesLoaded = engineNeutral
            ? gev.engine.surface.tilesLoaded()
            : window.__godsEyeView.engine.surface.tilesLoaded();
          const ais = gev.dataManager.getAll().find((l) => l.id === 'ais-live-vessels');
          const count = ais?.stats?.count ?? 0;
          return tilesLoaded && count > 0;
        }, { timeout: 90000, polling: 500 }, Boolean(ENGINE))
        .then(() => true)
        .catch(() => false);

      // Re-assert the port framing: on slow (SwiftShader) runs the app's
      // intro flight can start AFTER the first cancelFlight and land mid-wait,
      // dragging the camera back to the boot city before the screenshot.
      await evaluateWithGeo(page, async (qaGeo, p, engineNeutral) => {
        const gev = window.__godsEyeView;
        if (engineNeutral) {
          const geo = await import('/src/geo/index.js');
          gev.engine.camera.cancelFlight?.();
          gev.engine.camera.setView({
            destination: geo.cartesian3.fromDegrees(p.lon, p.lat, p.height),
            orientation: { heading: p.heading, pitch: p.pitch, roll: 0 },
          });
        } else {
        window.__godsEyeView.engine.camera.cancelFlight?.();
        const carto = {
          longitude: (p.lon * Math.PI) / 180,
          latitude: (p.lat * Math.PI) / 180,
          height: p.height,
        };
        window.__godsEyeView.engine.camera.setView({
          destination: qaGeo.cartographic.toCartesian(carto),
          orientation: { heading: p.heading, pitch: p.pitch, roll: 0 },
        });
        }
      }, port, Boolean(ENGINE));
      // A changed camera invalidates the previous settled result. Let the new
      // view schedule its tiles before checking readiness again.
      await whenFramesDrawn(page);
      const resettled = await page
        .waitForFunction((engineNeutral) => {
          const gev = window.__godsEyeView;
          const ais = gev.dataManager.getAll().find((l) => l.id === 'ais-live-vessels');
          const tilesLoaded = engineNeutral
            ? gev.engine.surface.tilesLoaded()
            : window.__godsEyeView.engine.surface.tilesLoaded();
          return tilesLoaded && (ais?.stats?.count ?? 0) > 0;
        }, { timeout: 60000, polling: 500 }, Boolean(ENGINE))
        .then(() => true)
        .catch(() => false);

      // Let two visibility/declutter cycles (800 ms) and host rendering settle.
      await whenFramesDrawn(page);
      const expectedFixtureIds = syntheticRows.map((row) => row.mmsi);
      const overlayEvidence = await page.evaluate((fixtureIds, engineNeutral) => {
        const diagnostics = window.__gevWorldOverlay?.getDiagnostics?.();
        const canvas = window.__godsEyeView?.engine?.host?.canvas;
        const gl = engineNeutral
          ? canvas?.getContext('webgl2') || canvas?.getContext('webgl')
          : window.__godsEyeView.engine.host.canvas.getContext('webgl2');
        const debugInfo = gl?.getExtension?.('WEBGL_debug_renderer_info');
        const seam = window.__godsEyeView?.dataManager?.layers
          ?.get('ais-live-vessels')?.module?.__focusEvidence;
        const snapshotIds = new Set((seam?.snapshot?.() || []).map((record) => String(record.id)));
        return {
          hostCanvas: Boolean(document.getElementById('world-overlay-canvas')),
          legacyCanvas: Boolean(document.getElementById('vessel-labels')),
          entries: diagnostics?.entriesBySource?.['ais-live-vessels'] || 0,
          painted: diagnostics?.paintedBySource?.['ais-live-vessels'] || 0,
          fixtureRowsRetained: fixtureIds.length
            ? fixtureIds.every((id) => snapshotIds.has(String(id)))
            : null,
          renderer: gl ? {
            vendor: String(gl.getParameter(debugInfo?.UNMASKED_VENDOR_WEBGL || gl.VENDOR) || 'unknown'),
            renderer: String(gl.getParameter(debugInfo?.UNMASKED_RENDERER_WEBGL || gl.RENDERER) || 'unknown'),
          } : { vendor: 'unavailable', renderer: 'unavailable' },
        };
      }, expectedFixtureIds, Boolean(ENGINE));
      await page.screenshot({ path: outPath });
      const st = fs.statSync(outPath);
      const hardwareRenderer = isHardwareRenderer(overlayEvidence.renderer);
      const capturePassed = resettled
        && overlayEvidence.hostCanvas
        && !overlayEvidence.legacyCanvas
        && overlayEvidence.entries > 0
        && overlayEvidence.painted > 0
        && (DATA_MODE !== 'synthetic' || overlayEvidence.fixtureRowsRetained)
        && (!HEADFUL || hardwareRenderer);
      const manifestPath = path.join(OUT_DIR, vesselCardManifestFilename(path.basename(outPath)));
      const manifest = buildVesselCardManifest({
        dataMode: DATA_MODE,
        tag: TAG,
        portKey: key,
        screenshot: path.basename(outPath),
        headful: HEADFUL,
        renderer: overlayEvidence.renderer,
        captureEvidence: {
          tilesAndVesselsSettled: resettled,
          injectedRows: dataEvidence.injected,
          syntheticFixtureRowsRetained: overlayEvidence.fixtureRowsRetained,
          overlayEntries: overlayEvidence.entries,
          overlayPainted: overlayEvidence.painted,
          hostCanvas: overlayEvidence.hostCanvas,
          legacyCanvas: overlayEvidence.legacyCanvas,
          screenshotBytes: st.size,
          hardwareAccelerated: hardwareRenderer,
          passed: capturePassed,
        },
        appUrl: captureUrl,
        capturedAt: new Date().toISOString(),
      });
      fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
      const tiles = resettled ? 'tiles+vessels settled' : 'TIMEOUT waiting for tiles/vessels (shot anyway)';
      console.log(`    [\x1b[32mSHOT\x1b[0m] ${Math.round(st.size / 1024)} KB — ${tiles}`);
      console.log(`    [RENDERER] ${overlayEvidence.renderer.vendor} / ${overlayEvidence.renderer.renderer}`);
      console.log(`    [GPU] hardware accelerated=${hardwareRenderer}`);
      if (DATA_MODE === 'synthetic') {
        console.log(`    [FIXTURE] retained at capture=${overlayEvidence.fixtureRowsRetained}`);
      }
      console.log(`    [MANIFEST] ${manifestPath}`);
      console.log(`    [HOST] ${overlayEvidence.entries} entries / ${overlayEvidence.painted} painted`);
      if (!capturePassed) failures += 1;
      await page.close();
    }
  } finally {
    await closeBrowser(browser);
  }

  console.log('\nRetained PNG+JSON pairs are local QA evidence; each basename records live or synthetic provenance.');
  console.log(`\nRESULT: ${PORT_KEYS.length - failures} passed, ${failures} failed, 0 skipped`);
  process.exit(failures ? 1 : 0);
}

const invokedPath = process.argv[1] ? pathToFileURL(path.resolve(process.argv[1])).href : '';
if (import.meta.url === invokedPath) {
  main().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
