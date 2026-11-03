#!/usr/bin/env node
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import puppeteer from 'puppeteer';
import sharp from 'sharp';
import { stations, installRadioFixture } from './fixtures/w2/radio.mjs';
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
  throw new Error('Radio QA may not use a reserved port');
const shots = path.resolve(output.replace(/\.json$/, '-shots'));
fs.mkdirSync(shots, { recursive: true });
const report = {
  engine: new URL(url).searchParams.get('engine') || 'cesium',
  checks: [],
  poses: {},
  browserErrors: [],
};
const check = (name, actual, expected = true) => {
  report.checks.push({ name, actual, expected });
  assert.deepEqual(actual, expected, name);
  console.log(`[PASS] ${name}`);
};
const browser = await puppeteer.launch({
  headless: 'new',
  ...(process.env.PUPPETEER_EXECUTABLE_PATH
    ? { executablePath: process.env.PUPPETEER_EXECUTABLE_PATH }
    : {}),
  args:
    process.platform === 'darwin'
      ? ['--use-angle=metal', '--enable-gpu']
      : ['--use-gl=angle', '--use-angle=swiftshader'],
});
const page = await browser.newPage();
watchW1Page(page, report, {
  name: 'radio',
  baseUrl: url,
  preview: args.includes('--preview'),
});
await page.setViewport({ width: 1440, height: 900 });
await installRadioFixture(page);

async function frames(count = 4) {
  await page.evaluate(
    (count) =>
      new Promise((resolve, reject) => {
        const engine = window.__godsEyeView.engine;
        const timeout = setTimeout(() => {
          remove();
          reject(new Error('Radio frame deadline'));
        }, 10000);
        const remove = engine.frames.postRender.addEventListener(() => {
          if (--count <= 0) {
            remove();
            clearTimeout(timeout);
            resolve();
          } else
            requestAnimationFrame(() =>
              engine.render.request('radio-qa-frame'),
            );
        });
        engine.render.request('radio-qa-frame');
      }),
    count,
  );
}
async function view(height, lon = -174, lat = 6) {
  await page.evaluate(
    async ({ height, lon, lat }) => {
      const geo = await import('/src/geo/index.js');
      const app = window.__godsEyeView;
      app.engine.camera.cancelFlight();
      app.engine.camera.setView({
        destination: geo.cartesian3.fromDegrees(lon, lat, height),
        orientation: { heading: 0, pitch: -Math.PI / 2, roll: 0 },
      });
    },
    { height, lon, lat },
  );
  await new Promise((resolve) => setTimeout(resolve, 700));
  await frames();
}
async function snapshot() {
  return page.evaluate(() => {
    const app = window.__godsEyeView;
    const layer = app.dataManager.layers.get('radio').module;
    const diagnostics = layer.getOverlayDiagnostics();
    const size = app.engine.host.size();
    const controls = [
      ...diagnostics.singletonIds,
      ...diagnostics.clusterIds,
    ].flatMap((id) => {
      const rect = window.__gevWorldOverlay.getPaintRect('radio', id);
      if (!rect) return [];
      const position =
        typeof rect.entry.position === 'function'
          ? rect.entry.position()
          : rect.entry.position;
      const p = app.engine.projector.worldToWindow(position);
      // The host can bring a label on-screen while its marker anchor remains
      // outside the canvas. Such a label is not a scene-picking control.
      if (!p || p.x < 0 || p.y < 0 || p.x >= size.width || p.y >= size.height)
        return [];
      const pick = app.engine.picker.pick(p);
      const stationId = layer.radioStationIdFromPick(pick);
      return [
        {
          id,
          x: p.x,
          y: p.y,
          position: { ...position },
          stationId,
          title: rect.entry.title,
          opacity: rect.opacity,
        },
      ];
    });
    return {
      diagnostics,
      controls,
      host: window.__gevWorldOverlay.getDiagnostics(),
      stats: layer.getStats(),
      state: layer.getUIState(),
      plays: window.__qaRadio.plays.length,
      sets: app.engine.movers
        .list()
        .filter((set) => set.id.startsWith('radio-')),
    };
  });
}
async function idle() {
  const result = await page.evaluate(async () => {
    const app = window.__godsEyeView;
    let last = performance.now();
    let count = 0;
    const remove = app.engine.frames.postRender.addEventListener(() => {
      last = performance.now();
      count++;
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
          `Radio did not become idle: ${JSON.stringify({
            governor: app.getRenderGovernorDiagnostics(),
            overlay: window.__gevWorldOverlay.getDiagnostics(),
            enabled: [...app.dataManager.layers]
              .filter(([, layer]) => layer.enabled)
              .map(([id]) => id),
            tilesLoaded: app.engine.surface.tilesLoaded(),
            count,
            continuous: app.engine.render.isContinuous(),
            flight: app.engine.camera.flightActive(),
            requests: window.__qaRadio.renderRequests,
            detection: app.styleManager.getDetectionState(),
          })}`,
        );
      count = 0;
      const stacks = {};
      const target = app.viewer?.scene ?? app.engine.render;
      const method = app.viewer ? 'requestRender' : 'request';
      const original = target[method];
      target[method] = function (...args) {
        const stack = new Error().stack.split('\n').slice(2, 7).join('\n');
        if (Object.keys(stacks).length < 30 || stacks[stack])
          stacks[stack] = (stacks[stack] || 0) + 1;
        return original.apply(this, args);
      };
      try {
        await new Promise((resolve) => setTimeout(resolve, 2000));
      } finally {
        target[method] = original;
      }
      return {
        count,
        stacks,
        tilesLoaded: app.engine.surface.tilesLoaded(),
        governor: app.getRenderGovernorDiagnostics(),
        overlay: window.__gevWorldOverlay.getDiagnostics(),
        detection: app.styleManager.getDetectionState(),
      };
    } finally {
      remove();
    }
  });
  (report.idleSamples ??= []).push(result);
  return result.count;
}

async function settleTiles() {
  await page.evaluate(async () => {
    const engine = window.__godsEyeView.engine;
    const start = performance.now();
    let quiet = null;
    while (performance.now() - start < 90000) {
      if (engine.surface.tilesLoaded()) quiet ??= performance.now();
      else quiet = null;
      if (quiet !== null && performance.now() - quiet > 1500) return;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    throw new Error('Radio raster tiles did not settle');
  });
}

async function raster(name, controls) {
  check(`${name}: five fixed projected controls`, controls.length, 5);
  await page.evaluate(() => {
    const canvas = window.__godsEyeView.engine.host.canvas;
    const style = document.createElement('style');
    style.id = 'radio-raster-style';
    style.textContent =
      '.radio-raster-hidden { visibility: hidden !important; }';
    document.head.append(style);
    for (const element of document.body.querySelectorAll('*'))
      if (element !== canvas && !element.contains(canvas))
        element.classList.add('radio-raster-hidden');
  });
  await page.evaluate(() =>
    window.__godsEyeView.dataManager.setEnabled('radio', false),
  );
  await settleTiles();
  await frames();
  const off = await page.screenshot({
    path: path.join(shots, `${name}-off.png`),
  });
  await page.evaluate(() =>
    window.__godsEyeView.dataManager.setEnabled('radio', true),
  );
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
    let changedPixels = 0;
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
          changedPixels++;
      }
    control.changedPixels = changedPixels;
  }
  report.rasters ??= {};
  report.rasters[name] = controls;
  check(
    `${name}: every point leaves a nonempty raster`,
    controls.every((c) => c.changedPixels > 4),
  );
  await page.evaluate(() => {
    for (const element of document.querySelectorAll('.radio-raster-hidden'))
      element.classList.remove('radio-raster-hidden');
    document.getElementById('radio-raster-style')?.remove();
  });
}

async function cityRaster(name, height) {
  const spacing = height / 1_250_000;
  await page.evaluate(
    async ({ spacing, stations }) => {
      const app = window.__godsEyeView,
        qa = window.__qaRadio;
      qa.stations = stations.map((station, i) =>
        i < 5
          ? {
              ...station,
              name: `QA Urban ${i + 1}`,
              lat: 30.27 + (i - 2) * spacing,
              lon: -97.7449,
            }
          : station,
      );
      qa.generation++;
      const layer = app.dataManager.layers.get('radio').module;
      await layer.update();
      layer.setFilter('all');
    },
    { spacing, stations },
  );
  await view(height, -97.7449, 30.27);
  await settleTiles();
  await frames();
  const controls = await page.evaluate(async () => {
    const app = window.__godsEyeView;
    const geo = await import('/src/geo/index.js');
    const layer = app.dataManager.layers.get('radio').module;
    const rect = app.engine.host.canvas.getBoundingClientRect();
    return window.__qaRadio.stations.slice(0, 5).map((station) => {
      const floor = app.surfaceServices.groundFloor.cachedGroundFloor(
        station.lat,
        station.lon,
      );
      const position = geo.cartesian3.fromDegrees(
        station.lon,
        station.lat,
        (Number.isFinite(floor) ? floor : 0) + 2.5,
      );
      const point = app.engine.projector.worldToWindow(position);
      return {
        id: station.id,
        x: point.x + rect.left,
        y: point.y + rect.top,
        pickedId: layer.radioStationIdFromPick(app.engine.picker.pick(point)),
      };
    });
  });
  check(
    `${name}: all five scene picks match station IDs`,
    controls.every((c) => c.id === c.pickedId),
  );
  await raster(name, controls);
}

try {
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.waitForFunction(
    () =>
      window.__godsEyeView?.dataManager && window.__godsEyeView?.voiceCommands,
    { timeout: 60000 },
  );
  await page.waitForFunction(
    () =>
      document.getElementById('loading-screen')?.classList.contains('hidden'),
    { timeout: 60000 },
  );
  await page.evaluate(async () => {
    const app = window.__godsEyeView;
    await app.styleManager.initialRestorePromise;
    app.styleManager.orbitController.stop();
    app.engine.camera.cancelFlight();
    for (const [id, layer] of app.dataManager.layers)
      if (layer.enabled)
        await app.dataManager.setEnabled(id, false, { origin: 'user' });
    app.styleManager._setDetectionMode('OFF');
    (await import('/src/time/clock.js')).appClock.freeze(
      Date.parse('2026-10-28T19:00:00Z'),
    );
    app.styleManager.setPanelCollapsed('global-context-panel', true);
    app.styleManager.setPanelCollapsed('pp-toggles', true);
  });
  await view(24_200_000);
  check(
    'radio is available in the real engine catalog',
    await page.evaluate(() =>
      window.__godsEyeView.dataManager.layers.has('radio'),
    ),
  );
  await page.evaluate(() =>
    window.__godsEyeView.dataManager.setEnabled('radio', true, {
      origin: 'user',
    }),
  );
  await page.waitForFunction(
    () =>
      window.__godsEyeView.dataManager.layers.get('radio').module.getStats()
        .count === 750,
    { timeout: 20000 },
  );
  await frames();
  const initial = await snapshot();
  check(
    'all 750 accepted directory records reach the layer',
    initial.stats.count,
    750,
  );
  check('enable and restore never autoplay', initial.plays, 0);
  report.catalog = await page.evaluate(
    () =>
      window.__godsEyeView.dataManager.layers
        .get('radio')
        .module.getAcceptedCatalogSnapshot().stations,
  );
  for (const [name, height] of [
    ['global', 24_200_000],
    ['regional', 5_000_000],
    ['city', 500_000],
  ]) {
    await view(height);
    for (const filter of ['all', 'news', 'weather', 'public-safety']) {
      // Each sparse category occupies a different longitude in the same
      // global-grid fixture. Keep its known positive control in the city view.
      await view(
        height,
        { all: -174, news: -174, weather: -150, 'public-safety': -138 }[filter],
      );
      await page.evaluate(
        (filter) =>
          window.__godsEyeView.dataManager.layers
            .get('radio')
            .module.setFilter(filter),
        filter,
      );
      await frames();
      await page.waitForFunction(
        () => {
          const ids = window.__godsEyeView.dataManager.layers
            .get('radio')
            .module.getOverlayDiagnostics();
          return [...ids.singletonIds, ...ids.clusterIds].some((id) =>
            window.__gevWorldOverlay.getPaintRect('radio', id),
          );
        },
        { timeout: 10000 },
      );
      const current = await snapshot();
      report.poses[`${name}-${filter}`] = current;
      check(
        `${name}/${filter}: bounded overlay cohort`,
        current.diagnostics.entryCount > 0 &&
          current.diagnostics.entryCount <= 65,
      );
      check(
        `${name}/${filter}: actual shared-host text is painted`,
        current.controls.length > 0,
      );
      check(
        `${name}/${filter}: in-viewport anchors resolve real station picks`,
        current.controls.every((c) => Boolean(c.stationId)),
      );
    }
    await page.screenshot({ path: path.join(shots, `${name}.png`) });
    if (name !== 'city') {
      const controls = (await snapshot()).controls
        .filter((c) => c.stationId)
        .slice(0, 5);
      await raster(name, controls);
    }
  }
  await view(500_000);
  await page.evaluate(() =>
    window.__godsEyeView.dataManager.layers
      .get('radio')
      .module.setFilter('news'),
  );
  await frames();
  const clickable = (await snapshot()).controls.find(
    (c) => c.id.startsWith('station:') && c.stationId,
  );
  check(
    'visible singleton available for a physical pointer click',
    Boolean(clickable),
  );
  const offset = await page.evaluate(() => {
    const rect =
      window.__godsEyeView.engine.host.canvas.getBoundingClientRect();
    return { x: rect.left, y: rect.top };
  });
  await page.mouse.click(offset.x + clickable.x, offset.y + clickable.y);
  await page.waitForFunction(
    (id) =>
      window.__godsEyeView.dataManager.layers.get('radio').module.getUIState()
        .selected?.id === id,
    {},
    clickable.stationId,
  );
  const clicked = await snapshot();
  check(
    'physical marker click starts exactly one playback attempt',
    clicked.plays,
    1,
  );
  check(
    'selected station keeps its exact directory identity',
    clicked.state.selected.id,
    clickable.stationId,
  );
  await frames();
  check(
    'selected station publishes its protected card',
    (await snapshot()).diagnostics.selectedCount,
    1,
  );
  await page.screenshot({ path: path.join(shots, 'selected-desktop.png') });
  await page.evaluate(() =>
    window.__godsEyeView.dataManager.layers
      .get('radio')
      .module.setFilter('weather'),
  );
  check(
    'filter change preserves current selected broadcaster',
    (await snapshot()).state.selected.id,
    clickable.stationId,
  );
  check(
    'filter change does not start another stream',
    (await snapshot()).plays,
    1,
  );

  const navigation = await page.evaluate(() => {
    const app = window.__godsEyeView,
      layer = app.dataManager.layers.get('radio').module;
    const calls = [];
    const camera = app.viewer?.camera ?? app.engine.camera;
    const original = camera.flyTo;
    camera.flyTo = (options) => calls.push(options);
    const follow = app.engine.camera.follow({
      position: () => ({ x: 6378140, y: 0, z: 0 }),
      viewFrom: { x: 1000, y: 0, z: 0 },
    });
    const target = layer.getAcceptedCatalogSnapshot().stations[0].id;
    try {
      layer.selectStation(target, { focus: true, autoplay: false });
      const blocked = calls.length;
      follow.stop();
      layer.selectStation(target, { focus: true, autoplay: false });
      return { blocked, free: calls.length - blocked };
    } finally {
      follow.stop();
      camera.flyTo = original;
    }
  });
  check(
    'radio navigation yields to follow ownership, then works after release',
    navigation,
    { blocked: 0, free: 1 },
  );
  await view(500_000);

  for (const mode of ['failure', 'empty']) {
    const preserved = await page.evaluate(async (mode) => {
      const layer = window.__godsEyeView.dataManager.layers.get('radio').module;
      const before = layer.getAcceptedCatalogSnapshot();
      window.__qaRadio.response = mode;
      await layer.update();
      window.__qaRadio.response = 'normal';
      return (
        layer.getAcceptedCatalogSnapshot() === before &&
        layer.getStats().count === 750 &&
        Boolean(layer.getStats().error)
      );
    }, mode);
    check(`${mode} response preserves last accepted catalog`, preserved);
  }
  await page.evaluate(async () => {
    const app = window.__godsEyeView,
      qa = window.__qaRadio;
    qa.delay = 1;
    qa.generation++;
    qa.update = app.dataManager.layers.get('radio').module.update();
    await Promise.resolve();
    await app.dataManager.setEnabled('radio', false);
    qa.pending();
    await qa.update;
  });
  check(
    'late aborted response cannot make a disabled layer visible',
    (await snapshot()).diagnostics.entryCount,
    0,
  );
  for (let i = 0; i < 10; i++) {
    await page.evaluate(async () => {
      const manager = window.__godsEyeView.dataManager;
      await manager.setEnabled('radio', true);
      await manager.setEnabled('radio', false);
    });
  }
  const disabled = await snapshot();
  check(
    'ten lifecycle cycles leave no published radio entries',
    disabled.diagnostics.entryCount,
    0,
  );
  check('ten lifecycle cycles do not autoplay', disabled.plays, 1);
  check(
    'disabled renderer owns no visible instances',
    disabled.sets.every((set) => set.count === 0),
  );
  await page.evaluate(() =>
    window.__godsEyeView.dataManager.setEnabled('radio', true),
  );
  const latePlay = await page.evaluate(async () => {
    const app = window.__godsEyeView,
      qa = window.__qaRadio;
    const layer = app.dataManager.layers.get('radio').module;
    const rows = layer.getAcceptedCatalogSnapshot().stations;
    layer.selectStation(rows[0].id, { focus: false, autoplay: false });
    qa.delayPlay = true;
    const pending = layer.playSelectedRadio({ origin: 'user' });
    const loading = layer.getUIState().audioState;
    layer.stopRadioPlayback();
    layer.selectStation(rows[1].id, { focus: false, autoplay: false });
    qa.releasePlay();
    const result = await pending;
    const state = layer.getUIState();
    return {
      loading,
      result,
      selected: state.selected?.id,
      expected: rows[1].id,
      stopped: state.audioState === 'stopped',
      playing: layer.getStats().playing,
    };
  });
  report.latePlay = latePlay;
  check(
    'retired play promise and playing event cannot replace a newer selection',
    latePlay.loading === 'loading' &&
      latePlay.result === false &&
      latePlay.stopped &&
      latePlay.selected === latePlay.expected &&
      latePlay.playing === null,
  );
  await page.evaluate(() =>
    window.__godsEyeView.dataManager.layers
      .get('radio')
      .module.setFilter('news'),
  );
  await frames();
  check(
    'enabled stationary radio requires zero frames over two seconds',
    await idle(),
    0,
  );
  await cityRaster('city-dense', 10000);
  await cityRaster('close-dense', 3000);
  await page.evaluate(() => {
    const render = window.__godsEyeView.engine.render;
    const request = render.request;
    window.__qaRadio.renderRequests = {};
    render.request = (...args) => {
      const key = args[0] || 'unspecified';
      window.__qaRadio.renderRequests[key] =
        (window.__qaRadio.renderRequests[key] || 0) + 1;
      return request(...args);
    };
  });
  await page.setViewport({ width: 390, height: 844 });
  await page.evaluate(() => {
    const app = window.__godsEyeView;
    app.styleManager.setPanelCollapsed('global-context-panel', false);
    app.styleManager.setPanelCollapsed('radio-panel', false);
  });
  await frames();
  await page.evaluate(() => {
    document
      .getElementById('radio-tuner-slider')
      .scrollIntoView({ block: 'center' });
    window.__godsEyeView.dataManager.layers
      .get('radio')
      .module.setFilter('all');
  });
  const tuner = await page.evaluate(() => {
    const app = window.__godsEyeView,
      qa = window.__qaRadio;
    const layer = app.dataManager.layers.get('radio').module;
    const slider = document.getElementById('radio-tuner-slider');
    const panel = document
      .querySelector('.radio-panel-inner')
      .getBoundingClientRect();
    const rect = slider.getBoundingClientRect();
    const before = layer.getUIState().selected?.id;
    const plays = qa.plays.length;
    const camera = app.viewer?.camera ?? app.engine.camera;
    const flyTo = camera.flyTo;
    const calls = [];
    camera.flyTo = (options) => calls.push(options);
    try {
      slider.focus();
      slider.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'End', bubbles: true }),
      );
      const end = Number(slider.value);
      const active = layer.getUIState().tuningActive;
      const previewOnly = qa.plays.length === plays;
      slider.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }),
      );
      const cancelled = layer.getUIState();
      return {
        end,
        max: Number(slider.max),
        active,
        previewOnly,
        restored:
          cancelled.selected?.id === before &&
          !cancelled.tuningActive &&
          qa.plays.length === plays,
        navigationCalls: calls.length,
        contained:
          rect.width > 0 &&
          rect.left >= panel.left &&
          rect.right <= panel.right &&
          rect.left >= 0 &&
          rect.right <= innerWidth &&
          rect.top >= 0 &&
          rect.bottom <= innerHeight,
      };
    } finally {
      camera.flyTo = flyTo;
    }
  });
  report.mobileTuner = tuner;
  check(
    'mobile tuner is visible and contained in the viewport and panel',
    tuner.contained,
  );
  check(
    'keyboard End previews the final directory station without audio',
    tuner.end === 749 &&
      tuner.max === 749 &&
      tuner.active &&
      tuner.previewOnly &&
      tuner.navigationCalls > 0,
  );
  check(
    'Escape restores the prior tuner selection without playback',
    tuner.restored,
  );
  await page.screenshot({ path: path.join(shots, 'mobile.png') });
  check(
    'mobile viewport retains all station records',
    (await snapshot()).stats.count,
    750,
  );
  await page.evaluate(() =>
    window.__godsEyeView.dataManager.setEnabled('radio', false),
  );
  check(
    'disabled stationary radio requires zero frames over two seconds',
    await idle(),
    0,
  );
  check('all-page strict browser errors', report.browserErrors, []);
  report.pass = true;
} catch (error) {
  report.pass = false;
  report.error = redact(error.stack || error.message);
  console.error(report.error);
  process.exitCode = 1;
} finally {
  fs.writeFileSync(output, JSON.stringify(report, null, 2) + '\n');
  await browser.close();
  console.log(`Radio W2: ${report.checks.length} checks; pass=${report.pass}`);
}
