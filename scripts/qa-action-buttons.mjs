#!/usr/bin/env node
/**
 * Scenes/CCTV action-button acceptance against dev or production preview:
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
  await page.goto(
    `${process.env.QA_BASE_URL || 'http://127.0.0.1:4179'}/?welcome=0`,
    { waitUntil: 'domcontentloaded' },
  );
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
      'cctv-nearest-btn',
      'cctv-prev-btn',
      'cctv-next-btn',
      'cctv-focus-btn',
      'cctv-calib-save-btn',
      'cctv-calib-reset-btn',
    ];
    const ordinary = ids.map((id) => document.getElementById(id));
    const generated = [
      ...document.querySelectorAll(
        '.scene-shot-btn, [data-director-authoring] button',
      ),
    ];
    const toggles = [
      'cctv-enable-btn',
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

  await page.evaluate(() => {
    const manager = window.__godsEyeView.styleManager;
    const owner = manager._cctvControls;
    owner._cctvUnsubscribe?.();
    owner._cctvUnsubscribe = null;
    window.__qaButtonCalls = [];
    const record = (...args) => window.__qaButtonCalls.push(args);
    owner.actions = {
      ...owner.actions,
      isEnabled: () => true,
      toggleEnabled: async () => {
        record('enable');
        return true;
      },
      runExplicitFocus: (select, focus) => focus(select()),
      setParams: (params, options) => record('params', params, options),
      showToast: () => {},
    };
    owner.cctv = {
      focusNearest: () => {
        record('nearest');
        return 'a';
      },
      cycleCamera: (direction) => {
        record('cycle', direction);
        return 'b';
      },
      focusCamera: (id, seconds) => record('focus', id, seconds),
    };
    window.__qaCameraState = {
      enabled: true,
      activeCameraId: 'a',
      cameras: [
        { id: 'a', city: 'Fixture', name: 'A' },
        { id: 'b', city: 'Fixture', name: 'B' },
      ],
      activeCamera: { id: 'a', name: 'A', basePose: {} },
    };
    owner._renderCctvState(window.__qaCameraState);
    manager.setPanelCollapsed('cctv-panel', false, {
      persist: false,
      syncShare: false,
    });
  });
  await page.focus('#cctv-next-btn');
  await page.keyboard.press('Space');
  await page.waitForFunction(() => window.__qaButtonCalls.length === 3);
  check(
    'native Space dispatches Next and its focus once',
    await page.evaluate(
      () =>
        JSON.stringify(window.__qaButtonCalls) ===
        JSON.stringify([['enable'], ['cycle', 1], ['focus', 'b', 1.4]]),
    ),
  );
  check(
    'native keyboard activation keeps a visible focus ring',
    await page.$eval(
      '#cctv-next-btn',
      (node) =>
        document.activeElement === node &&
        getComputedStyle(node).outlineStyle === 'solid',
    ),
  );
  await page.evaluate(() => {
    window.__qaButtonCalls = [];
  });
  await page.focus('#cctv-prev-btn');
  await page.keyboard.press('Enter');
  await page.waitForFunction(() => window.__qaButtonCalls.length === 3);
  check(
    'native Enter dispatches Previous once',
    await page.evaluate(
      () =>
        JSON.stringify(window.__qaButtonCalls) ===
        JSON.stringify([['enable'], ['cycle', -1], ['focus', 'b', 1.4]]),
    ),
  );

  for (const [id, expected] of [
    ['cctv-nearest-btn', [['enable'], ['nearest'], ['focus', 'a', 1.8]]],
    [
      'cctv-focus-btn',
      [
        ['enable'],
        ['focus', 'a', 1.9],
        ['params', { selectedCameraId: 'a' }, { origin: 'user' }],
      ],
    ],
  ]) {
    await page.evaluate(() => {
      window.__qaButtonCalls = [];
    });
    await page.click(`#${id}`);
    await page.waitForFunction(() => window.__qaButtonCalls.length === 3);
    const calls = await page.evaluate(() => window.__qaButtonCalls);
    check(
      `${id} retains its existing action and focus timing`,
      JSON.stringify(calls) === JSON.stringify(expected),
      calls,
    );
  }

  await page.evaluate(() => {
    window.__qaButtonCalls = [];
  });
  await page.click('#cctv-calib-save-btn');
  await page.click('#cctv-calib-reset-btn');
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
  await page.evaluate(() => {
    window.__qaButtonCalls = [];
    window.__godsEyeView.styleManager._cctvControls._renderCctvState({
      enabled: false,
    });
  });
  await page.click('#cctv-next-btn');
  await page.waitForFunction(
    () => {
      const node = document.getElementById('cctv-next-btn');
      return node.disabled && Number(getComputedStyle(node).opacity) === 0.45;
    },
    { timeout: 3000 },
  );
  check(
    'disabled actions stay inert and keep disabled presentation',
    await page.$eval(
      '#cctv-next-btn',
      (node) =>
        node.disabled &&
        getComputedStyle(node).opacity === '0.45' &&
        window.__qaButtonCalls.length === 0,
    ),
  );

  for (const width of [1440, 620, 390]) {
    await page.setViewport({ width, height: 900 });
    for (const panel of ['scene-panel', 'cctv-panel']) {
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
    document.getElementById('cctv-next-btn').disabled = false;
    window.__qaButtonCalls = [];
  });
  await page.click('#cctv-next-btn');
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
  for (const panel of ['scene-panel', 'cctv-panel']) {
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
