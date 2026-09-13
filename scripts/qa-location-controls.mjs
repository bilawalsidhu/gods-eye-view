#!/usr/bin/env node
/** Location UI acceptance; controlled search results isolate UI races from geocoder availability. */
import fs from 'node:fs';
import puppeteer from 'puppeteer';
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
page.on('pageerror', (e) => errors.push(e.message));
let failures = 0;
const check = (name, ok) => {
  console.log(`[${ok ? 'PASS' : 'FAIL'}] ${name}`);
  if (!ok) failures++;
};
try {
  await page.setViewport({ width: 1440, height: 900 });
  await page.goto(
    `${process.env.QA_BASE_URL || 'http://localhost:4173'}/?welcome=0`,
    { waitUntil: 'domcontentloaded' },
  );
  await page.waitForFunction(
    () =>
      window.__godsEyeView?.styleManager?._locationControls &&
      document.getElementById('loading-screen')?.classList.contains('hidden'),
    { timeout: 60000 },
  );
  await page.click('#location-bar-toggle');
  await page.click('[data-pin-target="location-bar"]');
  const cityId = await page.$eval(
    '.location-pill',
    (node) => node.dataset.locationId,
  );
  await page.click('.location-pill');
  await page.waitForFunction(() =>
    document.getElementById('poi-row').classList.contains('expanded'),
  );
  check(
    'native city selection highlights and expands its POIs',
    await page.evaluate(
      (id) =>
        window.__godsEyeView.styleManager._activeLocationId === id &&
        document.querySelector('.location-pill.active')?.dataset.locationId ===
          id,
      cityId,
    ),
  );
  await page.keyboard.press('w');
  check(
    'POI keyboard action selects the second landmark',
    await page.evaluate(
      () =>
        window.__godsEyeView.styleManager._activePoiIndex === 1 &&
        document.querySelector('.poi-pill.active')?.dataset.poiIndex === '1',
    ),
  );
  check(
    'orbit controls and indicator agree',
    await page.evaluate(() => {
      const ui = window.__godsEyeView.styleManager;
      ui.setOrbit(true);
      const active =
        ui.orbitController.active &&
        document.getElementById('orbit-indicator').classList.contains('active');
      ui.setOrbit(false);
      return (
        active &&
        !ui.orbitController.active &&
        !document.getElementById('orbit-indicator').classList.contains('active')
      );
    }),
  );
  await page.click('#search-toggle');
  await page.type('#location-search', 'qwerty');
  check(
    'typing in search leaves POI selection unchanged',
    await page.evaluate(
      () => window.__godsEyeView.styleManager._activePoiIndex === 1,
    ),
  );
  await page.evaluate(() => {
    const lookup = window.__godsEyeView.styleManager._locationLookup;
    window.__qaSearchRequests = [];
    lookup.search = (query, options) =>
      new Promise((resolve) =>
        window.__qaSearchRequests.push({ query, options, resolve }),
      );
    document.getElementById('location-search').value = 'First';
  });
  await page.keyboard.press('Enter');
  await page.waitForFunction(() => window.__qaSearchRequests.length === 1);
  await page.evaluate(() => {
    document.getElementById('location-search').value = 'Second';
    document.getElementById('location-search').focus();
  });
  await page.keyboard.press('Enter');
  await page.waitForFunction(() => window.__qaSearchRequests.length === 2);
  check(
    'second native submit aborts the first request and keeps current busy state',
    await page.evaluate(
      () =>
        window.__qaSearchRequests[0].options.signal.aborted &&
        document
          .getElementById('location-search')
          .classList.contains('searching'),
    ),
  );
  await page.evaluate(() =>
    window.__qaSearchRequests[1].resolve({
      label: 'Second landmark, Test city',
    }),
  );
  await page.waitForFunction(
    () =>
      window.__godsEyeView.styleManager._searchedLocationLabel ===
      'Second landmark, Test city',
  );
  await page.evaluate(() =>
    window.__qaSearchRequests[0].resolve({
      label: 'First landmark, Test city',
    }),
  );
  check(
    'late result cannot overwrite the current location readout or style',
    await page.evaluate(() => {
      const ui = window.__godsEyeView.styleManager;
      return (
        ui._searchedLocationLabel === 'Second landmark, Test city' &&
        ui._locationMiniCity.textContent.includes('Second landmark') &&
        ui._locationMiniPoi.textContent === 'Test city' &&
        ui.activeStyle === 'normal' &&
        !ui._locationSearch.classList.contains('searching')
      );
    }),
  );
  check(
    'cancelled POI expansion stays closed after a frame',
    await page.evaluate(async (id) => {
      const ui = window.__godsEyeView.styleManager;
      ui._expandPOIRow(id);
      ui._collapsePOIRow();
      await new Promise((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(resolve)),
      );
      return (
        !ui._poiRow.classList.contains('expanded') &&
        !ui._locationBarDivider.classList.contains('visible')
      );
    }, cityId),
  );
  await page.evaluate(
    (id) => window.__godsEyeView.styleManager._onCityPillClick(id),
    cityId,
  );
  await page.waitForFunction(() =>
    document.getElementById('poi-row').classList.contains('expanded'),
  );
  // Finish the camera's existing city flight before inspecting both layouts.
  await page.waitForFunction(
    () => !window.__godsEyeView.viewer.camera._currentFlight,
    { timeout: 10000 },
  );
  await page.evaluate(
    () =>
      new Promise((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(resolve)),
      ),
  );
  const settled = await page
    .waitForFunction(
      () => {
        const scene = window.__godsEyeView.viewer.scene;
        for (let index = 0; index < scene.primitives.length; index++) {
          const primitive = scene.primitives.get(index);
          if (
            typeof primitive.tilesLoaded === 'boolean' &&
            !primitive.tilesLoaded
          )
            return false;
        }
        return true;
      },
      { timeout: 60000 },
    )
    .then(
      () => true,
      () => false,
    );
  check('visible city tiles settle before screenshots', settled);
  fs.mkdirSync('qa-shots/location-controls', { recursive: true });
  await page.screenshot({ path: 'qa-shots/location-controls/desktop.png' });
  await page.setViewport({ width: 620, height: 900 });
  await page.waitForFunction(
    () =>
      document.getElementById('left-panel-stack')?.dataset.layoutMode ===
      'mobile',
  );
  await page.screenshot({ path: 'qa-shots/location-controls/narrow.png' });
  check(
    'native reset returns through the existing camera handoff',
    await page.evaluate(async () => {
      const ui = window.__godsEyeView.styleManager;
      ui._resetGlobeBtn.click();
      const pending = ui._globeResetPromise;
      if (!pending) return false;
      await pending;
      return (
        !ui.orbitController.active && !window.__godsEyeView.viewer.trackedEntity
      );
    }),
  );
  check(
    'destroyed controls cannot navigate or submit another lookup',
    await page.evaluate(() => {
      const ui = window.__godsEyeView.styleManager;
      const count = window.__qaSearchRequests.length;
      ui._locationControls.destroy();
      ui._locationLookup.destroy();
      const before = ui._navigationGeneration;
      ui._locationPills.querySelector('button').click();
      ui._resetGlobeBtn.click();
      ui._locationSearch.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }),
      );
      return (
        before === ui._navigationGeneration &&
        count === window.__qaSearchRequests.length
      );
    }),
  );
  check('no uncaught browser errors', errors.length === 0);
} finally {
  await browser.close();
}
console.log(`RESULT: ${failures} failures`);
process.exitCode = failures ? 1 : 0;
