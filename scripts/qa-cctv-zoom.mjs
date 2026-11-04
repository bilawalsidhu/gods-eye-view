#!/usr/bin/env node
/**
 * CCTV zoom-density acceptance with 2,000 synthetic cameras and frames.
 * Run against a running production preview: QA_BASE_URL=http://127.0.0.1:4182
 * node scripts/qa-cctv-zoom.mjs. No live camera tokens or footage are fetched.
 * QA_SCREENSHOT_PATH optionally saves the regional overview screenshot.
 */
import assert from 'node:assert/strict';
import puppeteer from 'puppeteer';
const origin = process.env.QA_BASE_URL || 'http://localhost:4173';
const sources = Array.from({ length: 2000 }, (_, i) => ({
  id: `zoom-camera-${i}`,
  name: `Zoom camera ${i}`,
  city: 'Pennsylvania',
  cityId: 'pennsylvania',
  lat: 39.7 + (i % 40) * 0.06,
  lon: -80.4 + Math.floor(i / 40) * 0.1,
  feedType: 'image',
  sourceKind: 'fixture',
  provider: 'Zoom QA',
  groundElevationM: 0,
  headingDeg: 0,
  pitchDeg: -18,
  fovDeg: 60,
  rangeM: 150,
  mountHeightM: 8,
}));
// Include a crowded city cluster to distinguish camera-name limits from icon LOD.
for (let i = 0; i < 80; i++) {
  sources[i].lat = 40.9 + (Math.floor(i / 10) - 3.5) * 0.00015;
  sources[i].lon = -77.9 + ((i % 10) - 4.5) * 0.00015;
}
const browser = await puppeteer.launch({
  headless: true,
  args:
    process.platform === 'darwin'
      ? ['--use-angle=metal', '--enable-gpu']
      : ['--use-gl=angle', '--use-angle=swiftshader'],
});
try {
  const page = await browser.newPage();
  await page.setViewport({ width: 1440, height: 900 });
  await page.evaluateOnNewDocument(() =>
    localStorage.setItem('gev:first-run-mission:v1', 'suppressed'),
  );
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
        body: '<svg xmlns="http://www.w3.org/2000/svg" width="640" height="360"><rect width="640" height="360" fill="#254b32"/></svg>',
      });
    if (url.pathname === '/api/terrain/heights')
      return void json({
        results: (url.searchParams.get('points') || '')
          .split(';')
          .filter(Boolean)
          .map((p) => {
            const [lon, lat] = p.split(',').map(Number);
            return { lon, lat, elevation: 0, geoid: 0, ellipsoid: 0 };
          }),
      });
    void request.continue();
  });
  await page.goto(`${origin}/?welcome=0`, {
    waitUntil: 'domcontentloaded',
    timeout: 60000,
  });
  await page.waitForFunction(
    () =>
      window.__godsEyeView?.styleManager?._cctvControls &&
      document.getElementById('loading-screen')?.classList.contains('hidden'),
    { timeout: 60000 },
  );
  await page.$eval('[data-collapse-target="cctv-panel"]', (e) => e.click());
  await page.click('#cctv-enable-btn');
  await page.waitForFunction(
    () =>
      window.__godsEyeView.styleManager._cctvControls.cctv.getUIState()
        .count === 2000,
    { timeout: 60000 },
  );
  await page.evaluate(() =>
    window.__godsEyeView.styleManager._cctvControls.cctv.selectCamera(
      'zoom-camera-1020',
    ),
  );
  const viewAt = async (altitude) => {
    await page.evaluate(async (height) => {
      const { viewer } = window.__godsEyeView;
      viewer.camera.cancelFlight();
      viewer.camera.setView({
        destination: viewer.camera.positionWC.constructor.fromDegrees(
          -77.9,
          40.9,
          height,
        ),
        orientation: { heading: 0, pitch: -Math.PI / 2, roll: 0 },
      });
      await new Promise((resolve) => {
        const remove = viewer.scene.postRender.addEventListener(() => {
          remove();
          resolve();
        });
        viewer.scene.requestRender();
      });
      viewer.camera.moveEnd.raiseEvent();
      viewer.scene.requestRender();
    }, altitude);
    await page.waitForFunction(
      (height) =>
        Math.abs(
          window.__godsEyeView.viewer.camera.positionCartographic.height -
            height,
        ) < 10,
      {},
      altitude,
    );
  };
  const states = [];
  for (const altitude of [30000, 120000, 600000, 2500000, 30000]) {
    await viewAt(altitude);
    const state = await page.evaluate(() => {
      const s =
        window.__godsEyeView.styleManager._cctvControls.cctv.getUIState();
      return {
        catalog: s.count,
        markers: s.cameraIndex.length,
        cards: s.ambientCards.count,
        selected: s.activeCameraId,
      };
    });
    assert.equal(state.catalog, 2000);
    assert.equal(state.selected, 'zoom-camera-1020');
    if (altitude >= 100000) assert.equal(state.cards, 0);
    if (altitude >= 2500000) assert.ok(state.markers <= 20);
    else if (altitude >= 500000) assert.ok(state.markers <= 40);
    else if (altitude >= 100000) assert.ok(state.markers <= 80);
    states.push({ altitude, ...state });
    console.log('VIEW', JSON.stringify(states.at(-1)));
    if (altitude === 600000 && process.env.QA_SCREENSHOT_PATH)
      await page.screenshot({ path: process.env.QA_SCREENSHOT_PATH });
  }
  assert.equal(
    states[0].markers,
    states.at(-1).markers,
    'returning to the same view restores the same marker density',
  );
  assert.ok(states[0].cards > 0, 'city thumbnails are restored');
  assert.ok(states.at(-1).cards > 0, 'thumbnails return after zooming in');
  console.log('ZOOM QA PASSED', JSON.stringify(states));
  await page.evaluate(() =>
    window.__godsEyeView.styleManager.setDetection({
      enabled: true,
      densityPct: 100,
      allocationStrategy: 'elastic',
    }),
  );
  const labelStates = [];
  for (const [altitude, cap] of [
    [500, 17],
    [7500, 15],
    [20000, 12],
    [35000, 0],
    [500, 17],
  ]) {
    const previous = await page.evaluate(
      () =>
        window.__godsEyeView.styleManager.getDetectionDiagnostics()
          ?.solveRevision || 0,
    );
    await viewAt(altitude);
    await page.waitForFunction(
      ({ previous, cap, altitude }) => {
        const d = window.__godsEyeView.styleManager.getDetectionDiagnostics();
        const count = d?.labelsByLayer?.cctv || 0;
        return (
          d?.solveRevision > previous &&
          count <= cap &&
          (altitude !== 500 || count > 0)
        );
      },
      { timeout: 30000 },
      { previous, cap, altitude },
    );
    const labelState = await page.evaluate(() => {
      const app = window.__godsEyeView;
      const d = app.styleManager.getDetectionDiagnostics();
      const c = app.styleManager._cctvControls.cctv.getUIState();
      return {
        markers: c.cameraIndex.length,
        names: d.labelsByLayer?.cctv || 0,
        selected: c.activeCameraId,
      };
    });
    assert.ok(labelState.names <= cap);
    assert.ok(labelState.markers > 0);
    assert.equal(labelState.selected, 'zoom-camera-1020');
    if (altitude === 500)
      assert.ok(
        labelState.markers > labelState.names,
        'crowded icons remain while camera names are capped',
      );
    labelStates.push({ altitude, ...labelState });
  }
  console.log('CAMERA LABEL QA PASSED', JSON.stringify(labelStates));
} finally {
  await browser.close();
}
