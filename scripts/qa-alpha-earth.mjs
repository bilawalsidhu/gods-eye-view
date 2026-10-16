#!/usr/bin/env node
/**
 * Rendered acceptance for DATA ▸ AlphaEarth Change against the real Source
 * Cooperative mirror: the rail panel, the year list, a box over a known
 * change (Giga Texas, built 2020–2022) against a settled neighbourhood, the
 * drape on its host, a threshold move that makes no request, an oversized
 * view refused with its size, CLEAR, and disable.
 *
 * Run: start the app (`./scripts/dev-fresh.sh`) and
 *   node scripts/qa-alpha-earth.mjs
 * Env: QA_BASE_URL (default http://localhost:4173), QA_SHOT_DIR (default
 * qa-shots/alpha-earth), QA_HEADFUL=1. A cold comparison reads tens of
 * megabytes upstream, so each one may take up to two minutes. Every wait is
 * bounded. Without access to the mirror the run skips with code 0.
 */
import fs from 'node:fs';
import path from 'node:path';
import puppeteer from 'puppeteer';
import { chromeExecutablePath } from './qa-chrome.mjs';

const BASE_URL = process.env.QA_BASE_URL || 'http://localhost:4173';
const SHOT_DIR = process.env.QA_SHOT_DIR || 'qa-shots/alpha-earth';
const HEADFUL = process.env.QA_HEADFUL === '1';
const STEP_TIMEOUT = 20_000;
const COMPARE_TIMEOUT = 150_000;
const PANEL = '#alpha-earth-panel';
const CHANGED = { west: -97.64, south: 30.21, east: -97.6, north: 30.24 };
const SETTLED = { west: -97.74, south: 30.3, east: -97.72, north: 30.315 };
const YEARS = { from: 2018, to: 2024 };

async function networkAvailable() {
  try {
    const response = await fetch(
      'https://data.source.coop/tge-labs/aef/v1/annual/aef_index.parquet',
      { method: 'HEAD', signal: AbortSignal.timeout(8_000) },
    );
    return response.ok;
  } catch {
    return false;
  }
}

if (!(await networkAvailable())) {
  console.log(
    'SKIP: data.source.coop is unreachable — the live AlphaEarth gate needs network access.',
  );
  process.exit(0);
}

const browser = await puppeteer.launch({
  headless: !HEADFUL,
  ...(HEADFUL ? { executablePath: chromeExecutablePath() } : {}),
  args: [
    '--no-sandbox',
    '--disable-background-timer-throttling',
    '--disable-renderer-backgrounding',
    ...(HEADFUL ? ['--window-size=1280,860'] : []),
    ...(process.platform === 'darwin'
      ? ['--use-angle=metal', '--enable-gpu']
      : ['--use-gl=angle', '--use-angle=swiftshader']),
  ],
});
const page = await browser.newPage();
const errors = [];
page.on('pageerror', (error) => errors.push(`pageerror: ${error.message}`));
const requests = [];
page.on('request', (request) => {
  if (request.url().includes('/api/alpha-earth/change'))
    requests.push(request.url());
});
let failures = 0;
let checks = 0;
function check(name, passed, detail = '') {
  checks += 1;
  console.log(
    `[${passed ? 'PASS' : 'FAIL'}] ${name}${detail ? ` — ${detail}` : ''}`,
  );
  if (!passed) failures++;
}
fs.mkdirSync(SHOT_DIR, { recursive: true });
const shots = [];
const shot = async (name) => {
  const file = path.join(SHOT_DIR, `${name}.jpg`);
  await page.screenshot({ path: file, type: 'jpeg', quality: 82 });
  shots.push(file);
};

/** Poll a page predicate; false on timeout instead of throwing. */
async function until(fn, arg, timeout = STEP_TIMEOUT) {
  try {
    await page.waitForFunction(fn, { timeout, polling: 250 }, arg);
    return true;
  } catch {
    return false;
  }
}

const click = (selector) =>
  page.evaluate((target) => {
    const button = document.querySelector(target);
    if (!button || button.disabled || button.hidden) return false;
    button.click();
    return true;
  }, selector);

const snap = () =>
  page.evaluate(() => {
    const layer = window.__gevAlphaEarth.layer;
    const snapshot = layer.getSnapshot();
    return {
      ...snapshot,
      diagnostics: layer.diagnostics(),
      panelHidden: document.getElementById('alpha-earth-panel')?.hidden,
      count:
        document.getElementById('alpha-earth-panel-count')?.textContent || '',
    };
  });

/** Put the camera straight down over a point at a height, no flight. */
const setView = (view) =>
  page.evaluate((target) => {
    const viewer = window.__godsEyeView.viewer;
    viewer.camera.cancelFlight?.();
    viewer.camera.setView({
      destination: viewer.scene.globe.ellipsoid.cartographicToCartesian({
        longitude: (target.lon * Math.PI) / 180,
        latitude: (target.lat * Math.PI) / 180,
        height: target.height,
      }),
      orientation: { heading: 0, pitch: -Math.PI / 2, roll: 0 },
    });
    viewer.scene.requestRender();
  }, view);

/** Compare a box for the QA years; resolves to the settled snapshot. */
async function compare(box) {
  await page.evaluate(
    ({ box, years }) => {
      const layer = window.__gevAlphaEarth.layer;
      layer.setYears(years.from, years.to);
      layer.setBox(box);
    },
    { box, years: YEARS },
  );
  await until(
    () => {
      const status = window.__gevAlphaEarth.layer.getSnapshot().status;
      return status === 'ready' || status === 'error';
    },
    null,
    COMPARE_TIMEOUT,
  );
  return snap();
}

try {
  await page.setViewport({ width: 1280, height: 860 });
  await page.goto(`${BASE_URL}/?welcome=0`, { waitUntil: 'domcontentloaded' });
  const booted = await until(
    () =>
      window.__gevAlphaEarth &&
      window.__godsEyeView &&
      document.getElementById('loading-screen')?.classList.contains('hidden'),
    null,
    90_000,
  );
  check('the app boots with the AlphaEarth handle', booted);
  if (!booted) throw new Error('boot timeout');
  await setView({ lon: -97.62, lat: 30.225, height: 12_000 });

  // ── enable: the panel in the rail and the year list ───────────────────
  check(
    'the data panel carries an AlphaEarth Change toggle',
    await click('[data-layer-id="alpha-earth-change"] .data-toggle-btn'),
  );
  check(
    'the layer enables from its toggle',
    await until(() =>
      window.__godsEyeView.dataManager.isEnabled('alpha-earth-change'),
    ),
  );
  check(
    'the panel appears on the right rail once enabled',
    await until(
      () => document.getElementById('alpha-earth-panel')?.hidden === false,
    ),
  );
  const listed = await until(
    () => window.__gevAlphaEarth.layer.getSnapshot().years.length >= 2,
    null,
    60_000,
  );
  let current = await snap();
  check(
    'the mirror lists the published years',
    listed && current.years.includes(YEARS.from) && current.years.includes(YEARS.to),
    `years=${current.years.join(',')} error=${current.yearsError}`,
  );

  // ── a known change against a settled neighbourhood ─────────────────────
  const changed = await compare(CHANGED);
  check(
    'a box over Giga Texas compares',
    changed.status === 'ready',
    `status=${changed.status} error=${changed.error}`,
  );
  check(
    'the change drapes one layer on its host',
    Boolean(changed.diagnostics.owned) && changed.diagnostics.host !== 'none',
    `owned=${JSON.stringify(changed.diagnostics.owned)} host=${changed.diagnostics.host}`,
  );
  check(
    'the panel header reads the changed share',
    /% CHANGED$/.test(changed.count),
    changed.count,
  );
  await shot('01-giga-texas');

  const before = requests.length;
  await page.evaluate(() => window.__gevAlphaEarth.layer.setThreshold(0.8));
  current = await snap();
  check(
    'a higher threshold shrinks the changed share without a request',
    requests.length === before &&
      current.result.changedFraction <= changed.result.changedFraction,
    `${changed.result.changedFraction} → ${current.result.changedFraction}, requests ${before} → ${requests.length}`,
  );
  await page.evaluate(() => window.__gevAlphaEarth.layer.setThreshold(0.35));

  const settled = await compare(SETTLED);
  check(
    'a settled neighbourhood compares',
    settled.status === 'ready',
    `status=${settled.status} error=${settled.error}`,
  );
  check(
    'construction changed more than a settled neighbourhood',
    changed.result?.stats?.meanChange > settled.result?.stats?.meanChange,
    `mean ${changed.result?.stats?.meanChange} vs ${settled.result?.stats?.meanChange}`,
  );
  await shot('02-settled');

  // ── refusals, CLEAR and disable ────────────────────────────────────────
  await setView({ lon: -97.74, lat: 30.27, height: 400_000 });
  await page.evaluate(() =>
    window.__gevAlphaEarth.layer.useCurrentView(window.__godsEyeView.viewer),
  );
  current = await snap();
  check(
    'a view over 100 km is refused with its size',
    /limit 100 km/.test(current.boxError || ''),
    current.boxError,
  );
  check('CLEAR is one click', await click(`${PANEL} .ae-actions .ae-btn:nth-child(3)`));
  current = await snap();
  check(
    'CLEAR takes the box and the drape away',
    current.box === null && current.diagnostics.owned === null,
  );
  await click('[data-layer-id="alpha-earth-change"] .data-toggle-btn');
  await until(
    () => !window.__godsEyeView.dataManager.isEnabled('alpha-earth-change'),
  );
  current = await snap();
  check('the panel hides when the layer is off', current.panelHidden === true);

  check(
    'no page errors during the run',
    errors.length === 0,
    errors.join(' | '),
  );
} catch (error) {
  check(
    'run completed',
    false,
    error?.stack || error?.message || String(error),
  );
} finally {
  await browser.close();
}
console.log(`shots: ${shots.join(', ')}`);
console.log(`RESULT: ${checks} checks, ${failures} failures`);
process.exitCode = failures ? 1 : 0;
