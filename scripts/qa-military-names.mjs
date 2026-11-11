#!/usr/bin/env node
/** Named military areas: continent performance, close identities and a recorded zoom. */
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import puppeteer from 'puppeteer';
import {
  checkInstallationPan,
  checkInstallationSelection,
} from './qa-installation-polish.mjs';
import {
  createScreencast,
  installFrameProbe,
  readFrames,
  frameStats,
  pageNow,
  moveCamera,
} from './qa-journey-recorder.mjs';

const args = process.argv.slice(2);
if (args.includes('--help')) {
  console.log('Usage: node scripts/qa-military-names.mjs <url> [--no-video]');
  process.exit(0);
}
const url = args.find((a) => /^https?:/.test(a));
if (!url) throw new Error('Supply the running server URL');
const dir = process.env.QA_NAMES_DIR || 'qa-shots/military-names';
await fs.mkdir(dir, { recursive: true });
const result = {
  views: [],
  sites: [],
  errors: [],
  forbidden: [],
  packs: [],
  video: null,
};
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const browser = await puppeteer.launch({
  headless: true,
  protocolTimeout: 180000,
  args: [
    '--use-angle=metal',
    '--disable-background-timer-throttling',
    '--disable-renderer-backgrounding',
  ],
});
let recorder;
try {
  const page = await browser.newPage();
  await page.setViewport({ width: 1280, height: 800 });
  page.on('pageerror', (e) => result.errors.push(e.message));
  page.on('console', (m) => {
    if (m.type() === 'error') result.errors.push(m.text());
  });
  page.on('request', (request) => {
    const u = new URL(request.url());
    if (
      /overpass/i.test(u.hostname) ||
      u.hostname === 'nominatim.openstreetmap.org'
    )
      result.forbidden.push(u.origin);
    if (u.pathname.endsWith('/osm_military_names/names.json'))
      result.packs.push(u.pathname);
  });
  await page.evaluateOnNewDocument(() =>
    sessionStorage.setItem('gev:first-run-mission-session:v1', 'dismissed'),
  );
  await page.goto(url + (url.includes('?') ? '&' : '?') + 'welcome=0', {
    waitUntil: 'domcontentloaded',
  });
  await page.waitForFunction(
    () =>
      window.__godsEyeView?.dataManager &&
      document.getElementById('loading-screen')?.classList.contains('hidden'),
    { timeout: 120000 },
  );
  await page.evaluate(
    () => window.__godsEyeView.styleManager.initialRestorePromise,
  );
  await page.keyboard.press('Escape');
  result.page = await page.evaluate(() => ({
    url: location.href,
    title: document.title,
    canvas: Boolean(document.querySelector('#cesiumContainer canvas')),
    errorOverlay: Boolean(document.querySelector('vite-error-overlay')),
  }));
  assert.equal(new URL(result.page.url).origin, new URL(url).origin);
  assert.ok(
    result.page.title && result.page.canvas && !result.page.errorOverlay,
  );
  await page.evaluate(async () => {
    const g = window.__godsEyeView;
    for (const [id] of g.dataManager.layers)
      await g.dataManager.setEnabled(id, false);
    g.styleManager.setDetection({ enabled: false });
    g.viewer.scene.screenSpaceCameraController.enableCollisionDetection = false;
  });
  assert.equal(result.packs.length, 0, 'names pack stays unloaded at startup');
  result.renderer = await page.evaluate(() => {
    const gl = window.__godsEyeView.viewer.scene.context._gl;
    const ext = gl.getExtension('WEBGL_debug_renderer_info');
    return ext
      ? gl.getParameter(ext.UNMASKED_RENDERER_WEBGL)
      : gl.getParameter(gl.RENDERER);
  });
  assert.doesNotMatch(result.renderer, /swiftshader|software/i);
  await installFrameProbe(page);
  const stats = () =>
    page.evaluate(() =>
      window.__godsEyeView.dataManager.layers
        .get('military-installations')
        .module.getStats(),
    );
  const settle = async () => {
    await sleep(500);
    await page.waitForFunction(
      () => {
        const s = window.__godsEyeView.dataManager.layers
          .get('military-installations')
          .module.getStats();
        return !s.loading && s.count > 0 && s.status === 'ready';
      },
      { timeout: 60000 },
    );
    await sleep(1200);
  };
  const us = { lon: -100, lat: 39, height: 6500000, pitch: -90 };
  await moveCamera(page, us, 0);
  await page.evaluate(() =>
    window.__godsEyeView.dataManager.setEnabled('military-installations', true),
  );
  await settle();
  result.credit = await page.evaluate(() => {
    const el = document.querySelector('#cesium-credits');
    return {
      text: el?.innerText || '',
      visible: Boolean(el && getComputedStyle(el).display !== 'none'),
    };
  });
  assert.match(result.credit.text, /© OpenStreetMap/);
  assert.doesNotMatch(
    result.credit.text,
    /© OpenMapTiles/,
    'wide bundled names use no vector tiles',
  );
  assert.ok(result.credit.visible);
  await page.screenshot({ path: `${dir}/credit.png` });
  for (const [name, view] of [
    ['us', us],
    ['europe', { lon: 12, lat: 50, height: 4500000, pitch: -90 }],
  ]) {
    await moveCamera(page, view, 2);
    await settle();
    const before = await stats();
    const overlaps = await page.evaluate(async () => {
      const { getOverlayPaintRect } =
        await import('/src/overlays/worldOverlay.js');
      const layer = window.__godsEyeView.dataManager.layers.get(
        'military-installations',
      ).module;
      const rects = [];
      layer.visitNamedMarkers((id) => {
        const rect = getOverlayPaintRect('military-installations', id);
        if (rect) rects.push(rect);
      });
      let overlaps = 0;
      for (let a = 0; a < rects.length; a++)
        for (let b = a + 1; b < rects.length; b++) {
          const x = rects[a],
            y = rects[b];
          if (
            x.x < y.x + y.w &&
            y.x < x.x + x.w &&
            x.y < y.y + y.h &&
            y.y < x.y + x.h
          )
            overlaps++;
        }
      return overlaps;
    });
    // Incumbents retain their placements during camera motion, as for Data Centers.
    assert.ok(
      before.namedInView > 0 &&
        before.namedMarkers > 0 &&
        before.pointsOnScreen > 0,
    );
    assert.ok(
      before.labelsOnScreen > 0 && before.labelsOnScreen <= before.labelCap,
    );
    await page.evaluate(async () => {
      // Use the governor's hold so an asynchronous idle transition cannot
      // overwrite a raw scene flag during the sustained-render measurement.
      const { holdContinuousRender } = await import('/src/renderGovernor.js');
      holdContinuousRender('qa-military-names-fps');
    });
    const t0 = await pageNow(page);
    await sleep(3500);
    const frames = await readFrames(page, t0);
    await page.evaluate(async () => {
      const { releaseContinuousRender } =
        await import('/src/renderGovernor.js');
      releaseContinuousRender('qa-military-names-fps');
    });
    const metrics = frameStats(frames);
    const seconds = frames.reduce((sum, frame) => sum + frame.dt, 0) / 1000;
    const fps = metrics.renderedFrames / seconds;
    const rafFps = metrics.frames / seconds;
    result.views.push({ name, ...before, overlaps, fps, rafFps, ...metrics });
    console.log(name, JSON.stringify(result.views.at(-1)));
    await page.screenshot({ path: `${dir}/${name}.png` });
    assert.ok(fps >= 55, `${name} fps ${fps.toFixed(1)} < 55`);
  }
  await page.evaluate(() =>
    window.__godsEyeView.styleManager.setCleanView(true),
  );
  await sleep(300);
  result.cleanUi = await page.evaluate(async () => {
    const host = await import('/src/overlays/worldOverlay.js');
    const root = document.getElementById('world-overlay-root');
    return {
      active: document.body.classList.contains('ui-clean-view'),
      visible: root.checkVisibility({
        visibilityProperty: true,
        opacityProperty: true,
      }),
      labels:
        host.getWorldOverlayDiagnostics().paintedBySource[
          'military-installations'
        ] || 0,
    };
  });
  assert.ok(
    result.cleanUi.active &&
      result.cleanUi.visible &&
      result.cleanUi.labels > 0,
  );
  await page.screenshot({ path: `${dir}/clean-ui.png` });
  await page.evaluate(() =>
    window.__godsEyeView.styleManager.setCleanView(false),
  );
  await page.evaluate(() =>
    window.__godsEyeView.dataManager.setEnabled(
      'military-installations',
      false,
    ),
  );
  result.disabled = await page.evaluate(async () => {
    const host = await import('/src/overlays/worldOverlay.js');
    return host.getWorldOverlayDiagnostics().entriesBySource[
      'military-installations'
    ];
  });
  assert.equal(result.disabled, 0);
  await page.evaluate(() =>
    window.__godsEyeView.dataManager.setEnabled('military-installations', true),
  );
  await moveCamera(page, us, 1);
  await settle();
  result.slowPan = await checkInstallationPan(page, dir);
  await moveCamera(page, us, 1);
  await settle();
  if (!args.includes('--no-video')) {
    recorder = await createScreencast(page, `${dir}/us-to-san-diego`, {
      fps: 24,
    });
    await recorder.start();
  }
  await page.evaluate(async () => {
    const C = await import('/node_modules/cesium/Build/Cesium/index.js');
    const { getOverlayPaintRect } =
      await import('/src/overlays/worldOverlay.js');
    const g = window.__godsEyeView;
    const layer = g.dataManager.layers.get('military-installations').module;
    const overlay = document.createElement('div');
    overlay.id = 'installation-label-probe';
    overlay.style.cssText =
      'position:fixed;top:60px;left:360px;z-index:99999;background:#07121cdd;color:#fff;padding:8px 12px;font:13px monospace;pointer-events:none';
    document.body.append(overlay);
    const screen = new C.Cartesian2();
    window.__installationFrames = [];
    window.__stopInstallationFrames =
      g.viewer.scene.postRender.addEventListener(() => {
        const stats = layer.getStats();
        const markers = [],
          labels = [],
          rects = [];
        layer.visitNamedMarkers((id, point) => {
          const rect = getOverlayPaintRect('military-installations', id);
          if (rect) rects.push(rect);
          const p = C.SceneTransforms.worldToWindowCoordinates(
            g.viewer.scene,
            point.position,
            screen,
          );
          if (
            point.show &&
            p &&
            p.x >= 0 &&
            p.y >= 0 &&
            p.x < 1280 &&
            p.y < 800
          ) {
            markers.push(id);
            if (rect) labels.push(id);
          }
        });
        let overlaps = 0;
        for (let a = 0; a < rects.length; a++)
          for (let b = a + 1; b < rects.length; b++) {
            const x = rects[a],
              y = rects[b];
            if (
              x.x < y.x + y.w &&
              y.x < x.x + x.w &&
              x.y < y.y + y.h &&
              y.y < x.y + x.h
            )
              overlaps++;
          }
        const altitude = g.viewer.camera.positionCartographic.height;
        window.__installationFrames.push({
          t: performance.now(),
          altitude,
          markers,
          labels,
          paintedLabels: stats.labelsOnScreen,
          overlaps,
          loading: stats.loading,
          wide: stats.wide,
        });
        overlay.textContent = `${(altitude / 1000).toFixed(1)} km | markers ${markers.length} | labels ${labels.length} / 24`;
      });
  });
  const clipStart = await pageNow(page);
  await sleep(1200);
  for (const view of [
    { lon: -116, lat: 35, height: 1500000, pitch: -85 },
    { lon: -117.2, lat: 33, height: 200000, pitch: -80 },
    { lon: -117.1, lat: 32.86, height: 18000, pitch: -80 },
  ]) {
    await moveCamera(page, view, 3);
    await sleep(800);
  }
  await settle();
  await sleep(1500);
  result.clipFrames = await readFrames(page, clipStart);
  result.labelFrames = await page.evaluate(() => {
    window.__stopInstallationFrames();
    document.getElementById('installation-label-probe').remove();
    return window.__installationFrames;
  });
  await fs.writeFile(
    `${dir}/label-frames.json`,
    JSON.stringify(result.labelFrames, null, 2),
  );
  assert.ok(result.labelFrames.length > 100);
  assert.ok(
    result.labelFrames.every(
      (frame) =>
        frame.markers.length > 0 &&
        frame.labels.length > 0 &&
        frame.paintedLabels > 0 &&
        frame.paintedLabels <= 24,
    ),
    'zoom never loses all visible named markers or labels',
  );
  if (recorder) {
    result.video = await recorder.stop();
    recorder = null;
  }
  result.selection = await checkInstallationSelection(page, dir, {
    video: !args.includes('--no-video'),
  });
  const sites = [
    ['mabry', 'Camp Mabry', -97.765, 30.3125, 3500],
    ['pendleton', 'Marine Corps Base Camp Pendleton', -117.4, 33.33, 25000],
    ['miramar', 'Marine Corps Air Station Miramar', -117.14, 32.87, 18000],
    ['ramstein', 'Ramstein Air Base', 7.6, 49.44, 7000],
    ['lakenheath', 'RAF Lakenheath', 0.56, 52.41, 7000],
    ['hood', 'Fort Hood', -97.78, 31.135, 30000],
  ];
  for (const [key, expected, lon, lat, height] of sites) {
    await moveCamera(page, { lon, lat, height, pitch: -80 }, 1.5);
    await settle();
    const snapshot = await page.evaluate(
      (lat, lon) => {
        const g = window.__godsEyeView;
        const layer = g.dataManager.layers.get('military-installations').module;
        const position = g.viewer.scene.globe.ellipsoid.cartographicToCartesian(
          {
            longitude: (lon * Math.PI) / 180,
            latitude: (lat * Math.PI) / 180,
            height: 0,
          },
        );
        return {
          stats: layer.getStats(),
          records: layer.getNearby(position, 100000, 1000).map((r) => ({
            id: r.id,
            name: r.name,
            memberNames: r.memberNames || [],
            hasPolygon: Boolean(r.footprints?.length),
          })),
        };
      },
      lat,
      lon,
    );
    result.sites.push({ key, expected, ...snapshot });
    assert.equal(
      new Set(snapshot.records.map((r) => r.id)).size,
      snapshot.records.length,
    );
    assert.ok(
      snapshot.stats.labelsOnScreen > 0 &&
        snapshot.stats.labelsOnScreen <= snapshot.stats.labelCap,
    );
    assert.ok(
      snapshot.records.some((r) => r.name === expected && r.hasPolygon),
      `${key}: missing named polygon ${expected}; got ${snapshot.records.map((r) => r.name).join(', ')}`,
    );
    await page.screenshot({ path: `${dir}/${key}.png` });
    console.log(key, expected);
  }
  await page.evaluate(() => {
    if (
      document
        .getElementById('global-context-panel')
        .classList.contains('collapsed')
    )
      document
        .querySelector('[data-collapse-target="global-context-panel"]')
        .click();
  });
  await page.waitForSelector('#global-context-flights-btn', { visible: true });
  await page.evaluate(() => {
    const button = document.getElementById('global-context-flights-btn');
    if (button.getAttribute('aria-selected') !== 'true') button.click();
  });
  await page.waitForFunction(
    () => {
      const state = window.__godsEyeView.styleManager.getContextModeState();
      return state.mode === 'flights' && !state.changing;
    },
    { timeout: 60000 },
  );
  result.card = await page.evaluate(() => {
    const g = window.__godsEyeView;
    return g.dataManager.layers
      .get('military-installations')
      .module.focusById('osm:military:r13529728');
  });
  assert.equal(result.card, true);
  await page.waitForFunction(
    () =>
      document
        .getElementById('military-awareness-panel')
        ?.textContent.includes('Named areas') &&
      document
        .getElementById('military-awareness-panel')
        .checkVisibility({ visibilityProperty: true, opacityProperty: true }),
    { timeout: 15000 },
  );
  result.cardText = await page.$eval(
    '#military-awareness-panel',
    (el) => el.textContent,
  );
  assert.match(result.cardText, /Fort Hood/);
  assert.match(result.cardText, /TA-25/);
  await sleep(1800);
  await page.$eval(
    '#military-awareness-panel .military-awareness-names',
    (el) => {
      el.open = true;
    },
  );
  await page.screenshot({ path: `${dir}/member-names-card.png` });
  assert.equal(result.packs.length, 1, 'single lazy asset fetch');
  assert.deepEqual(result.forbidden, []);
  assert.deepEqual(result.errors, []);
} finally {
  if (recorder)
    result.video = await recorder.stop().catch((e) => ({ error: e.message }));
  await fs.writeFile(`${dir}/result.json`, JSON.stringify(result, null, 2));
  await browser.close();
}
