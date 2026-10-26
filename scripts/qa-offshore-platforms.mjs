#!/usr/bin/env node
/** Keyless browser gate: real bundled BSEE data, native selection, budgets, share restoration and teardown.
 * Run with a dev server: node scripts/qa-offshore-platforms.mjs --url http://localhost:4173
 * Optional --record uses FFMPEG_PATH and writes a short MP4 alongside the screenshots.
 */
import puppeteer from 'puppeteer';
import fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
const arg = process.argv.indexOf('--url');
const url = arg >= 0 ? process.argv[arg + 1] : 'http://localhost:4173';
const shots = process.env.QA_SHOTS_DIR || 'qa-shots/offshore-platforms';
await fs.mkdir(shots, { recursive: true });
const browser = await puppeteer.launch({
  headless: true,
  executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || undefined,
  args: [
    '--no-sandbox',
    '--disable-background-timer-throttling',
    '--disable-renderer-backgrounding',
  ],
  defaultViewport: { width: 1440, height: 900 },
});
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
let recording;
const results = [];
function check(name, value, detail) {
  results.push({ name, pass: !!value, detail });
  console.log(`${value ? 'PASS' : 'FAIL'} ${name}`, detail || '');
  assert(value, name);
}
try {
  const page = await browser.newPage();
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  const requests = [];
  page.on('request', (request) => {
    if (request.url().includes('platforms.json')) requests.push(request.url());
  });
  await page.goto(`${url}/?welcome=0`, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(
    () =>
      window.__godsEyeView?.dataManager &&
      document.querySelector('#loading-screen.hidden'),
    { timeout: 90000 },
  );
  check(
    'default off with no inventory fetch',
    (await page.evaluate(
      () => !window.__godsEyeView.dataManager.isEnabled('offshore-platforms'),
    )) && requests.length === 0,
  );
  await page.evaluate(async () => {
    const { viewer, dataManager } = window.__godsEyeView;
    for (const [id, entry] of dataManager.layers)
      if (entry.enabled) await dataManager.setEnabled(id, false);
    const C = await import('/node_modules/cesium/Build/Cesium/index.js');
    viewer.camera.cancelFlight();
    viewer.camera.setView({
      destination: C.Cartesian3.fromDegrees(-91, 27.8, 4_000_000),
      orientation: { heading: 0, pitch: -Math.PI / 2, roll: 0 },
    });
    viewer.scene.requestRender();
  });
  await page.click('[data-collapse-target="data-panel"]');
  const toggle = '[data-layer-id="offshore-platforms"] .data-toggle-btn';
  await page.$eval(toggle, (node) => node.scrollIntoView({ block: 'center' }));
  if (process.argv.includes('--record')) {
    recording = await page.screencast({
      path: path.join(shots, 'offshore-platforms.mp4'),
      format: 'mp4',
      fps: 15,
      ffmpegPath: process.env.FFMPEG_PATH,
    });
  }
  await wait(2000);
  await page.click(toggle);
  await page.waitForFunction(
    () =>
      window.__godsEyeView.dataManager.layers
        .get('offshore-platforms')
        .module.getLodDiagnostics().active > 0,
    { timeout: 30000 },
  );
  const read = () =>
    page.evaluate(() => {
      const layer =
        window.__godsEyeView.dataManager.layers.get(
          'offshore-platforms',
        ).module;
      return {
        stats: layer.getStats(),
        lod: layer.getLodDiagnostics(),
        controls: layer.getRowControls(),
      };
    });
  let state = await read();
  check(
    'real snapshot loaded with bounded global entities',
    state.stats.count === 1542 &&
      state.lod.active > 0 &&
      state.lod.active <= 80 &&
      state.lod.materialized === state.lod.active,
    state,
  );
  check(
    'coverage, date and production uncertainty visible in the panel',
    await page.$eval(
      '[data-layer-id="offshore-platforms"]',
      (node) =>
        node.textContent.includes('production status unknown') &&
        node.textContent.includes('U.S. Gulf') &&
        node.textContent.includes('2026-10-01'),
    ),
  );
  check(
    'local snapshot only',
    requests.length === 1 && requests[0].startsWith(url),
  );
  await page.screenshot({ path: path.join(shots, 'layer-panel.png') });
  await page.click('[data-collapse-target="data-panel"]');
  await wait(1200);
  await page.screenshot({ path: path.join(shots, 'gulf-overview.png') });
  await page.evaluate(async () => {
    const C = await import('/node_modules/cesium/Build/Cesium/index.js');
    window.__godsEyeView.viewer.camera.flyTo({
      destination: C.Cartesian3.fromDegrees(-90.2, 28.5, 180000),
      duration: 3,
      orientation: { heading: 0, pitch: -Math.PI / 2, roll: 0 },
    });
  });
  await wait(5000);
  state = await read();
  check(
    'regional materialization stays bounded',
    state.lod.active > 0 &&
      state.lod.materialized <= 420 &&
      state.lod.budgetLimit === 420,
    state.lod,
  );
  const point = await page.evaluate(async () => {
    const C = await import('/node_modules/cesium/Build/Cesium/index.js');
    const { viewer } = window.__godsEyeView;
    const ds = viewer.dataSources.getByName('offshore-platforms')[0];
    for (const entity of ds.entities.values) {
      const p = C.SceneTransforms.worldToWindowCoordinates(
        viewer.scene,
        entity.position.getValue(viewer.clock.currentTime),
      );
      if (p && p.x > 450 && p.x < 1000 && p.y > 250 && p.y < 650)
        return { x: p.x, y: p.y, id: entity.id };
    }
    return null;
  });
  assert(point, 'a visible pick target is required');
  await page.mouse.click(point.x, point.y);
  await wait(2500);
  check(
    'native click selects the platform context',
    await page.evaluate(() =>
      window.__gevContextStore?.selectedEntityId?.startsWith(
        'offshore-platforms:',
      ),
    ),
  );
  check(
    'selected card exposes accessible source action',
    (await page.$('[aria-label="Open BSEE platform inventory source"]')) !==
      null,
  );
  await page.screenshot({ path: path.join(shots, 'platform-selection.png') });
  const cardRect = await page.evaluate(async () => {
    const { getOverlayPaintRect } =
      await import('/src/overlays/worldOverlay.js');
    const entity = window.__godsEyeView.viewer.selectedEntity;
    const id = entity.__offshoreRecord.id;
    const rect = getOverlayPaintRect('offshore-platforms-selection', id);
    window.__offshoreOpened = [];
    window.open = (url) => window.__offshoreOpened.push(url);
    return {
      x: rect.x + rect.w / 2,
      y: rect.y + rect.h / 2,
      duplicate: !!getOverlayPaintRect('offshore-platforms', id),
    };
  });
  check(
    'selected record has one card, without an ambient duplicate',
    !cardRect.duplicate,
  );
  await page.mouse.click(cardRect.x, cardRect.y);
  check(
    'painted source action opens the BSEE catalog',
    await page.evaluate(
      () =>
        window.__offshoreOpened[0] ===
        'https://www.data.bsee.gov/Main/Mapping.aspx',
    ),
  );

  await wait(2500);
  const stability = await page.evaluate(async () => {
    const { viewer, dataManager } = window.__godsEyeView;
    const ids = () =>
      viewer.dataSources
        .getByName('offshore-platforms')[0]
        .entities.values.map((entity) => entity.id)
        .sort();
    const before = ids();
    let frames = 0;
    const off = viewer.scene.postRender.addEventListener(() => frames++);
    await new Promise((r) => setTimeout(r, 2000));
    off();
    return { before, after: ids(), frames };
  });
  check(
    'parked camera does not churn the materialized cohort',
    JSON.stringify(stability.before) === JSON.stringify(stability.after),
    { count: stability.before.length, frames: stability.frames },
  );
  await page.evaluate(() =>
    window.__godsEyeView.dataManager.setEnabled('offshore-platforms', false),
  );
  check(
    'disable releases native targets and selection',
    await page.evaluate(
      () =>
        window.__godsEyeView.viewer.dataSources.getByName('offshore-platforms')
          .length === 0 &&
        ![...window.__gevContextStore.entities.values()].some(
          (r) => r.layerId === 'offshore-platforms',
        ),
    ),
  );
  await wait(2000);
  if (recording) {
    await recording.stop();
    recording = null;
  }
  await page.evaluate(() =>
    window.__godsEyeView.dataManager.setEnabled('offshore-platforms', true),
  );
  check('re-enable uses cached data', requests.length === 1);
  const restored = await browser.newPage();
  await restored.goto(`${url}/?welcome=0&v=2&l=5`, {
    waitUntil: 'domcontentloaded',
  });
  await restored.waitForFunction(
    () =>
      window.__godsEyeView?.dataManager.layers
        .get('offshore-platforms')
        ?.module.getStats().count > 0,
    { timeout: 90000 },
  );
  check(
    'share token restores the inventory layer',
    await restored.evaluate(() =>
      window.__godsEyeView.dataManager.isEnabled('offshore-platforms'),
    ),
  );
  await restored.close();
  check('no uncaught application errors', errors.length === 0, errors);
} finally {
  if (recording) await recording.stop();
  await browser.close();
  await fs.writeFile(
    path.join(shots, 'results.json'),
    JSON.stringify(results, null, 2) + '\n',
  );
}
console.log(`RESULT: ${results.length} passed, 0 failed`);
