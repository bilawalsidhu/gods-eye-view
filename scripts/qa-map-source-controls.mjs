#!/usr/bin/env node
/** Browser acceptance for Map Source control lifecycle and truthful selection. */
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
page.on('pageerror', (error) => errors.push(error.message));
let failures = 0;
const check = (name, ok) => {
  console.log(`[${ok ? 'PASS' : 'FAIL'}] ${name}`);
  if (!ok) failures++;
};
try {
  await page.setViewport({ width: 1440, height: 900 });
  const url = new URL(process.env.QA_BASE_URL || 'http://127.0.0.1:4173');
  url.searchParams.set('welcome', '0');
  await page.goto(url.href, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(
    () => {
      const cover = document.getElementById('loading-screen');
      return (
        window.__godsEyeView?.styleManager?._mapSourceControls &&
        cover?.classList.contains('hidden') &&
        Number(getComputedStyle(cover).opacity) === 0
      );
    },
    { timeout: 60_000 },
  );
  await page.evaluate(() => {
    const manager = window.__godsEyeView.styleManager;
    const controller = manager.mapStackController;
    const original = controller.setStack;
    window.__qaMapSelections = [];
    controller.setStack = function (id) {
      window.__qaMapSelections.push(id);
      return original.call(this, id);
    };
    manager.setPanelCollapsed('control-panel', false, {
      persist: false,
      syncShare: false,
    });
  });
  await page.click('[data-stack-id="osm"]');
  await page.waitForFunction(
    () =>
      window.__godsEyeView.styleManager.mapStackController.getActiveId() ===
      'osm',
  );
  check(
    'a native chip click requests OSM exactly once',
    await page.evaluate(
      () =>
        window.__qaMapSelections.length === 1 &&
        window.__qaMapSelections[0] === 'osm',
    ),
  );
  check(
    'active chip and status follow the displayed OSM source',
    await page.evaluate(() => {
      const manager = window.__godsEyeView.styleManager;
      return (
        document
          .getElementById('map-stack-chips')
          .querySelector('[aria-pressed="true"]')?.dataset.stackId === 'osm' &&
        document.getElementById('map-stack-status').textContent ===
          manager.mapStackController.getState().activeStack.shortLabel
      );
    }),
  );
  check(
    'the public map action uses the same component and truthful result',
    await page.evaluate(async () => {
      const manager = window.__godsEyeView.styleManager;
      const result = await manager.setMapStack('esri-imagery');
      // The dock renders the published row on Vue's next flush.
      await new Promise((resolve) => setTimeout(resolve, 0));
      const active = manager.mapStackController.getActiveId();
      return (
        window.__qaMapSelections.at(-1) === 'esri-imagery' &&
        document
          .getElementById('map-stack-chips')
          .querySelector('[aria-pressed="true"]')?.dataset.stackId === active &&
        (result.ok || !!manager.mapStackController.getState().lastError)
      );
    }),
  );
  check(
    'refresh re-presents the chips without duplicating them',
    await page.evaluate(async () => {
      const manager = window.__godsEyeView.styleManager;
      manager._mapSourceControls.refresh();
      await new Promise((resolve) => setTimeout(resolve, 0));
      return (
        document.querySelectorAll('#map-stack-chips [data-stack-id="osm"]')
          .length === 1
      );
    }),
  );
  check(
    'refreshed chips still select once',
    await page.evaluate(async () => {
      const before = window.__qaMapSelections.length;
      document
        .getElementById('map-stack-chips')
        .querySelector('[data-stack-id="osm"]')
        .click();
      await Promise.resolve();
      return window.__qaMapSelections.length === before + 1;
    }),
  );
  await page.waitForFunction(
    () =>
      window.__godsEyeView.styleManager.mapStackController.getActiveId() ===
      'osm',
  );
  await page.evaluate(async () => {
    const manager = window.__godsEyeView.styleManager;
    await manager.setMapStack('photoreal');
    manager.setPanelCollapsed('control-panel', false, {
      persist: false,
      syncShare: false,
    });
    document.querySelector('.map-stack-chip.active')?.focus();
  });
  await page.evaluate(() => {
    const viewer = window.__godsEyeView.viewer;
    viewer.camera.cancelFlight?.();
    viewer.scene.tweens?.removeAll?.();
    viewer.camera.setView({
      destination: viewer.scene.globe.ellipsoid.cartographicToCartesian({
        longitude: (-97.7431 * Math.PI) / 180,
        latitude: (30.2568 * Math.PI) / 180,
        height: 1200,
      }),
      orientation: { heading: 0, pitch: -0.85, roll: 0 },
    });
    viewer.scene.requestRender();
  });
  await page.evaluate(
    () =>
      new Promise((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(resolve)),
      ),
  );
  const settled = await page
    .waitForFunction(
      () => {
        const primitives = window.__godsEyeView.viewer.scene.primitives;
        for (let i = 0; i < primitives.length; i++) {
          const primitive = primitives.get(i);
          if (
            typeof primitive.tilesLoaded === 'boolean' &&
            !primitive.tilesLoaded
          )
            return false;
        }
        return true;
      },
      { timeout: 60_000 },
    )
    .then(
      () => true,
      () => false,
    );
  check('visible tile content settles before visual captures', settled);
  fs.mkdirSync('qa-shots/map-source-controls', { recursive: true });
  await page.screenshot({ path: 'qa-shots/map-source-controls/desktop.png' });
  await page.setViewport({ width: 620, height: 900 });
  await page.waitForFunction(
    () =>
      document.getElementById('left-panel-stack')?.dataset.layoutMode ===
      'mobile',
  );
  await page.evaluate(() =>
    window.__godsEyeView.styleManager.setPanelCollapsed(
      'control-panel',
      false,
      { persist: false, syncShare: false },
    ),
  );
  await page.screenshot({ path: 'qa-shots/map-source-controls/narrow.png' });
  check(
    'destroyed controls cannot issue requests from retained chips',
    await page.evaluate(async () => {
      const manager = window.__godsEyeView.styleManager;
      const before = window.__qaMapSelections.length;
      manager._mapSourceControls.destroy();
      document
        .getElementById('map-stack-chips')
        .querySelector('[data-stack-id="osm"]')
        .click();
      const result = await manager._mapSourceControls.select('esri-imagery');
      return result === null && window.__qaMapSelections.length === before;
    }),
  );
  check('no uncaught browser errors', errors.length === 0);
  if (errors.length) console.log(JSON.stringify(errors));
} finally {
  await browser.close();
}
console.log(`RESULT: ${failures} failures`);
process.exitCode = failures ? 1 : 0;
