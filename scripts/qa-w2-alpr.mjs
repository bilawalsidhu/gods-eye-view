#!/usr/bin/env node
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import puppeteer from 'puppeteer';
import sharp from 'sharp';
import { installAlprFixture } from './fixtures/w2/alpr.mjs';
import { watchW1Page, redact } from './qa-browserEvidence.mjs';

const args = process.argv.slice(2);
const option = (name) =>
  args.includes(name) ? args[args.indexOf(name) + 1] : null;
const url = option('--url');
const output = option('--report');
if (!url || !output)
  throw new Error('Explicit --url and --report are required');
if (
  ['4173', '4185', '4186', '4187', '4188', '4189', '4194'].includes(
    new URL(url).port,
  )
)
  throw new Error('ALPR QA may not use a reserved port');
const shots = path.resolve(output.replace(/\.json$/, '-shots'));
fs.mkdirSync(shots, { recursive: true });
const report = {
  engine: new URL(url).searchParams.get('engine') || 'cesium',
  checks: [],
  poses: {},
  browserErrors: [],
};
function check(name, actual, expected = true) {
  report.checks.push({ name, actual, expected });
  assert.deepEqual(actual, expected, name);
  console.log(`[PASS] ${name}`);
}
const browser = await puppeteer.launch({
  headless: 'new',
  args:
    process.platform === 'darwin'
      ? ['--use-angle=metal', '--enable-gpu']
      : ['--use-gl=angle', '--use-angle=swiftshader'],
});
const page = await browser.newPage();
watchW1Page(page, report, {
  name: 'alpr',
  baseUrl: url,
  preview: args.includes('--preview'),
});
await page.setViewport({ width: 1440, height: 900 });
await installAlprFixture(page);
await page.evaluateOnNewDocument(() => {
  localStorage.clear();
  localStorage.setItem('gev:first-run-mission:v1', 'suppressed');
  window.__qaAlprTransport = { reject: false, failures: 0 };
  const fetch = window.fetch.bind(window);
  window.fetch = (input, init) => {
    const address = String(
      typeof input === 'string' || input instanceof URL ? input : input.url,
    );
    if (
      address.includes('tiles.dontgetflocked.com') &&
      window.__qaAlprTransport.reject
    ) {
      window.__qaAlprTransport.failures++;
      return Promise.reject(new TypeError('Injected ALPR transport failure'));
    }
    if (address.includes('/api/flights'))
      return Promise.resolve(new Response('{"states":[]}'));
    if (address.includes('/api/military'))
      return Promise.resolve(new Response('{"ac":[]}'));
    if (address.includes('/api/vessels'))
      return Promise.resolve(new Response('{"connected":false,"vessels":[]}'));
    return fetch(input, init);
  };
});
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function frames(count = 4) {
  await page.evaluate(
    (count) =>
      new Promise((resolve, reject) => {
        const engine = window.__godsEyeView.engine;
        const timeout = setTimeout(() => {
          remove();
          reject(new Error('ALPR frame deadline'));
        }, 10000);
        const remove = engine.frames.postRender.addEventListener(() => {
          if (--count <= 0) {
            remove();
            clearTimeout(timeout);
            resolve();
          } else
            requestAnimationFrame(() => engine.render.request('alpr-qa-frame'));
        });
        engine.render.request('alpr-qa-frame');
      }),
    count,
  );
}
async function enabled(value) {
  await page.evaluate(
    (value) =>
      window.__godsEyeView.dataManager.setEnabled('alpr-cameras', value, {
        origin: 'user',
      }),
    value,
  );
  if (value)
    await page.waitForFunction(
      () => {
        const stats = window.__godsEyeView.dataManager.layers
          .get('alpr-cameras')
          .module.getStats();
        return (
          !stats.loading && ['ready', 'zoom-in', 'empty'].includes(stats.status)
        );
      },
      { timeout: 30000 },
    );
  await frames();
}
async function view(height, lon = -97.7431, lat = 30.262) {
  await page.evaluate(
    async ({ height, lon, lat }) => {
      const geo = await import('/src/geo/index.js');
      const engine = window.__godsEyeView.engine;
      engine.camera.cancelFlight();
      engine.camera.setView({
        destination: geo.cartesian3.fromDegrees(lon, lat, height),
        orientation: { heading: 0, pitch: -Math.PI / 2, roll: 0 },
      });
    },
    { height, lon, lat },
  );
  await sleep(700);
  await page.waitForFunction(
    () => window.__godsEyeView.engine.surface.tilesLoaded(),
    { timeout: 90000 },
  );
  await frames();
}
async function snapshot() {
  return page.evaluate(() => {
    const app = window.__godsEyeView;
    const layer = app.dataManager.layers.get('alpr-cameras').module;
    const contexts = [
      ...(window.__gevContextStore?.entities.values() || []),
    ].filter((c) => c.layerId === 'alpr-cameras');
    const controls = contexts
      .flatMap(({ id, entity }) => {
        const position =
          entity.gevAlprCanvasPosition ||
          entity.gevDisplayPosition?.() ||
          entity.position?.getValue?.(app.viewer?.clock.currentTime) ||
          entity.position;
        if (!position || !app.engine.projector.horizonVisible(position))
          return [];
        const point = app.engine.projector.worldToWindow(position);
        if (
          !point ||
          point.x < 400 ||
          point.x > 1000 ||
          point.y < 200 ||
          point.y > 700
        )
          return [];
        const picked = app.engine.picker.pick(point);
        const pickedId =
          typeof picked?.id === 'string' ? picked.id : picked?.id?.id;
        return [{ id, x: point.x, y: point.y, pickedId }];
      })
      .sort((a, b) => a.id.localeCompare(b.id));
    const spaced = [];
    for (const control of controls) {
      if (
        control.pickedId !== control.id ||
        spaced.some((p) => Math.hypot(p.x - control.x, p.y - control.y) < 50)
      )
        continue;
      spaced.push(control);
      if (spaced.length === 5) break;
    }
    return {
      stats: layer.getStats(),
      records: layer
        .getAnalystRecords()
        .sort((a, b) => a.id.localeCompare(b.id)),
      controls: spaced,
    };
  });
}
async function idle(name) {
  const sample = await page.evaluate(async () => {
    const app = window.__godsEyeView;
    const requests = [];
    const scene = app.viewer?.scene;
    const original = scene?.requestRender;
    let measuring = false;
    if (scene && original) {
      scene.requestRender = function (...args) {
        if (measuring && requests.length < 40)
          requests.push(
            new Error().stack
              .split('\n')
              .slice(2, 5)
              .map((line) => line.replace(/\?.*?(?=:\d+:\d+\)?$)/, '')),
          );
        return original.apply(this, args);
      };
    }
    let last = performance.now(),
      frames = 0;
    const remove = app.engine.frames.postRender.addEventListener(() => {
      last = performance.now();
      frames++;
    });
    const start = performance.now();
    try {
      while (performance.now() - start < 90000) {
        if (app.engine.surface.tilesLoaded() && performance.now() - last > 2000)
          break;
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      if (!app.engine.surface.tilesLoaded() || performance.now() - last <= 2000)
        throw new Error(
          `ALPR idle deadline: ${JSON.stringify({ frames, governor: app.getRenderGovernorDiagnostics(), overlay: window.__gevWorldOverlay.getDiagnostics() })}`,
        );
      frames = 0;
      measuring = true;
      const before = app.getRenderGovernorDiagnostics();
      await new Promise((resolve) => setTimeout(resolve, 2000));
      return {
        frames,
        tilesLoaded: app.engine.surface.tilesLoaded(),
        before,
        after: app.getRenderGovernorDiagnostics(),
        requests,
      };
    } finally {
      remove();
      if (scene && original) scene.requestRender = original;
    }
  });
  (report.idle ??= {})[name] = sample;
  check(`${name}: zero idle frames in two seconds`, sample.frames, 0);
}
async function raster(name, controls) {
  check(`${name}: five real GPU pick controls`, controls.length, 5);
  await page.evaluate(() => {
    const canvases = [...document.querySelectorAll('canvas')];
    const style = document.createElement('style');
    style.id = 'alpr-qa-style';
    style.textContent = '.alpr-qa-hidden { visibility: hidden !important; }';
    document.head.append(style);
    for (const element of document.body.querySelectorAll('*'))
      if (
        !canvases.some(
          (canvas) => element === canvas || element.contains(canvas),
        )
      )
        element.classList.add('alpr-qa-hidden');
  });
  await enabled(false);
  const off = await page.screenshot({
    path: path.join(shots, `${name}-off.png`),
  });
  await enabled(true);
  await sleep(1800);
  await frames();
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
    for (let y = Math.floor(control.y) - 24; y < control.y + 24; y++)
      for (let x = Math.floor(control.x) - 24; x < control.x + 24; x++) {
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
  check(
    `${name}: five nonempty marker rasters`,
    controls.every((c) => c.changedPixels > 12),
  );
  await page.evaluate(() => {
    for (const element of document.querySelectorAll('.alpr-qa-hidden'))
      element.classList.remove('alpr-qa-hidden');
    document.getElementById('alpr-qa-style')?.remove();
  });
}
try {
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.waitForFunction(
    () =>
      window.__godsEyeView?.dataManager &&
      document.getElementById('loading-screen')?.classList.contains('hidden'),
    { timeout: 60000 },
  );
  await page.evaluate(async () => {
    const app = window.__godsEyeView;
    await app.styleManager.initialRestorePromise;
    app.styleManager.orbitController.stop();
    app.engine.camera.cancelFlight();
    for (const [id, layer] of app.dataManager.layers)
      if (layer.enabled) await app.dataManager.setEnabled(id, false);
    app.styleManager._setDetectionMode('OFF');
    (await import('/src/time/clock.js')).appClock.freeze(
      Date.parse('2026-10-28T19:00:00Z'),
    );
  });
  report.summaryLineBox = await page.evaluate(() => {
    const element = document.getElementById('hud-summary');
    const saved = element.textContent;
    const corner = element.closest('.hud-top-left');
    element.textContent =
      'NORMAL CITY NEAR FROST BANK TOWER | NORTH AMERICA | ALT 2KM | WINDOW 3x3KM | SUN 66 | UTC-7';
    const filled = element.getBoundingClientRect().height;
    const cornerFilled = corner.getBoundingClientRect().height;
    const widthFilled = corner.getBoundingClientRect().width;
    element.textContent = '';
    const empty = element.getBoundingClientRect().height;
    const cornerEmpty = corner.getBoundingClientRect().height;
    const widthEmpty = corner.getBoundingClientRect().width;
    element.textContent = saved;
    return {
      filled,
      empty,
      cornerFilled,
      cornerEmpty,
      widthFilled,
      widthEmpty,
    };
  });
  check(
    'HUD typing preserves its obstacle dimensions',
    report.summaryLineBox.filled > 0 &&
      report.summaryLineBox.filled === report.summaryLineBox.empty &&
      report.summaryLineBox.cornerFilled ===
        report.summaryLineBox.cornerEmpty &&
      report.summaryLineBox.widthFilled === report.summaryLineBox.widthEmpty,
  );
  for (const [name, height] of [
    ['city', 24000],
    ['regional', 6000],
    ['close', 2000],
  ]) {
    await enabled(false);
    await view(height);
    await enabled(true);
    await sleep(2000);
    await frames();
    const state = await snapshot();
    report.poses[name] = state;
    check(`${name}: populated fixture`, state.records.length > 0);
    check(
      `${name}: exact fixture IDs`,
      state.records.every((r) => /^alpr:9000\d{3}$/.test(r.id)),
    );
    await raster(name, state.controls);
  }
  const selected = (await snapshot()).controls[2];
  await page.mouse.click(selected.x, selected.y);
  await sleep(600);
  await frames();
  check(
    'physical click selects the exact camera',
    await page.evaluate(() => window.__gevContextStore.selectedEntityId),
    selected.id,
  );
  report.selectedGlyph = await page.evaluate((id) => {
    const engine = window.__godsEyeView.engine;
    const marker = window.__gevContextStore.entities.get(id).entity;
    const anchor = marker.gevAlprCanvasPosition;
    if (!anchor) throw new Error('Selected ALPR canvas anchor is missing');
    const camera = engine.camera.livePosition;
    const distance = Math.hypot(
      anchor.x - camera.x,
      anchor.y - camera.y,
      anchor.z - camera.z,
    );
    const scale =
      1.15 + Math.min(1, Math.max(0, (distance - 500) / 39500)) * (0.45 - 1.15);
    return {
      id,
      ...engine.projector.worldToWindow(anchor),
      sizePx: 60 * scale,
    };
  }, selected.id);
  const selectedImage = await page.screenshot({
    path: path.join(shots, 'selected.png'),
  });
  const selectedPixels = await sharp(selectedImage)
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  report.selectedGlyph.samples = [
    [48, 53],
    [60, 53],
    [72, 53],
    [50, 64],
    [70, 64],
  ].map(([u, v]) => {
    const { x, y, sizePx } = report.selectedGlyph;
    const px = Math.floor(x + ((u + 0.5) / 128 - 0.5) * sizePx);
    const py = Math.floor(y + ((v + 0.5) / 128 - 0.5) * sizePx);
    const offset = (py * selectedPixels.info.width + px) * 4;
    return {
      sourcePixel: [u, v],
      pixel: [px, py],
      rgb: [...selectedPixels.data.subarray(offset, offset + 3)],
    };
  });
  check(
    'five opaque coral samples are painted',
    report.selectedGlyph.samples.every(
      ({ rgb: [r, g, b] }) => r > 220 && g > 70 && g < 130 && b > 80 && b < 150,
    ),
  );
  await idle('enabled-selected');
  const selectedRecord = (await snapshot()).records.find(
    (record) => record.id === selected.id,
  );
  await page.setViewport({ width: 390, height: 844 });
  await view(2000, selectedRecord.lon, selectedRecord.lat);
  await sleep(600);
  await frames();
  report.mobileProbe = await page.evaluate((id) => {
    const marker = window.__gevContextStore?.entities.get(id)?.entity;
    return {
      id,
      trackedId: marker?.gevTrackedId,
      selectedId: window.__gevContextStore?.selectedEntityId,
      diagnostics: window.__gevWorldOverlay.getDiagnostics(),
      paintFound: Boolean(window.__gevWorldOverlay.getPaintRect('tracked', id)),
    };
  }, selected.id);
  await page.waitForFunction(
    (id) => Boolean(window.__gevWorldOverlay.getPaintRect('tracked', id)),
    { timeout: 10000 },
    selected.id,
  );
  report.mobileCard = await page.evaluate((id) => {
    const rect = window.__gevWorldOverlay.getPaintRect('tracked', id);
    return {
      x: rect.x,
      y: rect.y,
      w: rect.w,
      h: rect.h,
      title: rect.entry.title,
      selectedId: window.__gevContextStore.selectedEntityId,
    };
  }, selected.id);
  check(
    'mobile card retains exact selection',
    report.mobileCard.selectedId,
    selected.id,
  );
  check(
    'mobile card is contained in the viewport',
    report.mobileCard.w > 0 &&
      report.mobileCard.h > 0 &&
      report.mobileCard.x >= 0 &&
      report.mobileCard.y >= 0 &&
      report.mobileCard.x + report.mobileCard.w <= 390 &&
      report.mobileCard.y + report.mobileCard.h <= 844,
  );
  await page.screenshot({ path: path.join(shots, 'mobile-selected.png') });
  await idle('mobile-selected');
  await page.setViewport({ width: 1440, height: 900 });
  await view(2000);
  const lastGood = (await snapshot()).records;
  await page.evaluate(() => {
    window.__qaAlprTransport.reject = true;
  });
  await view(6000, -96.7, 30.4);
  await page.evaluate(() =>
    window.__godsEyeView.dataManager.layers.get('alpr-cameras').module.update(),
  );
  await page.waitForFunction(
    () =>
      window.__godsEyeView.dataManager.layers
        .get('alpr-cameras')
        .module.getStats().status === 'unavailable',
    { timeout: 30000 },
  );
  check(
    'failed source preserves last-good records',
    (await snapshot()).records,
    lastGood,
  );
  check(
    'failure path actually attempted transport',
    await page.evaluate(() => window.__qaAlprTransport.failures > 0),
  );
  await page.evaluate(() => {
    window.__qaAlprTransport.reject = false;
  });
  await view(2000);
  await page.evaluate(() =>
    window.__godsEyeView.dataManager.layers.get('alpr-cameras').module.update(),
  );
  await page.waitForFunction(
    () =>
      window.__godsEyeView.dataManager.layers
        .get('alpr-cameras')
        .module.getStats().status === 'ready',
    { timeout: 30000 },
  );
  check(
    'source recovers to the original fixture',
    (await snapshot()).records,
    lastGood,
  );
  for (let i = 0; i < 10; i++) {
    await enabled(false);
    await enabled(true);
  }
  check(
    'ten toggles preserve the fixture',
    (await snapshot()).records.length,
    report.poses.close.records.length,
  );
  await enabled(false);
  check(
    'disabled analyst records are empty',
    (await snapshot()).records.length,
    0,
  );
  check(
    'disabled contexts are removed',
    await page.evaluate(
      () =>
        [...window.__gevContextStore.entities.values()].filter(
          (c) => c.layerId === 'alpr-cameras',
        ).length,
    ),
    0,
  );
  await idle('disabled');
  check('no unexpected browser errors', report.browserErrors, []);
  report.pass = true;
} catch (error) {
  report.pass = false;
  report.error = redact(error.stack || error.message);
  await page
    .screenshot({ path: path.join(shots, 'failure.png') })
    .catch(() => {});
  process.exitCode = 1;
} finally {
  await browser.close();
  if (report.browserErrors.length) {
    report.pass = false;
    process.exitCode = 1;
  }
  fs.writeFileSync(output, JSON.stringify(report, null, 2) + '\n');
  console.log(
    `ALPR ${report.pass ? 'PASS' : 'FAIL'}: ${report.checks.length} checks`,
  );
  if (report.error) console.error(report.error);
}
