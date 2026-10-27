#!/usr/bin/env node
/** Run against a dev server or built preview with QA_BASE_URL (default :4179). */
import fs from 'node:fs';
import puppeteer from 'puppeteer';

const browser = await puppeteer.launch({
  executablePath:
    process.env.PUPPETEER_EXECUTABLE_PATH || (await puppeteer.executablePath()),
  headless: true,
  args: ['--use-gl=angle', '--use-angle=swiftshader'],
});
const page = await browser.newPage();
const errors = [];
const failures = [];
page.on('pageerror', (error) => errors.push(error.message));
const check = (name, passed, detail = '') => {
  console.log(
    `[${passed ? 'PASS' : 'FAIL'}] ${name}${detail ? ` — ${detail}` : ''}`,
  );
  if (!passed) failures.push(name);
};
const base = process.env.QA_BASE_URL || 'http://localhost:4179';
const shots = process.env.QA_SHOTS_DIR || 'qa-shots/segmented-controls';
fs.mkdirSync(shots, { recursive: true });

try {
  await page.setViewport({ width: 1440, height: 900 });
  await page.goto(`${base}/?welcome=0`, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(
    () => window.__godsEyeView?.styleManager?._applicationShortcuts,
    { timeout: 60000 },
  );
  await page.waitForFunction(
    () =>
      document.getElementById('loading-screen')?.classList.contains('hidden'),
    { timeout: 60000 },
  );
  await page.evaluate(() =>
    window.__godsEyeView.styleManager.setPanelCollapsed('pp-toggles', false, {
      persist: false,
      syncShare: false,
    }),
  );

  const surface = await page.evaluate(() => {
    const groups = [...document.querySelectorAll('[role="radiogroup"]')];
    const buttons = groups.flatMap((group) => [
      ...group.querySelectorAll('[role="radio"]'),
    ]);
    return {
      groups: groups.length,
      buttons: buttons.length,
      shared:
        groups.every((g) => g.classList.contains('gev-segmented')) &&
        buttons.every((b) => {
          const style = getComputedStyle(b);
          return (
            b.classList.contains('gev-segment') &&
            style.fontSize === '9px' &&
            style.minHeight === '24px' &&
            style.borderRadius === '0px'
          );
        }),
    };
  });
  check(
    'all six one-of-many groups use the shared surface',
    surface.groups === 6 && surface.buttons === 15 && surface.shared,
    JSON.stringify(surface),
  );

  await page.evaluate(() =>
    document.getElementById('models3d-mode-all').click(),
  );
  check(
    'model selection reaches both aircraft layers',
    await page.evaluate(() => {
      const dm = window.__godsEyeView.dataManager;
      return (
        ['flights', 'military'].every(
          (id) => dm.layers.get(id).module.getParams().models3dMode === 'all',
        ) &&
        document
          .getElementById('models3d-mode-all')
          .getAttribute('aria-checked') === 'true'
      );
    }),
  );
  await page.focus('#models3d-mode-all');
  await page.keyboard.press('ArrowLeft');
  check(
    'Display retains its click-only arrow policy',
    await page.evaluate(
      () =>
        document
          .getElementById('models3d-mode-all')
          .getAttribute('aria-checked') === 'true',
    ),
  );
  await page.focus('#models3d-mode-proximity');
  await page.keyboard.press('Space');
  check(
    'native Space selects model coverage',
    await page.evaluate(
      () =>
        document
          .getElementById('models3d-mode-proximity')
          .getAttribute('aria-checked') === 'true',
    ),
  );
  await page.evaluate(() =>
    document.getElementById('detection-allocation-weighted').click(),
  );
  check(
    'allocation selection still updates application tuning',
    await page.evaluate(
      () =>
        window.__godsEyeView.styleManager._detectionAllocationPreference ===
          'WEIGHTED' &&
        document
          .getElementById('detection-allocation-weighted')
          .getAttribute('aria-checked') === 'true',
    ),
  );

  await page.evaluate(() =>
    document.querySelector('[data-shape="pin"]').click(),
  );
  check(
    'drawing shape still uses its existing feature action',
    await page.evaluate(
      () =>
        window.__gevDrawTool?.shape === 'pin' &&
        document
          .querySelector('[data-shape="pin"]')
          .getAttribute('aria-checked') === 'true',
    ),
  );

  // Off-layer controls still own params; no catalog/provider request is needed.
  await page.evaluate(() =>
    document.querySelector('[data-sl-pano="flat"]').click(),
  );
  check(
    'panorama choice reaches the Street Level layer',
    await page.evaluate(
      () =>
        window.__godsEyeView.dataManager.layers
          .get('street-level')
          .module.getParams().pano === 'flat',
    ),
  );
  await page.evaluate(() =>
    document.querySelector('[data-sl-pano="flat"]').dispatchEvent(
      new KeyboardEvent('keydown', {
        key: 'Home',
        bubbles: true,
        cancelable: true,
      }),
    ),
  );
  check(
    'Street Level Home retains selection and roving tab state',
    await page.evaluate(
      () =>
        window.__godsEyeView.dataManager.layers
          .get('street-level')
          .module.getParams().pano === 'all' &&
        document
          .querySelector('[data-sl-pano="all"]')
          .getAttribute('tabindex') === '0',
    ),
  );
  await page.evaluate(() =>
    document.querySelector('[data-sl-render="fill"]').click(),
  );
  check(
    'fit/fill keeps its stored render preference',
    await page.evaluate(
      () =>
        localStorage.getItem('gev:street-level:render-mode') === 'fill' &&
        document
          .querySelector('[data-sl-render="fill"]')
          .getAttribute('aria-checked') === 'true',
    ),
  );

  await page.evaluate(() =>
    document.querySelector('.ri-mode-btn[data-mode="ab"]').click(),
  );
  check(
    'imagery mode reaches its controlled layer state',
    await page.evaluate(
      () =>
        window.__godsEyeView.dataManager.layers
          .get('recent-imagery')
          .module.getSnapshot().mode === 'ab',
    ),
  );
  await page.evaluate(() =>
    document.getElementById('ri-mode').dispatchEvent(
      new KeyboardEvent('keydown', {
        key: 'ArrowRight',
        bubbles: true,
        cancelable: true,
      }),
    ),
  );
  check(
    'imagery arrows wrap from the current selected value',
    await page.evaluate(
      () =>
        window.__godsEyeView.dataManager.layers
          .get('recent-imagery')
          .module.getSnapshot().mode === 'image' &&
        document
          .querySelector('.ri-mode-btn[data-mode="image"]')
          .getAttribute('aria-checked') === 'true',
    ),
  );

  await page.evaluate(() => {
    const manager = window.__godsEyeView.styleManager;
    manager._setDetectionAllocation('ELASTIC', {
      syncShare: false,
      persist: false,
    });
    document
      .getElementById('models3d-mode-proximity')
      .scrollIntoView({ block: 'center' });
  });
  await page.screenshot({ path: `${shots}/desktop.png` });
  await page.setViewport({ width: 620, height: 900 });
  await page.evaluate(() =>
    document
      .getElementById('models3d-mode-proximity')
      .scrollIntoView({ block: 'center' }),
  );
  await page.screenshot({ path: `${shots}/narrow.png` });
  check(
    'narrow selectors stay within their panel',
    await page.evaluate(() =>
      [...document.querySelectorAll('.pp-mode-seg')]
        .filter((g) => g.getClientRects().length)
        .every((group) => group.scrollWidth <= group.clientWidth + 1),
    ),
  );
  const cyber = await page.evaluate(() => {
    const root = document.documentElement;
    const previous = root.getAttribute('data-ui-theme');
    root.setAttribute('data-ui-theme', 'cyber');
    const selected = [
      ...document.querySelectorAll('.gev-segment[aria-checked="true"]'),
    ];
    // Check the final theme colors, independent of software-GL frame cadence.
    for (const button of selected)
      for (const animation of button.getAnimations()) animation.finish();
    const backgrounds = selected.map(
      (button) => getComputedStyle(button).backgroundColor,
    );
    const radii = [...document.querySelectorAll('.gev-segmented')].map(
      (group) => getComputedStyle(group).borderRadius,
    );
    const consistent =
      selected.length === 6 &&
      backgrounds.every((color) => color === backgrounds[0]) &&
      radii.every((radius) => radius === '1px');
    if (previous === null) root.removeAttribute('data-ui-theme');
    else root.setAttribute('data-ui-theme', previous);
    return { consistent, count: selected.length, backgrounds, radii };
  });
  check(
    'Cyber theme styles every selected segment consistently',
    cyber.consistent,
    JSON.stringify(cyber),
  );
  await page.evaluate(async () => {
    const { dataManager, styleManager } = window.__godsEyeView;
    await dataManager.setEnabled('recent-imagery', true);
    styleManager.setPanelCollapsed('recent-imagery-panel', false, {
      persist: false,
      syncShare: false,
    });
  });
  for (const width of [1440, 620, 390]) {
    await page.setViewport({ width, height: 900 });
    await page.focus('.ri-mode-btn[aria-checked="true"]');
    const modeLayout = await page.evaluate(() => {
      const group = document.getElementById('ri-mode');
      const bounds = group.getBoundingClientRect();
      const style = getComputedStyle(group);
      const top = bounds.top + parseFloat(style.borderTopWidth);
      const bottom = bounds.bottom - parseFloat(style.borderBottomWidth);
      const buttons = [...group.querySelectorAll('[role="radio"]')];
      return {
        visible: bounds.width > 0 && bounds.height > 0,
        contained: buttons.every((button) => {
          const rect = button.getBoundingClientRect();
          return rect.top >= top - 0.5 && rect.bottom <= bottom + 0.5;
        }),
        groupHeight: bounds.height,
        buttonHeights: buttons.map(
          (button) => button.getBoundingClientRect().height,
        ),
      };
    });
    check(
      `imagery mode buttons and focus outline fit their row at ${width}px`,
      modeLayout.visible && modeLayout.contained,
      JSON.stringify(modeLayout),
    );
  }
  check('no uncaught browser errors', errors.length === 0, errors.join(' | '));
} catch (error) {
  console.error('Browser errors:', errors);
  await page.screenshot({ path: `${shots}/failure.png` }).catch(() => {});
  throw error;
} finally {
  await browser.close();
}
console.log(`RESULT: ${failures.length} failures`);
process.exitCode = failures.length ? 1 : 0;
