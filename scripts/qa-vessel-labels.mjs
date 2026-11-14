// Both vessel-label paths: civilian details on click, military detection names.
// QA_BASE_URL=http://localhost:4173 node scripts/qa-vessel-labels.mjs
import assert from 'node:assert/strict';
import puppeteer from 'puppeteer';

const rows = [
  { mmsi: '990100001', name: 'QA CARGO', type: 'Cargo', lat: 51.93, lon: 3.91 },
  {
    mmsi: '990100002',
    name: 'QA TANKER',
    type: 'Tanker',
    lat: 52.05,
    lon: 4.19,
  },
  { mmsi: '990100003', name: 'QA MILITARY', type: '35', lat: 51.85, lon: 4.05 },
].map((row) => ({ ...row, speed: 0, course: 0, heading: 0 }));
const browser = await puppeteer.launch({ headless: true });
try {
  const page = await browser.newPage();
  await page.setViewport({ width: 1440, height: 950 });
  await page.setRequestInterception(true);
  page.on('request', (request) => {
    if (new URL(request.url()).pathname === '/api/vessels')
      void request.respond({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          rows,
          status: 'open',
          lastMessageAt: Date.now(),
          complete: true,
        }),
      });
    else void request.continue();
  });
  await page.goto(
    `${process.env.QA_BASE_URL || 'http://localhost:4173'}/?welcome=0#v=2&lat=51.93&lon=4.05&alt=50000&pitch=-90&style=normal&hud=minimal&hv=1&dm=DENSE&dd=100&map=osm&l=`,
    { waitUntil: 'domcontentloaded', timeout: 90000 },
  );
  await page.waitForFunction(
    () =>
      window.__godsEyeView?.dataManager &&
      document.getElementById('loading-screen')?.classList.contains('hidden'),
    { timeout: 90000 },
  );
  await page.evaluate(async (fixtures) => {
    const app = window.__godsEyeView;
    for (const [id, entry] of app.dataManager.layers)
      if (entry.enabled) await app.dataManager.setEnabled(id, false);
    app.styleManager.beginLocationNavigation();
    app.viewer.camera.cancelFlight();
    app.viewer.camera.setView({
      destination: app.viewer.camera.position.constructor.fromDegrees(
        4.05,
        51.93,
        50000,
      ),
      orientation: { heading: 0, pitch: -Math.PI / 2, roll: 0 },
    });
    await app.dataManager.setEnabled('ais-live-vessels', true);
    const layer = app.dataManager.layers.get('ais-live-vessels').module;
    const result = layer.__focusEvidence.setVessels(fixtures);
    if (!result.ok || result.count !== 3)
      throw new Error('fixture reconciliation failed');
    app.styleManager.setDetection({
      enabled: true,
      densityPct: 100,
      allocationStrategy: 'elastic',
    });
    app.viewer.scene.requestRender();
  }, rows);
  await page.waitForFunction(
    () => {
      const app = window.__godsEyeView;
      const d = app.styleManager.getDetectionDiagnostics();
      const markers = app.dataManager.layers
        .get('ais-live-vessels')
        .module.__focusEvidence.snapshot();
      return (
        markers.length === 3 &&
        markers.every((m) => m.show) &&
        d?.labelsByLayer?.['ais-live-vessels'] === 1
      );
    },
    { timeout: 20000 },
  );
  const inspect = () =>
    page.evaluate(() => {
      const app = window.__godsEyeView;
      const layer = app.dataManager.layers.get('ais-live-vessels').module;
      return {
        selected: layer.getSelectedInfo()?.mmsi || null,
        cardCount:
          window.__gevWorldOverlay.getDiagnostics().entriesBySource[
            'ais-live-vessels'
          ] || 0,
        labels: app.styleManager.getDetectionDiagnostics()?.labeledKeys || [],
        objects: layer
          .getDetectableObjects()
          .map(({ sourceId, suppressLabel, skipLabel }) => ({
            sourceId,
            suppressLabel,
            skipLabel,
          })),
      };
    });
  const assertCivilianNamesHidden = (state) => {
    for (const id of ['990100001', '990100002']) {
      assert.ok(
        !state.labels.some((key) => key.includes(id)),
        `civilian ${id} leaked a detection name`,
      );
      const object = state.objects.find((o) => o.sourceId === id);
      if (object) assert.equal(object.suppressLabel, true);
    }
  };
  const ambient = await inspect();
  assert.equal(ambient.cardCount, 0);
  assertCivilianNamesHidden(ambient);
  assert.ok(
    ambient.labels.some((key) => key.includes('990100003')),
    'military names remain eligible',
  );
  console.log(JSON.stringify({ phase: 'ambient', ...ambient }));
  const marker = await page.evaluate(() =>
    window.__godsEyeView.dataManager.layers
      .get('ais-live-vessels')
      .module.__focusEvidence.snapshot()
      .find((row) => row.id === '990100001'),
  );
  await page.mouse.click(marker.x, marker.y);
  await page.waitForFunction(
    () =>
      window.__godsEyeView.dataManager.layers
        .get('ais-live-vessels')
        .module.getSelectedInfo()?.mmsi === '990100001',
  );
  const selected = await inspect();
  assert.equal(
    selected.cardCount,
    1,
    'click reveals the selected ship detail card',
  );
  assertCivilianNamesHidden(selected);
  console.log(JSON.stringify({ phase: 'clicked', ...selected }));
  await page.keyboard.press('Escape');
  await page.waitForFunction(
    () =>
      !window.__godsEyeView.dataManager.layers
        .get('ais-live-vessels')
        .module.getSelectedInfo(),
  );
  const cleared = await inspect();
  assert.equal(cleared.cardCount, 0);
  assertCivilianNamesHidden(cleared);
  console.log(JSON.stringify({ phase: 'cleared', ...cleared }));
  console.log(
    'PASS: civilian names appear only after selection; military labels remain available.',
  );
} finally {
  // Chromium can exit while inherited stdio keeps Puppeteer's close pending.
  // Bound teardown without swallowing an assertion failure from the test body.
  let timeout;
  try {
    await Promise.race([
      browser.close(),
      new Promise((resolve) => {
        timeout = setTimeout(resolve, 5000);
      }),
    ]);
  } finally {
    clearTimeout(timeout);
    await browser.disconnect();
    const child = browser.process();
    if (child?.exitCode === null) child.kill('SIGKILL');
    for (const pipe of child?.stdio || []) pipe?.destroy?.();
  }
}
