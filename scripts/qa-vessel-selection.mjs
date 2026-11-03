#!/usr/bin/env node
// Selection-only AIS details, using synthetic data and the real map click path.
// QA_BASE_URL=http://localhost:4192 node scripts/qa-vessel-selection.mjs
import assert from 'node:assert/strict';
import puppeteer from 'puppeteer';
import { chromeExecutablePath } from './qa-chrome.mjs';
const base = process.env.QA_BASE_URL || 'http://localhost:4173';
const browser = await puppeteer.launch({
  headless: true,
  executablePath: chromeExecutablePath(),
  args: [
    '--no-sandbox',
    '--use-gl=angle',
    '--use-angle=metal',
    '--enable-webgl',
  ],
});
try {
  const page = await browser.newPage();
  await page.setViewport({ width: 1440, height: 950 });
  await page.evaluateOnNewDocument(() =>
    localStorage.setItem('gev:first-run-mission:v1', 'suppressed'),
  );
  await page.goto(base, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.waitForFunction(() => window.__godsEyeView?.dataManager, {
    timeout: 60000,
  });
  await page.waitForFunction(
    () =>
      document.getElementById('loading-screen')?.classList.contains('hidden'),
    { timeout: 90000 },
  );
  await page.evaluate(async () => {
    const app = window.__godsEyeView;
    app.styleManager.beginLocationNavigation();
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
    const result = layer.__focusEvidence.setVessels([
      {
        mmsi: '990100001',
        name: 'QA SHIP ONE',
        lat: 51.93,
        lon: 3.91,
        speed: 8,
        course: 90,
        heading: 90,
        type: 'Cargo',
      },
      {
        mmsi: '990100002',
        name: 'QA SHIP TWO',
        lat: 52.05,
        lon: 4.19,
        speed: 12,
        course: 180,
        heading: 180,
        type: 'Tanker',
      },
    ]);
    if (!result.ok || result.count !== 2)
      throw new Error('Synthetic fixture failed');
    app.viewer.scene.requestRender();
  });
  await page.waitForFunction(() =>
    window.__godsEyeView.dataManager.layers
      .get('ais-live-vessels')
      .module.__focusEvidence.snapshot()
      .every(
        (row) => row.show && Number.isFinite(row.x) && Number.isFinite(row.y),
      ),
  );
  const state = () =>
    page.evaluate(() => ({
      camera: window.__godsEyeView.styleManager.getCameraState(),
      selected:
        window.__godsEyeView.dataManager.layers
          .get('ais-live-vessels')
          .module.getSelectedInfo()?.mmsi ?? null,
      entries:
        window.__gevWorldOverlay.getDiagnostics().entriesBySource[
          'ais-live-vessels'
        ] || 0,
    }));
  console.log('Vessels visible');
  const before = await state();
  assert.equal(before.entries, 0, 'no ambient vessel details');
  const markers = await page.evaluate(() =>
    window.__godsEyeView.dataManager.layers
      .get('ais-live-vessels')
      .module.__focusEvidence.snapshot(),
  );
  for (const marker of markers) {
    await page.mouse.click(marker.x, marker.y);
    await page.waitForFunction(
      (id) =>
        window.__godsEyeView.dataManager.layers
          .get('ais-live-vessels')
          .module.getSelectedInfo()?.mmsi === id,
      {},
      marker.id,
    );
    const selected = await state();
    assert.equal(selected.entries, 1, 'only the selected vessel has a card');
    assert.deepEqual(
      selected.camera,
      before.camera,
      'selection preserves the overview',
    );
  }
  await page.keyboard.press('Escape');
  const cleared = await state();
  assert.equal(cleared.selected, null);
  assert.equal(cleared.entries, 0, 'deselection clears all vessel details');
  console.log(
    'PASS: visible ship icons, no ambient cards, click-to-show details, replace selection, Escape clears, camera unchanged.',
  );
} finally {
  await browser.close();
}
