#!/usr/bin/env node
import { whenSettled, whenTilesLoaded } from './qa/ready.mjs';
/**
 * qa-vessel-datum.mjs — assertion harness for the AIS vessel vertical-datum
 * pass (docs/superpowers/specs/2026-07-27-vessel-datum-design.md).
 *
 * Drives the REAL app in headless Chromium against the LIVE AISStream feed
 * and asserts, per port:
 *   1. every vessel billboard is depth-test-free
 *      (disableDepthTestDistance === Infinity — locked principle #2), and
 *   2. near-port anchors sit at the SEA SURFACE, not the ellipsoid: median
 *      ellipsoidal height within the EGM96 band (N + 3 m lift):
 *      Rotterdam N ≈ +43.7 → ≈ +46.7 m, Houston N ≈ −28.4 → ≈ −25.4 m.
 *      (At the pre-fix ellipsoid datum both medians would be ≈ 0–3 m.)
 * Then captures a screenshot to the gitignored qa-shots/ as visual proof
 * (Rotterdam chevrons were fully sea-mesh-occluded before the fix).
 *
 * Usage:
 *   node scripts/qa-vessel-datum.mjs
 *   node scripts/qa-vessel-datum.mjs --ports rotterdam --url http://localhost:4173
 *   node scripts/qa-vessel-datum.mjs --engine navara --url 'http://localhost:PORT/?qaFeed=vessels:fixture'
 *
 * Both engines take the engine-neutral path, through window.__godsEyeView.engine
 * and the dev server's QA probe (layers.drawn: each chevron's drawn position
 * and depth-test flag); the vessels layer owns no Cesium billboards any more.
 * --engine cesium|navara puts ?engine= on the URL; without it, the app's
 * default engine.
 */
import { launchBrowser, closeBrowser } from './qa/browser.mjs';
import fs from 'node:fs';
import path from 'node:path';

const argv = process.argv.slice(2);
const getOpt = (name, dflt) => {
  const i = argv.indexOf(name);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : dflt;
};

const APP_URL = getOpt('--url', 'http://localhost:4173');
const PORT_KEYS = getOpt('--ports', 'rotterdam,houston').split(',').map((s) => s.trim()).filter(Boolean);
const OUT_DIR = getOpt('--out', 'qa-shots');
const ENGINE = getOpt('--engine', null);
const PAGE_URL = (() => {
  if (!ENGINE) return APP_URL;
  const url = new URL(APP_URL);
  url.searchParams.set('engine', ENGINE);
  return url.href;
})();

/**
 * Camera framings match qa-vessel-cards.mjs; heightBand is the expected
 * near-port anchor ellipsoidal height (N + VESSEL_LIFT_M, ±~7 m for N drift
 * across the port area + tolerance).
 */
const PORTS = {
  rotterdam: {
    lon: 4.05, lat: 51.93, height: 18000, heading: 0.3, pitch: -1.25,
    heightBand: [40, 54],
  },
  houston: {
    lon: -95.08, lat: 29.72, height: 16000, heading: 5.9, pitch: -1.3,
    heightBand: [-33, -18],
  },
};

/** Degrees of lat/lon around the port center counted as "near-port". */
const NEAR_DEG = 1.0;
/** Max billboards sampled for the depth-test sweep. */
const SAMPLE_CAP = 500;



/**
 * In-page probe on either engine (the QA probe): the chevrons the layer
 * draws, their depth-test flag and the ellipsoidal heights of those near the
 * port.
 */
async function probeVesselsEngine({ portLat, portLon, nearDeg, sampleCap }) {
  const gev = window.__godsEyeView;
  const drawn = gev?.layers?.drawn('ais-live-vessels');
  if (!drawn) return { error: 'vessels layer not drawn' };
  const geo = await import('/src/geo/index.js');
  const chevrons = drawn.chevrons;
  let depthFreeCount = 0;
  let depthTestedCount = 0;
  const nearHeights = [];
  const step = Math.max(1, Math.floor(chevrons.length / sampleCap));
  for (let i = 0; i < chevrons.length; i += step) {
    const row = chevrons[i];
    if (row.depthFree) depthFreeCount += 1;
    else depthTestedCount += 1;
    const carto = geo.cartographic.fromCartesian(row.position);
    if (!carto) continue;
    const lat = geo.math.toDegrees(carto.latitude);
    const lon = geo.math.toDegrees(carto.longitude);
    if (Math.abs(lat - portLat) <= nearDeg && Math.abs(lon - portLon) <= nearDeg)
      nearHeights.push(carto.height);
  }
  nearHeights.sort((a, b) => a - b);
  const median = nearHeights.length ? nearHeights[Math.floor(nearHeights.length / 2)] : null;
  return {
    total: chevrons.length,
    sampled: depthFreeCount + depthTestedCount,
    depthFreeCount,
    depthTestedCount,
    nearCount: nearHeights.length,
    medianHeight: median,
    minHeight: nearHeights[0] ?? null,
    maxHeight: nearHeights[nearHeights.length - 1] ?? null,
  };
}

/** Frames a port through the engine (either engine). */
async function frameEngine(p, enable) {
  const geo = await import('/src/geo/index.js');
  const gev = window.__godsEyeView;
  gev.engine.camera.cancelFlight?.();
  gev.engine.camera.setView({
    destination: geo.cartesian3.fromDegrees(p.lon, p.lat, p.height),
    orientation: { heading: p.heading, pitch: p.pitch, roll: 0 },
  });
  if (enable) await gev.dataManager.setEnabled('ais-live-vessels', true);
  gev.engine.render.request('qa-vessel-datum');
}

async function main() {
  console.log(`\nAIS Vessel Datum — assertion harness`);
  console.log(`  App URL : ${APP_URL}`);
  console.log(`  Engine  : ${ENGINE ?? 'the app default'}`);
  console.log(`  Ports   : ${PORT_KEYS.join(', ')}\n`);

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
      console.log(`  ▸ ${key}`);

      const page = await browser.newPage();
      await page.setViewport({ width: 1600, height: 900 });
      page.on('pageerror', (err) => console.error(`    [page-error] ${err.message}`));

      await page.goto(PAGE_URL, { waitUntil: 'domcontentloaded', timeout: 60000 });
      await page.waitForFunction(() => !!window.__godsEyeView?.layers, { timeout: 180000 });

      // Frame the port (kill the intro flight first) and enable the layer.
      await page.evaluate(frameEngine, port, true);

      // Wait for rows + the geoid re-floor: poll until near-port anchors sit
      // inside the expected band (both ports' bands exclude the pre-fix 0–3 m
      // ellipsoid datum, so this only settles once the lift is applied).
      const probeArgs = { portLat: port.lat, portLon: port.lon, nearDeg: NEAR_DEG, sampleCap: SAMPLE_CAP };
      const deadline = Date.now() + 120000;
      let probe = null;
      let settled = false;
      while (Date.now() < deadline) {
        probe = await page.evaluate(probeVesselsEngine, probeArgs);
        if (probe && !probe.error && probe.nearCount >= 3
            && probe.medianHeight !== null
            && probe.medianHeight >= port.heightBand[0]
            && probe.medianHeight <= port.heightBand[1]) {
          settled = true;
          break;
        }
        await new Promise((r) => setTimeout(r, 2000));
      }

      const fmt = (v) => (v === null || v === undefined ? '—' : v.toFixed ? v.toFixed(1) : String(v));
      if (!probe || probe.error) {
        console.error(`    [\x1b[31mFAIL\x1b[0m] probe error: ${probe?.error || 'no probe result'}`);
        failures += 1;
      } else {
        const heightOk = settled;
        const depthOk = probe.depthTestedCount === 0 && probe.depthFreeCount > 0;
        console.log(
          `    vessels=${probe.total} sampled=${probe.sampled} nearPort=${probe.nearCount} ` +
          `medianH=${fmt(probe.medianHeight)}m (band ${port.heightBand[0]}..${port.heightBand[1]}) ` +
          `range=${fmt(probe.minHeight)}..${fmt(probe.maxHeight)}m`
        );
        console.log(
          `    [${depthOk ? '\x1b[32mPASS\x1b[0m' : '\x1b[31mFAIL\x1b[0m'}] ` +
          `depth-test-free sprites: ${probe.depthFreeCount}/${probe.sampled} (locked principle #2)`
        );
        console.log(
          `    [${heightOk ? '\x1b[32mPASS\x1b[0m' : '\x1b[31mFAIL\x1b[0m'}] ` +
          `sea-surface anchor datum (N + lift, locked principle #1)`
        );
        if (!depthOk) failures += 1;
        if (!heightOk) failures += 1;
      }

      // Visual proof — re-assert the framing (the app's intro flight can land
      // mid-probe on slow runs), wait for the photoreal tileset, screenshot.
      await page.evaluate(frameEngine, port, false);
      await whenTilesLoaded(page, { timeoutMs: 60000 })
        .catch(() => console.log('    (tileset settle timeout — screenshotting anyway)'));
      await whenSettled(page);
      const outPath = path.join(OUT_DIR, `vessel-datum-${ENGINE ? `${ENGINE}-` : ''}${key}.png`);
      await page.screenshot({ path: outPath });
      console.log(`    [SHOT] ${outPath}`);
      await page.close();
    }
  } finally {
    await closeBrowser(browser);
  }

  console.log(failures ? `\n\x1b[31m${failures} failure(s)\x1b[0m` : '\n\x1b[32mAll datum checks passed\x1b[0m');
  process.exit(failures ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
