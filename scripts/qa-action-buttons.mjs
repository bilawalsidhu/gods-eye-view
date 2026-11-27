#!/usr/bin/env node
/**
 * Scenes action-button acceptance, with the CCTV tools' Save and Reset,
 * against dev or production preview:
 * QA_BASE_URL=http://127.0.0.1:4179 node scripts/qa-action-buttons.mjs
 * Uses the installed CCTV controller with fixture camera/action ports to prove
 * native dispatch/disabled/teardown without providers or world calibration writes.
 * Real Scene authoring/playback remains covered by qa-scene-controls.mjs.
 */
import fs from 'node:fs';
import puppeteer from 'puppeteer';

const browser = await puppeteer.launch({
  headless: true,
  args: ['--use-gl=angle', '--use-angle=swiftshader'],
});
const page = await browser.newPage();
const errors = [];
page.on('pageerror', (error) => errors.push(error.message));
let failures = 0;
const check = (name, passed, detail) => {
  console.log(`[${passed ? 'PASS' : 'FAIL'}] ${name}`);
  if (!passed) {
    failures++;
    console.log(JSON.stringify(detail));
  }
};
const shots = 'qa-shots/action-buttons';
fs.mkdirSync(shots, { recursive: true });

try {
  await page.setViewport({ width: 1440, height: 900 });
  const base = process.env.QA_BASE_URL || 'http://127.0.0.1:4179';
  const fixture = {
    id: 'a',
    city: 'Fixture',
    name: 'A',
    lat: 30.27,
    lon: -97.74,
  };
  await page.setRequestInterception(true);
  page.on('request', (request) => {
    const url = new URL(request.url());
    if (
      url.origin !== new URL(base).origin ||
      !url.pathname.startsWith('/api/cctv/')
    )
      return void request.continue();
    const body =
      url.pathname === '/api/cctv/sources'
        ? { sources: [fixture] }
        : { cameras: [] };
    return void request.respond({
      status: ['/api/cctv/sources', '/api/cctv/health'].includes(url.pathname)
        ? 200
        : 404,
      contentType: 'application/json',
      body: JSON.stringify(body),
    });
  });
  await page.goto(`${base}/?welcome=0`, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(
    () =>
      window.__godsEyeView?.styleManager?._cctvControls &&
      document.getElementById('loading-screen')?.classList.contains('hidden'),
    { timeout: 60000 },
  );
  const inventory = await page.evaluate(() => {
    const ids = [
      'scene-new-btn',
      'scene-delete-btn',
      'scene-capture-btn',
      'scene-update-shot-btn',
      'scene-start-btn',
      'scene-stop-btn',
      'scene-next-btn',
      'scene-export-btn',
      'scene-import-btn',
      'scene-download-btn',
    ];
    const ordinary = ids.map((id) => document.getElementById(id));
    const generated = [
      ...document.querySelectorAll(
        '.scene-shot-btn, [data-director-authoring] button',
      ),
    ];
    const toggles = [
      'cctv-coverage-btn',
      'cctv-auto-hop-btn',
      'cctv-projection-btn',
      'cctv-adjust-btn',
    ].map((id) => document.getElementById(id));
    return {
      shared: [...ordinary, ...generated].every(
        (node) =>
          node?.type === 'button' &&
          node.classList.contains('gev-action-button'),
      ),
      generated: generated.length,
      layout: ordinary.every((node) => {
        const style = getComputedStyle(node);
        return style.minWidth === '72px' && style.flexGrow === '1';
      }),
      togglesSeparate: toggles.every(
        (node) => node && !node.classList.contains('gev-action-button'),
      ),
      compactDanger: !!document.querySelector(
        '.scene-shot-danger.gev-action-button--compact.gev-action-button--danger',
      ),
    };
  });
  check(
    'static and generated actions share the native component',
    inventory.shared && inventory.generated >= 4 && inventory.compactDanger,
    inventory,
  );
  check(
    'persistent CCTV toggles retain their existing controls',
    inventory.togglesSeparate,
  );
  check('ordinary actions retain their panel sizing', inventory.layout);

  await page.evaluate(async () => {
    const { dataManager, styleManager } = window.__godsEyeView;
    await dataManager.setEnabled('cctv', true);
    styleManager.setPanelCollapsed('global-context-panel', false, {
      persist: false,
      syncShare: false,
    });
  });
  const cameraRow = '[data-list-card="cctv"] [data-list-key="a"]';
  await page.waitForSelector(cameraRow, { visible: true });
  await page.click(cameraRow);
  await page.waitForSelector('#context-tab-camera', { visible: true });
  await page.click('#context-tab-camera');
  await page.evaluate(() => {
    const owner = window.__godsEyeView.styleManager._cctvControls;
    window.__qaButtonCalls = [];
    owner.actions = {
      ...owner.actions,
      setParams: (...args) => window.__qaButtonCalls.push(['params', ...args]),
      showToast: () => {},
    };
  });
  for (const action of ['save', 'reset']) {
    const button = `#cctv-tools-slot #cctv-calib-${action}-btn:enabled`;
    await page.waitForSelector(button, { visible: true });
    await page.focus(button);
    await page.keyboard.press('Enter');
  }
  const calibration = await page.evaluate(() => window.__qaButtonCalls);
  check(
    'Save and Reset retain camera identity and user-origin dispatch',
    JSON.stringify(calibration) ===
      JSON.stringify([
        [
          'params',
          { selectedCameraId: 'a', calibration: { cameraId: 'a', save: true } },
          { origin: 'user' },
        ],
        [
          'params',
          {
            selectedCameraId: 'a',
            calibration: { cameraId: 'a', reset: true },
          },
          { origin: 'user' },
        ],
      ]),
    calibration,
  );
  for (const width of [1440, 620, 390]) {
    await page.setViewport({ width, height: 900 });
    for (const panel of ['scene-panel']) {
      await page.evaluate((panel) => {
        window.__godsEyeView.styleManager.setPanelCollapsed(panel, false, {
          persist: false,
          syncShare: false,
        });
      }, panel);
      const fit = await page.$eval(`#${panel}`, (root) => {
        const buttons = [...root.querySelectorAll('.gev-action-button')];
        const rect = root.getBoundingClientRect();
        return {
          count: buttons.length,
          fits:
            buttons.length > 0 &&
            buttons.every((button) => {
              const box = button.getBoundingClientRect();
              return (
                box.width > 0 &&
                box.left >= rect.left &&
                box.right <= rect.right + 1 &&
                box.left >= 0 &&
                box.right <= innerWidth + 1 &&
                button.scrollWidth <= button.clientWidth
              );
            }),
        };
      });
      check(`${panel} actions fit at ${width}px`, fit.fits, fit);
      if (width !== 620)
        await page.screenshot({ path: `${shots}/${panel}-${width}.png` });
    }
  }
  await page.evaluate(() => {
    const owner = window.__godsEyeView.styleManager._cctvControls;
    owner.destroy();
    window.__qaButtonCalls = [];
  });
  await page.$eval('#cctv-calib-save-btn', (node) => node.click());
  check(
    'destroyed controllers revoke action listeners',
    await page.evaluate(() => window.__qaButtonCalls.length === 0),
  );
  const localized = new URL(page.url());
  localized.searchParams.set('lang', 'ru');
  await page.goto(localized.href, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(
    () =>
      window.__godsEyeView?.styleManager?._cctvControls &&
      document.getElementById('loading-screen')?.classList.contains('hidden'),
    { timeout: 60000 },
  );
  for (const panel of ['scene-panel']) {
    await page.evaluate((panel) => {
      window.__godsEyeView.styleManager.setPanelCollapsed(panel, false, {
        persist: false,
        syncShare: false,
      });
    }, panel);
    const translated = await page.$eval(`#${panel}`, (root) => {
      const buttons = [...root.querySelectorAll('.gev-action-button')];
      return (
        document.documentElement.lang === 'ru' &&
        buttons.length > 0 &&
        buttons.every((node) => node.scrollWidth <= node.clientWidth)
      );
    });
    check(`Russian ${panel} action labels fit at 390px`, translated);
    await page.screenshot({ path: `${shots}/${panel}-ru-390.png` });
  }
  check('no uncaught browser errors', errors.length === 0, errors);
} finally {
  await browser.close();
}
console.log(`RESULT: ${failures} failures`);
process.exitCode = failures ? 1 : 0;
