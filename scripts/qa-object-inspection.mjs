#!/usr/bin/env node
// QA_BASE_URL=http://localhost:4193 node scripts/qa-object-inspection.mjs
// Synthetic live vessel selection, details, double-click focus and exact return.
import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import puppeteer from 'puppeteer';
import { chromeExecutablePath } from './qa-chrome.mjs';
const base = process.env.QA_BASE_URL || 'http://localhost:4173';
function assertCamera(actual, expected, label) {
  for (const key of ['position', 'direction', 'up'])
    for (const axis of ['x', 'y', 'z'])
      assert.ok(
        Math.abs(actual[key][axis] - expected[key][axis]) <
          (key === 'position' ? 1e-6 : 1e-12),
        `${label}: ${key}.${axis}`,
      );
}

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
  page.on('pageerror', (error) => console.log('PAGE ERROR:', error.message));
  await page.evaluateOnNewDocument(() => {
    window.__qaDoubleClicks = [];
    window.addEventListener('dblclick', (e) =>
      window.__qaDoubleClicks.push(e.target.tagName),
    );
  });
  await page.setViewport({ width: 1440, height: 950 });
  await page.evaluateOnNewDocument(() =>
    localStorage.setItem('gev:first-run-mission:v1', 'suppressed'),
  );
  await page.goto(base, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.waitForFunction(
    () =>
      window.__godsEyeView?.dataManager &&
      document.getElementById('loading-screen')?.classList.contains('hidden'),
    { timeout: 90000 },
  );
  if (process.env.QA_INSPECTION_THEME === 'cyber') {
    await page.evaluate(() =>
      window.__godsEyeView.styleManager._setHudVariant('cyber'),
    );
    await page.waitForFunction(
      () => document.documentElement.dataset.uiTheme === 'cyber',
    );
  }
  const fixture = [
    {
      mmsi: '990100001',
      name: 'QA SHIP ONE',
      lat: 51.93,
      lon: 3.91,
      speed: 8,
      course: 90,
      heading: 90,
      type: 'Cargo',
      destination: 'QA PORT',
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
  ];
  await page.evaluate(async (rows) => {
    const app = window.__godsEyeView;
    app.styleManager.beginLocationNavigation();
    app.viewer.camera.setView({
      destination: app.viewer.camera.position.constructor.fromDegrees(
        4.05,
        51.93,
        50000,
      ),
      orientation: { heading: 0.2, pitch: -1.4, roll: 0.03 },
    });
    await app.dataManager.setEnabled('ais-live-vessels', true);
    app.dataManager.layers
      .get('ais-live-vessels')
      .module.__focusEvidence.setVessels(rows);
  }, fixture);
  await page.waitForFunction(() =>
    window.__godsEyeView.dataManager.layers
      .get('ais-live-vessels')
      .module.__focusEvidence.snapshot()
      .every((row) => row.show && Number.isFinite(row.x)),
  );
  const camera = () =>
    page.evaluate(() => {
      const camera = window.__godsEyeView.viewer.camera;
      return {
        position: { ...camera.positionWC },
        direction: { ...camera.directionWC },
        up: { ...camera.upWC },
      };
    });
  const before = await camera();
  const marker = async (index) =>
    page.evaluate(
      (index) =>
        window.__godsEyeView.dataManager.layers
          .get('ais-live-vessels')
          .module.__focusEvidence.snapshot()[index],
      index,
    );
  let first = await marker(0);
  await page.mouse.click(first.x, first.y);
  await page.waitForFunction(
    () =>
      document.querySelector('#object-inspection-panel h3')?.textContent ===
        'QA SHIP ONE' &&
      !document
        .getElementById('object-inspection-panel')
        .classList.contains('collapsed'),
  );
  assertCamera(await camera(), before, 'single click preserves the overview');
  assert.ok(
    (
      await page.$eval('#object-inspection-panel', (el) => el.textContent)
    ).includes('QA PORT'),
  );
  fixture[0].speed = 18;
  await page.evaluate((rows) => {
    const app = window.__godsEyeView;
    app.dataManager.layers
      .get('ais-live-vessels')
      .module.testing._reconcileVesselsForTest(app.viewer, rows);
  }, fixture);
  await page.waitForFunction(() =>
    [...document.querySelectorAll('#object-inspection-panel dd')].some(
      (el) => el.textContent === '18',
    ),
  );
  const second = await marker(1);
  await page.mouse.click(second.x, second.y);
  await page.waitForFunction(
    () =>
      document.querySelector('#object-inspection-panel h3')?.textContent ===
      'QA SHIP TWO',
  );
  assertCamera(await camera(), before, 'switching objects keeps the overview');
  console.log('Single click, live refresh and object switching passed');
  // Real hit testing: programmatic button.click() cannot catch a transparent rail.
  const focusReceivesPointer = await page.$eval(
    '#inspection-focus',
    (button) => {
      const rect = button.getBoundingClientRect();
      const hit = document.elementFromPoint(
        rect.left + rect.width / 2,
        rect.top + rect.height / 2,
      );
      return button === hit || button.contains(hit);
    },
  );
  assert.ok(
    focusReceivesPointer,
    'Focus button must receive the pointer instead of the map canvas',
  );
  await page.click('#object-inspection-panel h3');
  assert.equal(
    await page.evaluate(
      () =>
        window.__godsEyeView.dataManager.layers
          .get('ais-live-vessels')
          .module.getSelectedInfo()?.mmsi,
    ),
    '990100002',
    'clicking panel text must preserve selection',
  );
  const beforeButton = await camera();
  await page.click('#inspection-focus');
  await page.waitForSelector('#restore-last-object-view');
  await page.waitForFunction(
    (previous) => {
      const current = window.__godsEyeView.viewer.camera.positionWC;
      return (
        Math.hypot(
          current.x - previous.x,
          current.y - previous.y,
          current.z - previous.z,
        ) > 100
      );
    },
    {},
    beforeButton.position,
  );
  assert.equal(
    await page.evaluate(
      () =>
        window.__godsEyeView.dataManager.layers
          .get('ais-live-vessels')
          .module.getSelectedInfo()?.mmsi,
    ),
    '990100002',
    'Focus button preserves selected vessel',
  );
  await page.click('#inspection-restore');
  await page.waitForSelector('#restore-last-object-view', { hidden: true });
  assertCamera(
    await camera(),
    beforeButton,
    'side-panel Restore returns the exact view',
  );
  const secondAfterRestore = await marker(1);
  await page.mouse.click(secondAfterRestore.x, secondAfterRestore.y);
  await page.waitForFunction(
    () =>
      document.querySelector('#object-inspection-panel h3')?.textContent ===
      'QA SHIP TWO',
  );
  console.log('Real panel clicks, Focus button and side-panel Restore passed');

  const preFocus = await camera();
  await page.mouse.click(second.x, second.y, { count: 2 });
  await new Promise((resolve) => setTimeout(resolve, 500));
  await page.waitForSelector('#restore-last-object-view');
  await page.waitForFunction(
    (previous) => {
      const current = window.__godsEyeView.viewer.camera.positionWC;
      return (
        Math.hypot(
          current.x - previous.x,
          current.y - previous.y,
          current.z - previous.z,
        ) > 100
      );
    },
    {},
    preFocus.position,
  );
  await page.click('#restore-last-object-view');
  await page.waitForSelector('#restore-last-object-view', { hidden: true });
  const restored = await camera();
  for (const key of ['position', 'direction', 'up'])
    for (const axis of ['x', 'y', 'z'])
      assert.ok(
        Math.abs(restored[key][axis] - preFocus[key][axis]) <
          (key === 'position' ? 1e-6 : 1e-12),
        `${key}.${axis} restored exactly`,
      );
  // Select again for a screenshot of the live details panel.
  first = await marker(0);
  await page.mouse.click(first.x, first.y);
  await page.waitForFunction(
    () =>
      document.querySelector('#object-inspection-panel h3')?.textContent ===
      'QA SHIP ONE',
  );
  await mkdir('qa-shots/object-inspection', { recursive: true });
  await page.screenshot({ path: 'qa-shots/object-inspection/details.png' });
  console.log(
    'PASS: single-click details, live telemetry, protected panel clicks, Focus and Restore buttons, double-click focus, exact camera return.',
  );
} finally {
  await browser.close();
}
