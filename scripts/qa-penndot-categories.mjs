#!/usr/bin/env node
/** Independent camera category acceptance. All metadata and frames are synthetic.
 * QA_BASE_URL selects a running app; QA_ARTIFACT_DIR optionally records review
 * screenshots and a short video. No public camera streams are acquired.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import puppeteer from 'puppeteer';

const origin = process.env.QA_BASE_URL || 'http://localhost:4173';
const artifacts = process.env.QA_ARTIFACT_DIR;
if (artifacts) fs.mkdirSync(artifacts, { recursive: true });
const common = {
  feedType: 'image',
  headingConfidence: 'unknown',
  groundElevationM: 0,
  headingDeg: 0,
  pitchDeg: -18,
  fovDeg: 60,
  rangeM: 150,
  mountHeightM: 8,
  city: 'West Chester, PA',
  cityId: 'west-chester-pa',
  provider: 'Synthetic camera fixture',
  credit: 'Generated test metadata and frames. No live camera footage.',
  license: 'Synthetic acceptance fixture.',
};
const general = [
  {
    id: 'chester-county-west-chester-high-st',
    name: 'Courthouse webcam (fixture)',
    lat: 39.95972,
    lon: -75.60472,
  },
  {
    id: 'pa-king-of-prussia-the-alloy',
    name: 'The Alloy webcam (fixture)',
    lat: 40.09133,
    lon: -75.36937,
  },
  {
    id: 'pa-philadelphia-international-airport',
    name: 'Airport webcam (fixture)',
    lat: 39.87208,
    lon: -75.24066,
  },
  {
    id: 'pa-bounce-malvern-court-1',
    name: 'Bounce Court 1 (fixture)',
    lat: 40.04461,
    lon: -75.52444,
  },
].map((camera) => ({ ...common, ...camera, sourceKind: 'public-webcam' }));
const penndot = [
  {
    id: '511pa-fixture-202',
    name: 'US-202 @ West Chester Pike (fixture)',
    lat: 39.9672,
    lon: -75.5815,
  },
  {
    id: '511pa-fixture-30',
    name: 'US-30 @ PA-100 (fixture)',
    lat: 40.0201,
    lon: -75.6412,
  },
  {
    id: '511pa-fixture-100',
    name: 'PA-100 @ Exton (fixture)',
    lat: 40.0341,
    lon: -75.6333,
  },
].map((camera) => ({
  ...common,
  ...camera,
  sourceKind: '511pa-public-camera',
  provider: 'PennDOT / 511PA — synthetic fixture',
}));
const sources = [...general, ...penndot];
const browser = await puppeteer.launch({
  headless: true,
  args:
    process.platform === 'darwin'
      ? ['--use-angle=metal', '--enable-gpu']
      : ['--use-gl=angle', '--use-angle=swiftshader'],
});
let recorder;
try {
  const page = await browser.newPage();
  await page.setViewport({ width: 1440, height: 900 });
  await page.evaluateOnNewDocument(() =>
    localStorage.setItem('gev:first-run-mission:v1', 'suppressed'),
  );
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.setRequestInterception(true);
  page.on('request', (request) => {
    const url = new URL(request.url());
    if (url.origin !== origin) return void request.continue();
    const json = (body) =>
      request.respond({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(body),
      });
    if (url.pathname === '/api/cctv/sources') return void json({ sources });
    if (url.pathname === '/api/cctv/health') return void json({ cameras: [] });
    if (url.pathname.startsWith('/api/cctv/frame/'))
      return void request.respond({
        status: 200,
        contentType: 'image/svg+xml',
        headers: { 'X-CCTV-Source': 'upstream-image' },
        body: '<svg xmlns="http://www.w3.org/2000/svg" width="640" height="360"><rect width="640" height="360" fill="#254b32"/><text x="320" y="160" text-anchor="middle" fill="white" font-family="sans-serif" font-size="28">SYNTHETIC CAMERA FIXTURE</text><text x="320" y="205" text-anchor="middle" fill="white" font-family="sans-serif" font-size="20">No live camera footage</text></svg>',
      });
    if (url.pathname === '/api/terrain/heights')
      return void json({
        results: (url.searchParams.get('points') || '')
          .split(';')
          .filter(Boolean)
          .map((point) => {
            const [lon, lat] = point.split(',').map(Number);
            return { lon, lat, elevation: 0, geoid: 0, ellipsoid: 0 };
          }),
      });
    if (
      url.pathname.startsWith('/api/openai/') ||
      url.pathname.startsWith('/api/gemini/')
    )
      return void json({
        summary: 'Synthetic camera category acceptance fixture.',
      });
    void request.continue();
  });
  await page.goto(
    `${origin}/?welcome=0#v=2&lat=39.98&lon=-75.58&alt=50000&pitch=-90&style=normal&l=`,
    { waitUntil: 'domcontentloaded', timeout: 60000 },
  );
  await page.waitForFunction(
    () =>
      window.__godsEyeView?.styleManager?._cctvControls &&
      document.getElementById('loading-screen')?.classList.contains('hidden'),
    { timeout: 60000 },
  );
  await page.$eval('[data-collapse-target="data-panel"]', (button) =>
    button.click(),
  );
  await page.$eval('[data-collapse-target="cctv-panel"]', (button) =>
    button.click(),
  );
  const row = (id) => `[data-layer-id="${id}"] .data-toggle-btn`;
  assert.match(
    await page.$eval(
      '[data-layer-id="penndot-traffic-cams"] .data-name',
      (node) => node.textContent,
    ),
    /PennDOT Traffic Cams/,
  );
  const toggle = async (id, on) => {
    console.log(`Toggle ${id}: ${on}`);
    await page.$eval(row(id), (button) => button.click());
    await page.waitForFunction(
      ({ id, on }) => window.__godsEyeView.dataManager.isEnabled(id) === on,
      { timeout: 30000 },
      { id, on },
    );
    console.log(`Toggled ${id}: ${on}`);
  };
  const state = () =>
    page.evaluate(() => {
      const app = window.__godsEyeView;
      const view = app.styleManager._cctvControls.cctv.getUIState();
      return {
        general: app.dataManager.isEnabled('cctv'),
        penndot: app.dataManager.isEnabled('penndot-traffic-cams'),
        ids: view.cameras.map((c) => c.id).sort(),
        active: view.activeCameraId,
        count: view.count,
      };
    });
  const hold = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const selectPennDot = async () => {
    await page.$eval('#cctv-camera-select', (select) => select.blur());
    await page.waitForFunction(() =>
      [...document.querySelector('#cctv-camera-select').options].some(
        (option) => option.value.startsWith('511pa-'),
      ),
    );
    const id = await page.$eval(
      '#cctv-camera-select',
      (select) =>
        [...select.options].find((option) => option.value.startsWith('511pa-'))
          .value,
    );
    await page.select('#cctv-camera-select', id);
    await page.$eval('#cctv-camera-select', (select) => select.blur());
    await page.waitForFunction(
      (id) =>
        window.__godsEyeView.styleManager._cctvControls.cctv.getUIState()
          .activeCameraId === id,
      {},
      id,
    );
  };
  const started = Date.now();
  if (artifacts)
    recorder = await page.screencast({
      path: path.join(artifacts, 'penndot-camera-categories.mp4'),
      format: 'mp4',
      fps: 8,
      scale: 0.8,
      ffmpegPath: process.env.QA_FFMPEG_PATH,
    });
  await toggle('cctv', true);
  assert.deepEqual((await state()).ids, general.map((c) => c.id).sort());
  await hold(1800);
  if (artifacts)
    await page.screenshot({
      path: path.join(artifacts, 'cameras-general-only.png'),
    });
  await toggle('penndot-traffic-cams', true);
  assert.equal((await state()).count, 7);
  await hold(1800);
  await toggle('cctv', false);
  assert.deepEqual((await state()).ids, penndot.map((c) => c.id).sort());
  await selectPennDot();
  await hold(2200);
  assert.equal(
    (await state()).general,
    false,
    'using the viewer must not turn general cameras back on',
  );
  await page.evaluate(() => {
    const camera = window.__godsEyeView.viewer.camera;
    camera.setView({
      destination: camera.position.constructor.fromDegrees(
        -75.58,
        39.98,
        50000,
      ),
      orientation: { heading: 0, pitch: -Math.PI / 2, roll: 0 },
    });
  });
  await hold(800);
  if (artifacts)
    await page.screenshot({
      path: path.join(artifacts, 'penndot-traffic-cams.png'),
    });
  await toggle('cctv', true);
  assert.equal((await state()).count, 7);
  await hold(1800);
  await toggle('penndot-traffic-cams', false);
  const disabled = await state();
  assert.deepEqual(disabled.ids, general.map((c) => c.id).sort());
  assert.equal(
    disabled.active,
    null,
    'turning a category off releases its selected feed',
  );
  await hold(1800);
  await toggle('penndot-traffic-cams', true);
  await selectPennDot();
  await hold(1800);
  await page.click('#cctv-enable-btn');
  await page.waitForFunction(
    () =>
      !window.__godsEyeView.dataManager.isEnabled('cctv') &&
      !window.__godsEyeView.dataManager.isEnabled('penndot-traffic-cams'),
  );
  assert.equal(
    (await state()).count,
    0,
    'the shared viewer OFF button disables both categories',
  );
  assert.deepEqual(errors, []);
  if (recorder) {
    await hold(Math.max(0, 18000 - (Date.now() - started)));
    await recorder.stop();
    recorder = null;
  }
  console.log(
    'PASS: independent toggles, manual webcam membership, shared viewer selection, category-off release and shared OFF.',
  );
} finally {
  try {
    await recorder?.stop();
  } finally {
    await browser.close();
  }
}
