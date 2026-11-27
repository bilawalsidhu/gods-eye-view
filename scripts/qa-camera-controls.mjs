#!/usr/bin/env node
/** Camera controls browser acceptance with controlled sources, images and terrain. */
import fs from 'node:fs';
import puppeteer from 'puppeteer';
const origin = process.env.QA_BASE_URL || 'http://localhost:4173';
const selectAllModifier = process.platform === 'darwin' ? 'Meta' : 'Control';
const sources = [
  {
    id: 'qa-camera-a',
    name: 'QA Camera A',
    lat: 30.2747,
    lon: -97.7403,
    headingDeg: 30,
  },
  {
    id: 'qa-camera-b',
    name: 'QA Camera B',
    lat: 30.2672,
    lon: -97.7431,
    headingDeg: 200,
  },
].map((camera) => ({
  ...camera,
  city: 'Austin',
  cityId: 'austin',
  provider: 'QA camera fixture',
  feedType: 'snapshot',
  feedConfigured: true,
  pitchDeg: -18,
  fovDeg: 60,
  rangeM: 300,
  mountHeightM: 8,
}));
const browser = await puppeteer.launch({
  headless: true,
  args: [
    '--no-sandbox',
    ...(process.platform === 'darwin'
      ? ['--use-angle=metal', '--enable-gpu']
      : ['--use-gl=angle', '--use-angle=swiftshader']),
  ],
});
const page = await browser.newPage();
const errors = [];
page.on('pageerror', (error) => errors.push(error.message));
let failures = 0;
const check = (name, ok, detail) => {
  console.log(
    `[${ok ? 'PASS' : 'FAIL'}] ${name}${detail ? ` — ${JSON.stringify(detail)}` : ''}`,
  );
  if (!ok) failures++;
};
let delayCameraA = false;
const delayedFrames = new Set();
try {
  await page.setViewport({ width: 1440, height: 900 });
  await page.setRequestInterception(true);
  page.on('request', (request) => {
    const url = new URL(request.url());
    if (url.origin !== new URL(origin).origin) return void request.continue();
    const json = (body) =>
      request.respond({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(body),
      });
    if (url.pathname === '/api/cctv/sources') return void json({ sources });
    if (url.pathname === '/api/cctv/health')
      return void json({
        cameras: sources.map((camera) => ({
          id: camera.id,
          status: 'ok',
          sourceKind: 'snapshot',
          label: 'QA camera fixture',
        })),
      });
    if (url.pathname.startsWith('/api/cctv/frame/')) {
      const cameraA = url.pathname.endsWith('qa-camera-a');
      const respond = () =>
        request
          .respond({
            status: 200,
            contentType: 'image/svg+xml',
            headers: { 'Cache-Control': 'no-store' },
            body: `<svg xmlns="http://www.w3.org/2000/svg" width="640" height="360"><rect width="640" height="360" fill="${cameraA ? '#16364d' : '#254b32'}"/><path d="M0 260L640 130M240 0L420 360" stroke="#97acb7" stroke-width="26"/><text x="30" y="55" fill="white" font-size="30">QA CAMERA ${cameraA ? 'A' : 'B'}</text></svg>`,
          })
          .catch(() => {});
      if (cameraA && delayCameraA) delayedFrames.add(respond);
      else void respond();
      return;
    }
    if (url.pathname === '/api/terrain/heights') {
      const points = (url.searchParams.get('points') || '')
        .split(';')
        .filter(Boolean);
      return void json({
        results: points.map((point) => {
          const [lon, lat] = point.split(',').map(Number);
          return { lon, lat, elevation: 0, geoid: 0, ellipsoid: 0 };
        }),
      });
    }
    if (url.pathname === '/api/openai/hud-summary')
      return void json({ summary: 'QA camera controls' });
    void request.continue();
  });
  await page.goto(`${origin}/?welcome=0`, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(
    () =>
      window.__godsEyeView?.styleManager?._cctvControls &&
      window.__godsEyeView?.dataManager?.layers?.has('cctv') &&
      document.getElementById('loading-screen')?.classList.contains('hidden'),
    { timeout: 60000 },
  );
  // Cameras is switched on from its Data Layers row; a camera's card opens in
  // Context, and its tools are the card's Camera settings tab.
  const cctvRow = '#data-toggles [data-layer-id="cctv"]';
  const toggleCctv = async () => {
    await page.evaluate(() =>
      window.__godsEyeView.styleManager.setPanelCollapsed('data-panel', false, {
        persist: false,
        syncShare: false,
      }),
    );
    await page.waitForSelector(`${cctvRow} .data-toggle-btn`, {
      visible: true,
    });
    await page.click(`${cctvRow} .data-toggle-btn`);
  };
  const frameShows = (cameraId) =>
    page.waitForFunction(
      (id) => {
        const frame = document.getElementById('cctv-frame');
        return (
          frame.dataset.cameraId === id && frame.classList.contains('active')
        );
      },
      {},
      cameraId,
    );
  const openCameraCard = async (cameraId) => {
    await page.evaluate(async (id) => {
      const [{ applicationPinia }, { useEntityCardStore }] = await Promise.all([
        import('/src/ui/vueRuntime.js'),
        import('/src/ui/stores/entityCard.js'),
      ]);
      useEntityCardStore(applicationPinia()).open({ layerId: 'cctv', id });
      window.__godsEyeView.styleManager.setPanelCollapsed(
        'global-context-panel',
        false,
        { persist: false, syncShare: false },
      );
    }, cameraId);
    await page.waitForFunction(
      (id) =>
        window.__godsEyeView.dataManager.layers.get('cctv').module.getUIState()
          .activeCameraId === id &&
        Boolean(document.querySelector('#entity-card[data-layer="cctv"]')),
      {},
      cameraId,
    );
  };
  const showCameraSettings = async () => {
    await page.waitForSelector('#context-tab-camera', { visible: true });
    await page.click('#context-tab-camera');
    await page.waitForSelector('#cctv-tools-slot #cctv-tools', {
      visible: true,
    });
  };
  await toggleCctv();
  await page.waitForFunction(
    () =>
      window.__godsEyeView.dataManager.layers.get('cctv').module.getUIState()
        .cameras.length === 2,
    { timeout: 30000 },
  );
  check(
    'CCTV enable uses the supplied two-camera catalog',
    await page.evaluate(
      () =>
        window.__godsEyeView.dataManager.layers.get('cctv').module.getUIState()
          .cameras.length === 2,
    ),
  );
  await openCameraCard('qa-camera-a');
  await frameShows('qa-camera-a');
  const state = () =>
    page.evaluate(() =>
      window.__godsEyeView.dataManager.layers.get('cctv').module.getUIState(),
    );
  check(
    'selected camera, decoded preview and card agree',
    await page.evaluate(() => {
      const camera = window.__godsEyeView.dataManager.layers
        .get('cctv')
        .module.getUIState().activeCamera;
      return (
        camera.id === 'qa-camera-a' &&
        document.getElementById('cctv-frame').src.includes('qa-camera-a') &&
        document
          .querySelector('#entity-card[data-layer="cctv"]')
          .textContent.includes('QA Camera A')
      );
    }),
  );
  await showCameraSettings();
  const coverage = (await state()).coverageMode;
  const modes = [];
  for (let i = 0; i < 3; i++) {
    await page.click('#cctv-coverage-btn');
    modes.push((await state()).coverageMode);
  }
  check(
    'coverage cycles through all three modes and returns to its starting state',
    new Set(modes).size === 3 && modes.at(-1) === coverage,
    modes,
  );
  const projection = (await state()).showProjection;
  await page.click('#cctv-projection-btn');
  check(
    'projection control updates the layer state',
    (await state()).showProjection === !projection,
  );
  await page.click('#cctv-projection-btn');
  // Prev and Next are the Cameras row's chips.
  await page.evaluate(
    (row) =>
      document.querySelector(`${row} [data-chip-id="next-camera"]`).click(),
    cctvRow,
  );
  await page.waitForFunction(
    () =>
      window.__godsEyeView.dataManager.layers.get('cctv').module.getUIState()
        .activeCameraId === 'qa-camera-b',
  );
  await page.evaluate(
    (row) =>
      document.querySelector(`${row} [data-chip-id="previous-camera"]`).click(),
    cctvRow,
  );
  await page.waitForFunction(
    () =>
      window.__godsEyeView.dataManager.layers.get('cctv').module.getUIState()
        .activeCameraId === 'qa-camera-a',
  );
  check(
    'the Cameras row Next and Previous return to the original camera',
    (await state()).activeCameraId === 'qa-camera-a',
  );
  await openCameraCard('qa-camera-a');
  await showCameraSettings();
  for (const [selector, key] of [
    ['#cctv-auto-hop-btn', 'autoHop'],
    ['#cctv-adjust-btn', 'calibrationMode'],
  ]) {
    const before = (await state())[key];
    await page.click(selector);
    const changed = (await state())[key] === !before;
    await page.click(selector);
    check(
      `${key} control changes and restores the layer setting`,
      changed && (await state())[key] === before,
    );
  }
  // Auto Hop can legitimately advance immediately; restore the calibration target.
  await openCameraCard('qa-camera-a');
  await showCameraSettings();
  const heading = (await state()).activeCamera.headingDeg;
  const chip = '#cctv-tools .cctv-cal-value[data-cal-field="heading"]';
  await page.click(chip);
  await page.focus(`${chip} input`);
  await page.keyboard.down(selectAllModifier);
  await page.keyboard.press('a');
  await page.keyboard.up(selectAllModifier);
  await page.keyboard.type(String(heading + 10));
  await page.keyboard.press('Enter');
  check(
    'native calibration editing commits an offset for the selected camera',
    Math.abs((await state()).activeCamera.headingDeg - (heading + 10)) < 0.01,
  );
  await page.click('#cctv-calib-save-btn');
  check(
    'Save persists the selected camera calibration',
    await page.evaluate(() =>
      Boolean(
        JSON.parse(
          localStorage.getItem('godsEyeView.cctv.calibration.v2') || '{}',
        )['qa-camera-a'],
      ),
    ),
  );
  await page.click('#cctv-calib-reset-btn');
  check(
    'Reset restores the original pose',
    Math.abs((await state()).activeCamera.headingDeg - heading) < 0.01,
  );
  await page.click(chip);
  await page.focus(`${chip} input`);
  await page.keyboard.down(selectAllModifier);
  await page.keyboard.press('a');
  await page.keyboard.up(selectAllModifier);
  await page.keyboard.type('110');
  await page.keyboard.press('Escape');
  check(
    'Escape cancels editing without leaving Camera settings',
    (await page.evaluate(
      () =>
        !document.querySelector('.cctv-cal-input') &&
        !document
          .getElementById('global-context-panel')
          .classList.contains('collapsed') &&
        Boolean(document.querySelector('#cctv-tools-slot #cctv-tools')),
    )) && Math.abs((await state()).activeCamera.headingDeg - heading) < 0.01,
  );
  if (!(await page.$('#cctv-tools-slot #cctv-tools'))) {
    await openCameraCard('qa-camera-a');
    await showCameraSettings();
  }
  await page.click(chip);
  await page.evaluate(() => {
    const input = document.querySelector('.cctv-cal-input');
    input.value = '110';
    window.__godsEyeView.dataManager.layers
      .get('cctv')
      .module.selectCamera('qa-camera-b');
    input.dispatchEvent(new Event('blur'));
  });
  check(
    'an external camera selection cancels the prior calibration editor',
    (await state()).activeCamera.id === 'qa-camera-b' &&
      Math.abs((await state()).activeCamera.headingDeg - 200) < 0.01 &&
      (await page.$('.cctv-cal-input')) === null,
  );
  await frameShows('qa-camera-b');
  await page.setCacheEnabled(false);
  delayCameraA = true;
  await page.evaluate(() =>
    window.__godsEyeView.dataManager.layers
      .get('cctv')
      .module.selectCamera('qa-camera-a'),
  );
  await page.waitForFunction(
    () =>
      document.getElementById('cctv-frame').dataset.cameraId ===
        'qa-camera-a' &&
      document.getElementById('cctv-frame').dataset.loading === 'true',
  );
  await page.evaluate(() => {
    const image =
      window.__godsEyeView.styleManager._cctvControls._cctvFramePreloader;
    window.__qaLateCctvImage = image;
    window.__qaLateCctvImageLoaded = false;
    image.addEventListener(
      'load',
      () => {
        window.__qaLateCctvImageLoaded = true;
      },
      { once: true },
    );
  });
  check(
    'a newly selected camera clears old pixels while its frame loads',
    await page.$eval(
      '#cctv-frame',
      (element) => !element.classList.contains('active'),
    ),
  );
  await page.evaluate(() =>
    window.__godsEyeView.dataManager.layers
      .get('cctv')
      .module.selectCamera('qa-camera-b'),
  );
  await frameShows('qa-camera-b');
  delayCameraA = false;
  await Promise.all([...delayedFrames].map((respond) => respond()));
  delayedFrames.clear();
  await page.waitForFunction(() => window.__qaLateCctvImageLoaded);
  check(
    'late frames cannot overwrite the latest camera selection',
    await page.$eval(
      '#cctv-frame',
      (image) =>
        image.dataset.cameraId === 'qa-camera-b' &&
        image.src.includes('qa-camera-b'),
    ),
  );
  delayCameraA = false;
  await toggleCctv();
  await page.waitForFunction(
    () => !window.__godsEyeView.dataManager.isEnabled('cctv'),
  );
  const disabledCleanly = await page.$eval(
    '#cctv-frame',
    (image) => !image.getAttribute('src') && image.dataset.cameraId === '',
  );
  check(
    'disable takes the Camera settings tab away',
    await page
      .waitForFunction(() => !document.getElementById('context-tab-camera'), {
        timeout: 5000,
      })
      .then(
        () => true,
        () => false,
      ),
  );
  await toggleCctv();
  await page.waitForFunction(() =>
    window.__godsEyeView.dataManager.isEnabled('cctv'),
  );
  await openCameraCard('qa-camera-a');
  await frameShows('qa-camera-a');
  await page.waitForFunction(() => {
    const image = document.querySelector(
      '#entity-card[data-layer="cctv"] .cctv-preview__frame img',
    );
    return (
      image?.checkVisibility({
        visibilityProperty: true,
        opacityProperty: true,
      }) &&
      image.naturalWidth > 0 &&
      new URL(image.currentSrc).pathname === '/api/cctv/frame/qa-camera-a'
    );
  });
  check(
    'disable clears the preview and re-enable reacquires the camera frame',
    disabledCleanly,
  );
  fs.mkdirSync('qa-shots/camera-controls', { recursive: true });
  await page.screenshot({ path: 'qa-shots/camera-controls/desktop.png' });
  await page.evaluate(() => {
    const camera = window.__godsEyeView.viewer.camera;
    camera.setView({
      orientation: {
        heading: camera.heading + Math.PI / 3,
        pitch: -0.6,
        roll: 0,
      },
    });
  });
  await new Promise((resolve) => setTimeout(resolve, 700));
  await page.screenshot({ path: 'qa-shots/camera-controls/angle.png' });
  await page.setViewport({ width: 390, height: 844 });
  await new Promise((resolve) => setTimeout(resolve, 700));
  // Phones present a camera's card in the Context tab's sheet.
  await page.click('#mobile-tab-bar [data-mobile-sheet="context"]');
  await new Promise((resolve) => setTimeout(resolve, 400));
  await page.screenshot({ path: 'qa-shots/camera-controls/narrow.png' });
  check(
    'narrow camera card remains within the viewport',
    await page.$eval('#entity-card[data-layer="cctv"]', (card) => {
      const rect = card.getBoundingClientRect();
      return rect.width > 0 && rect.left >= 0 && rect.right <= innerWidth + 1;
    }),
  );
  await page.evaluate(() => window.__godsEyeView.styleManager.dispose());
  check(
    'CCTV controller is destroyed with the real UI',
    await page.evaluate(
      () => window.__godsEyeView.styleManager._cctvControls.destroyed,
    ),
  );
  check(
    'camera controls produce no uncaught browser errors',
    errors.length === 0,
    errors,
  );
} finally {
  await Promise.all([...delayedFrames].map((respond) => respond()));
  await browser.close();
}
if (failures) process.exitCode = 1;
