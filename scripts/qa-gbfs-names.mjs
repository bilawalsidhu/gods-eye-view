#!/usr/bin/env node
/**
 * Keyless station-name regression against the real globe and bike-share tool.
 * Run with a dev or QA preview server and an explicitly assigned --url.
 * --w2 adds raster checks that import source modules: dev server only.
 * GBFS documents are synthetic; no operator feed or provider key is required.
 */
import { whenSettled } from './qa/ready.mjs';
import { launchBrowser, closeBrowser } from './qa/browser.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import sharp from 'sharp';
import { fromDegrees } from '../src/geo/cartesian3.js';
import { watchBrowserPage, redact } from './qa-browserEvidence.mjs';

const urlIndex = process.argv.indexOf('--url');
if (urlIndex < 0) throw new Error('An explicit --url is required');
const appUrl = process.argv[urlIndex + 1];
const engineName = new URL(appUrl).searchParams.get('engine') || 'cesium';
const extended = process.argv.includes('--w2');
const reportIndex = process.argv.indexOf('--report');
const reportPath =
  reportIndex < 0 ? null : path.resolve(process.argv[reportIndex + 1]);
const shots = reportPath
  ? reportPath.replace(/\.json$/, '-shots')
  : path.resolve(`qa-shots/gbfs-names/${engineName}`);
fs.mkdirSync(shots, { recursive: true });
const report = { engine: engineName, checks: [], poses: {}, browserErrors: [] };
const information = {
  version: '3.0',
  data: {
    stations: [
      {
        station_id: 'english',
        name: [
          { language: 'hu', text: 'Magyar tér' },
          { language: 'en', text: 'QA English Square' },
        ],
      },
      {
        station_id: 'short',
        name: [null, { language: 'en', text: ' ' }],
        short_name: [{ language: 'en-GB', text: 'QA Short Name' }],
      },
      { station_id: 'unnamed', name: [null, {}, { language: 42, text: [] }] },
      { station_id: 'legacy', name: ' QA Legacy Station ' },
      {
        station_id: 'fallback',
        name: [null, { language: 'hu', text: 'QA Magyar Station' }],
      },
    ].map((station, index) => ({
      ...station,
      lat: 30.2681 + index * 0.001,
      lon: -97.7469 + index * 0.001,
      capacity: 13,
    })),
  },
};
const status = {
  data: {
    stations: information.data.stations.map(({ station_id }) => ({
      station_id,
      num_bikes_available: 4,
      num_docks_available: 9,
      is_renting: true,
      is_returning: true,
    })),
  },
};
const browser = await launchBrowser({
  headless: true,
  args: process.platform === 'darwin' ? [] : [],
});
let checks = 0;
const check = (name, actual, expected) => {
  report.checks.push({ name, actual, expected });
  assert.deepEqual(actual, expected, name);
  checks++;
  console.log(`[PASS] ${name}`);
};
async function open(mode = 'normal') {
  const page = await browser.newPage();
  await page.bringToFront();
  const errors = [];
  if (extended)
    watchBrowserPage(page, report, {
      name: mode,
      baseUrl: appUrl,
      preview: process.argv.includes('--preview'),
    });
  page.on('pageerror', (error) => errors.push(error.message));
  await page.setViewport({ width: 1440, height: 900 });
  await page.evaluateOnNewDocument(
    ({ information, status, mode }) => {
      localStorage.clear();
      localStorage.setItem('gev:first-run-mission:v1', 'suppressed');
      window.__qaPainted = [];
      const paint = CanvasRenderingContext2D.prototype.fillText;
      CanvasRenderingContext2D.prototype.fillText = function (text, ...args) {
        if (
          String(text).startsWith('QA ') ||
          String(text) === 'Station unnamed'
        ) {
          window.__qaPainted.push(String(text));
          if (window.__qaPainted.length > 100) window.__qaPainted.shift();
        }
        return paint.call(this, text, ...args);
      };
      const original = window.fetch.bind(window);
      window.fetch = async (input, init) => {
        const url = String(
          typeof input === 'string' || input instanceof URL ? input : input.url,
        );
        if (url.includes('/api/gbfs/')) {
          if (mode === 'failure') return new Response('{}', { status: 503 });
          const payload =
            mode === 'empty'
              ? { data: { stations: [] } }
              : decodeURIComponent(url).includes('station_information')
                ? information
                : status;
          return new Response(JSON.stringify(payload), {
            headers: { 'Content-Type': 'application/json' },
          });
        }
        if (url.includes('/api/flights')) return new Response('{"states":[]}');
        if (url.includes('/api/military')) return new Response('{"ac":[]}');
        if (url.includes('/api/vessels'))
          return new Response('{"connected":false,"vessels":[]}');
        return original(input, init);
      };
    },
    { information, status, mode },
  );
  await page.goto(appUrl, { waitUntil: 'domcontentloaded' });
  if (
    extended &&
    !(await page.evaluate(() =>
      Boolean(document.querySelector('script[src="/@vite/client"]')),
    ))
  )
    throw new Error('--w2 requires a Vite dev server; omit --w2 for preview');
  await page.waitForFunction(
    () =>
      window.__godsEyeView?.dataManager && window.__godsEyeView?.voiceCommands,
    { timeout: 60000 },
  );
  await whenSettled(page);
  await page.evaluate(
    async (destination) => {
      const { dataManager, engine } = window.__godsEyeView;
      await window.__godsEyeView.styleManager.initialRestorePromise;
      window.__godsEyeView.styleManager.orbitController.stop();
      for (const [id, layer] of dataManager.layers) {
        if (layer.enabled)
          await dataManager.setEnabled(id, false, { origin: 'user' });
      }
      engine.camera.cancelFlight();
      engine.camera.setView({
        destination,
        orientation: { heading: 0, pitch: -Math.PI / 2, roll: 0 },
      });
      await dataManager.setEnabled('bikeshare', true, { origin: 'user' });
      window.__godsEyeView.requestRender('gbfs-name-qa');
    },
    fromDegrees(-97.7449, 30.2701, 3000),
  );
  return { page, errors };
}

async function nextFrame(page) {
  await page.evaluate(
    () =>
      new Promise((resolve) => {
        const engine = window.__godsEyeView.engine;
        const remove = engine.frames.postRender.addEventListener(() => {
          remove();
          resolve();
        });
        engine.render.request('gbfs-raster-qa');
      }),
  );
}

async function settledTiles(page) {
  await page.evaluate(async () => {
    const engine = window.__godsEyeView.engine;
    const start = performance.now();
    let since = null;
    while (performance.now() - start < 90000) {
      if (engine.surface.tilesLoaded()) since ??= performance.now();
      else since = null;
      if (since !== null && performance.now() - since > 1500) return;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    throw new Error('Map tiles did not settle for raster sampling');
  });
}

async function w2Checks(page) {
  await page.evaluate(async () => {
    const app = window.__godsEyeView;
    const detection = await import('/src/data/detection.js');
    detection.setMode('OFF');
    const { appClock } = await import('/src/time/clock.js');
    appClock.freeze(Date.parse('2026-10-28T19:00:00Z'));
    const canvas = app.engine.host.canvas;
    const style = document.createElement('style');
    style.textContent =
      '.gbfs-raster-hidden { visibility: hidden !important; }';
    document.head.append(style);
    for (const element of document.body.querySelectorAll('*'))
      if (element !== canvas && !element.contains(canvas))
        element.classList.add('gbfs-raster-hidden');
  });
  for (const [name, height] of [
    ['city', 10000],
    ['close', 3000],
    ['global', 100000],
  ]) {
    await page.evaluate(
      async (destination) => {
        const app = window.__godsEyeView;
        await app.dataManager.setEnabled('bikeshare', false);
        app.engine.camera.setView({
          destination,
          orientation: { heading: 0, pitch: -Math.PI / 2, roll: 0 },
        });
      },
      fromDegrees(-97.7449, 30.2701, height),
    );
    await settledTiles(page);
    await nextFrame(page);
    const off = await page.screenshot({
      path: path.join(shots, `${name}-off.png`),
    });
    await page.evaluate(() =>
      window.__godsEyeView.dataManager.setEnabled('bikeshare', true),
    );
    await page.waitForFunction(
      (count) =>
        window.__godsEyeView.dataManager.layers
          .get('bikeshare')
          .module.getStats().count === count,
      {},
      name === 'global' ? 0 : 5,
    );
    await nextFrame(page);
    const controls = await page.evaluate(() => {
      const app = window.__godsEyeView;
      const rect = app.engine.host.canvas.getBoundingClientRect();
      return app.dataManager.layers
        .get('bikeshare')
        .module.getDetectableObjects()
        .map((record) => {
          const p = app.engine.projector.worldToWindow(record.position);
          return { id: record.sourceId, x: p.x + rect.left, y: p.y + rect.top };
        });
    });
    const on = await page.screenshot({
      path: path.join(shots, `${name}-on.png`),
    });
    const a = await sharp(off)
      .ensureAlpha()
      .raw()
      .toBuffer({ resolveWithObject: true });
    const b = await sharp(on).ensureAlpha().raw().toBuffer();
    for (const control of controls) {
      let pixels = 0;
      for (
        let y = Math.max(0, Math.floor(control.y) - 16);
        y < Math.min(a.info.height, control.y + 16);
        y++
      )
        for (
          let x = Math.max(0, Math.floor(control.x) - 16);
          x < Math.min(a.info.width, control.x + 16);
          x++
        ) {
          const i = (y * a.info.width + x) * 4;
          if (
            Math.max(
              ...[0, 1, 2].map((c) => Math.abs(a.data[i + c] - b[i + c])),
            ) > 3
          )
            pixels++;
        }
      control.changedPixels = pixels;
    }
    report.poses[name] = controls;
    check(
      `${name} expected station population`,
      controls.length,
      name === 'global' ? 0 : 5,
    );
    if (controls.length)
      check(
        `${name} five nonempty marker raster controls`,
        controls.every((c) => c.changedPixels > 0),
        true,
      );
  }
  await page.evaluate(() => {
    for (const element of document.querySelectorAll('.gbfs-raster-hidden'))
      element.classList.remove('gbfs-raster-hidden');
  });
  await page.evaluate(
    async (destination) => {
      const app = window.__godsEyeView;
      app.engine.camera.setView({
        destination,
        orientation: { heading: 0, pitch: -Math.PI / 2, roll: 0 },
      });
      await app.dataManager.setEnabled('bikeshare', false);
    },
    fromDegrees(-97.7449, 30.2701, 3000),
  );
  for (let i = 0; i < 10; i++) {
    await page.evaluate(() =>
      window.__godsEyeView.dataManager.setEnabled('bikeshare', true),
    );
    await page.waitForFunction(
      () =>
        window.__godsEyeView.dataManager.layers
          .get('bikeshare')
          .module.getStats().count === 5,
    );
    await page.evaluate(() =>
      window.__godsEyeView.dataManager.setEnabled('bikeshare', false),
    );
  }
  check(
    'ten cycles clear all records',
    await page.evaluate(
      () =>
        window.__godsEyeView.dataManager.layers
          .get('bikeshare')
          .module.getStats().count,
    ),
    0,
  );
  const idle = await page.evaluate(async () => {
    const app = window.__godsEyeView;
    let frames = 0,
      last = performance.now();
    const remove = app.engine.frames.postRender.addEventListener(() => {
      frames++;
      last = performance.now();
    });
    const start = performance.now();
    while (
      performance.now() - start < 60000 &&
      (performance.now() - last < 2000 || !app.engine.surface.tilesLoaded())
    )
      await new Promise((resolve) => setTimeout(resolve, 100));
    const ready =
      performance.now() - last >= 2000 && app.engine.surface.tilesLoaded();
    frames = 0;
    await new Promise((resolve) => setTimeout(resolve, 2000));
    remove();
    return { ready, frames, governor: app.getRenderGovernorDiagnostics() };
  });
  report.idle = idle;
  check('camera and tiles settle before idle sample', idle.ready, true);
  check(
    'disabled static scene renders zero frames over two seconds',
    idle.frames,
    0,
  );
  await page.evaluate(() =>
    window.__godsEyeView.dataManager.setEnabled('bikeshare', true),
  );
  await page.waitForFunction(
    () =>
      window.__godsEyeView.dataManager.layers.get('bikeshare').module.getStats()
        .count === 5,
  );
}
try {
  const { page, errors } = await open();
  await page.waitForFunction(
    () =>
      window.__godsEyeView.dataManager.layers.get('bikeshare').module.getStats()
        .count === 5,
    { timeout: 15000 },
  );
  await page.evaluate(async () => {
    const { engine } = window.__godsEyeView;
    const rendered = new Promise((resolve) => {
      const remove = engine.frames.postRender.addEventListener(() => {
        remove();
        resolve();
      });
    });
    window.__godsEyeView.requestRender('gbfs-name-pick-qa');
    await rendered;
  });
  const records = await page.evaluate(() =>
    window.__godsEyeView.dataManager.layers
      .get('bikeshare')
      .module.getAnalystRecords(),
  );
  check(
    'the layer retains all five stations and normalized names',
    records.map((r) => r.name),
    [
      'QA English Square',
      'QA Short Name',
      null,
      'QA Legacy Station',
      'QA Magyar Station',
    ],
  );
  const tool = await page.evaluate(() =>
    window.__godsEyeView.voiceCommands.runner('get_bike_share', {
      area: { lat: 30.2701, lon: -97.7449, radius_km: 2 },
    }),
  );
  check('the real bike-share tool succeeds', tool.ok, true);
  check(
    'the tool preserves localized, short, unnamed, legacy and non-English names',
    tool.data.rows.map((r) => r.name).sort(),
    [
      null,
      'QA English Square',
      'QA Short Name',
      'QA Legacy Station',
      'QA Magyar Station',
    ].sort(),
  );
  check(
    'availability remains attached to every station',
    tool.data.rows.every(
      (r) => r.bikes_available === 4 && r.docks_available === 9,
    ),
    true,
  );
  if (extended) await w2Checks(page);
  const clickPoint = await page.evaluate(() => {
    window.__qaPainted = [];
    const { engine } = window.__godsEyeView;
    const station = window.__godsEyeView.dataManager.layers
      .get('bikeshare')
      .module.getDetectableObjects()
      .find(({ sourceId }) => sourceId === 'austin-capmetro:english');
    const point = engine.projector.worldToWindow(station.position);
    const rect = engine.host.canvas.getBoundingClientRect();
    const picked = engine.picker.pick(point);
    return {
      x: rect.left + point.x,
      y: rect.top + point.y,
      pickedId: typeof picked?.id === 'string' ? picked.id : null,
      primitiveId:
        typeof picked?.primitive?.id === 'string' ? picked.primitive.id : null,
    };
  });
  check(
    'the scene pick resolves the first stable station key',
    clickPoint.pickedId || clickPoint.primitiveId,
    'austin-capmetro:english',
  );
  await page.mouse.click(clickPoint.x, clickPoint.y);
  await page.waitForFunction(
    () =>
      window.__godsEyeView.dataManager.layers
        .get('bikeshare')
        .module.getDetectableObjects()
        .some((record) => record.skipLabel),
    { timeout: 10000 },
  );
  await page.waitForFunction(
    () => window.__qaPainted.includes('QA English Square'),
    { timeout: 10000 },
  );
  check(
    'a real pointer click selects the station with its localized name',
    await page.evaluate(() => window.__qaPainted.includes('QA English Square')),
    true,
  );
  await page.keyboard.press('Escape');
  for (const [id, title] of [
    ['english', 'QA English Square'],
    ['short', 'QA Short Name'],
    ['unnamed', 'Station unnamed'],
  ]) {
    await page.evaluate((id) => {
      window.__qaPainted = [];
      const app = window.__godsEyeView;
      app.dataManager.layers
        .get('bikeshare')
        .module._selectBikeshareStationForTest(`austin-capmetro:${id}`);
      app.requestRender('gbfs-name-selection-qa');
    }, id);
    await page.waitForFunction(
      (title) => window.__qaPainted.includes(title),
      { timeout: 10000 },
      title,
    );
    check(
      `the selected ${id} card paints the expected title`,
      await page.evaluate((title) => window.__qaPainted.includes(title), title),
      true,
    );
    await page.screenshot({ path: path.join(shots, `${id}.png`) });
    await page.keyboard.press('Escape');
    await page.waitForFunction(() =>
      window.__godsEyeView.dataManager.layers
        .get('bikeshare')
        .module.getDetectableObjects()
        .every((record) => !record.skipLabel),
    );
    check(
      `Escape clears the ${id} card`,
      await page.evaluate(
        () =>
          window.__godsEyeView.dataManager.layers
            .get('bikeshare')
            .module.getDetectableObjects()
            .filter((record) => record.skipLabel).length,
      ),
      0,
    );
  }
  await page.setViewport({ width: 390, height: 844 });
  await page.evaluate(
    async (destination) => {
      window.__qaPainted = [];
      const app = window.__godsEyeView;
      // Use the supported clean view to inspect the mobile card clear of panels.
      app.styleManager.toggleCleanView(true);
      app.engine.camera.cancelFlight();
      app.engine.camera.setView({
        destination,
        orientation: { heading: 0, pitch: -Math.PI / 2, roll: 0 },
      });
      app.dataManager.layers
        .get('bikeshare')
        .module._selectBikeshareStationForTest('austin-capmetro:english');
      app.requestRender('gbfs-name-mobile-qa');
    },
    fromDegrees(-97.7449, 30.2701, 3000),
  );
  await page.waitForFunction(
    () => window.__qaPainted.includes('QA English Square'),
    { timeout: 10000 },
  );
  check(
    'the mobile selected card paints its normalized name',
    await page.evaluate(() => window.__qaPainted.includes('QA English Square')),
    true,
  );
  await page.screenshot({ path: path.join(shots, 'mobile.png') });
  await page.evaluate(() =>
    window.__godsEyeView.dataManager.setEnabled('bikeshare', false, {
      origin: 'user',
    }),
  );
  check(
    'disabling clears selected cards and analyst records',
    await page.evaluate(() => ({
      count: window.__godsEyeView.dataManager.layers
        .get('bikeshare')
        .module.getAnalystRecords().length,
      selected: window.__godsEyeView.dataManager.layers
        .get('bikeshare')
        .module.getDetectableObjects()
        .filter((record) => record.skipLabel).length,
    })),
    { count: 0, selected: 0 },
  );
  check('normal fixtures produce no page exceptions', errors, []);
  await page.close();
  for (const mode of ['empty', 'failure']) {
    const { page, errors } = await open(mode);
    await page.waitForFunction(
      () =>
        !window.__godsEyeView.dataManager.layers
          .get('bikeshare')
          .module.getStats().loading,
    );
    check(
      `${mode} leaves no rendered stations`,
      await page.evaluate(
        () =>
          window.__godsEyeView.dataManager.layers
            .get('bikeshare')
            .module.getStats().count,
      ),
      0,
    );
    check(`${mode} produces no page exceptions`, errors, []);
    await page.close();
  }
  if (extended)
    check(
      'all pages have no unexpected runtime errors',
      report.browserErrors,
      [],
    );
  report.pass = true;
  console.log(`GBFS names: ${checks}/${checks} checks passed; ${appUrl}`);
} catch (error) {
  report.pass = false;
  report.failure = redact(error.message);
  throw error;
} finally {
  if (reportPath)
    fs.writeFileSync(reportPath, JSON.stringify(report, null, 2) + '\n');
  await closeBrowser(browser);
}
