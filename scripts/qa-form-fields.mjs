#!/usr/bin/env node
/** Native form-field regression gate. CCTV ports are fixtures, never live writes. */
import fs from 'node:fs';
import puppeteer from 'puppeteer';

const browser = await puppeteer.launch({
  headless: true,
  args: ['--use-gl=angle', '--use-angle=swiftshader'],
});
const page = await browser.newPage();
page.setDefaultNavigationTimeout(60000);
let failures = 0;
const errors = [];
page.on('pageerror', (error) => errors.push(error.message));
const check = (name, passed, detail) => {
  console.log(`[${passed ? 'PASS' : 'FAIL'}] ${name}`);
  if (!passed) {
    failures++;
    console.log(JSON.stringify(detail));
  }
};
fs.mkdirSync('qa-shots/form-fields', { recursive: true });
try {
  await page.setViewport({ width: 1440, height: 900 });
  await page.goto(
    `${process.env.QA_BASE_URL || 'http://127.0.0.1:4183'}/?welcome=0`,
    {
      waitUntil: 'domcontentloaded',
    },
  );
  await page.waitForFunction(
    () =>
      window.__godsEyeView?.styleManager?._cctvControls &&
      document.getElementById('loading-screen')?.classList.contains('hidden'),
    { timeout: 60000 },
  );
  const inventory = await page.evaluate(() => {
    const selects = [
      'scene-select',
      'cctv-camera-select',
      'hud-layout-select',
      'draw-color-select',
      'radio-filter',
      'sdr-gain-select',
    ].map((id) => document.getElementById(id));
    return {
      ids: selects.map((node) => node.id),
      shared:
        selects.length === 6 &&
        selects.every((node) => node.classList.contains('gev-field')),
      native: selects.every(
        (node) =>
          node instanceof HTMLSelectElement && !node.hasAttribute('role'),
      ),
      dark: selects.every(
        (node) => getComputedStyle(node).colorScheme === 'dark',
      ),
    };
  });
  check(
    'all six panel dropdowns retain native select semantics and shared surface',
    inventory.shared && inventory.native,
    inventory,
  );
  check('native option menus keep the dark scheme', inventory.dark);
  await page.evaluate(() => {
    const manager = window.__godsEyeView.styleManager;
    manager.setPanelCollapsed('pp-toggles', false, {
      persist: false,
      syncShare: false,
    });
    manager.setPanelCollapsed('scene-panel', false, {
      persist: false,
      syncShare: false,
    });
    manager.setPanelCollapsed('cctv-panel', false, {
      persist: false,
      syncShare: false,
    });
    window.__qaFormChanges = [];
    document
      .getElementById('scene-select')
      .addEventListener('change', (event) =>
        window.__qaFormChanges.push(event.target.value),
      );
  });
  const ownerSetup = await page.evaluate(() => {
    const owner = window.__godsEyeView.styleManager._cctvControls;
    owner._cctvUnsubscribe?.();
    owner._cctvUnsubscribe = null;
    window.__qaFormCalls = [];
    owner.actions = {
      ...owner.actions,
      isEnabled: () => true,
      toggleEnabled: async () => true,
      setParams: (...args) => window.__qaFormCalls.push(args),
      runExplicitFocus: (select, focus) => focus(select()),
      showToast: () => {},
    };
    owner.cctv = {
      setParams() {},
      focusCamera: (id) => window.__qaFormCalls.push(['focus', id]),
      selectCamera: (id) => id,
    };
    owner._cctvState = {
      enabled: true,
      activeCameraId: 'a',
      cameras: [
        { id: 'a', name: 'A' },
        { id: 'b', name: 'B' },
      ],
      activeCamera: {
        id: 'a',
        headingDeg: 30,
        pitchDeg: -10,
        fovDeg: 45,
        rangeM: 120,
        mountHeightM: 8,
        calibration: {},
        basePose: {
          headingDeg: 20,
          pitchDeg: -10,
          fovDeg: 45,
          rangeM: 120,
          mountHeightM: 8,
        },
      },
    };
    owner._renderCctvState(owner._cctvState);
    const input = document.getElementById('sdr-frequency-input');
    return {
      min: input.min,
      max: input.max,
      step: input.step,
      type: input.type,
      shared: input.classList.contains('gev-field'),
    };
  });
  check(
    'FM frequency retains native bounds, precision and shared surface',
    ownerSetup.min === '87.5' &&
      ownerSetup.max === '108' &&
      ownerSetup.step === '0.1' &&
      ownerSetup.type === 'number' &&
      ownerSetup.shared,
    ownerSetup,
  );
  const validity = await page.$eval('#sdr-frequency-input', (input) => {
    const original = input.value;
    input.value = '87.4';
    const below = input.validity.rangeUnderflow;
    input.value = '108.1';
    const above = input.validity.rangeOverflow;
    input.value = '98.55';
    const step = input.validity.stepMismatch;
    input.value = '';
    const empty = input.validity.valid;
    input.value = original;
    return below && above && step && empty;
  });
  check(
    'native numeric validity preserves underflow, overflow, steps and empty drafts',
    validity,
  );
  await page.select('#cctv-camera-select', 'b');
  await page.waitForFunction(() => window.__qaFormCalls.length === 2);
  const cameraSelection = await page.evaluate(() => window.__qaFormCalls);
  check(
    'camera dropdown retains selection, focus and user-origin dispatch',
    cameraSelection[0][0] === 'focus' &&
      cameraSelection[0][1] === 'b' &&
      cameraSelection[1][0].selectedCameraId === 'b' &&
      cameraSelection[1][1].origin === 'user',
    cameraSelection,
  );
  await page.evaluate(() => {
    window.__qaFormCalls = [];
    document.getElementById('cctv-camera-select').disabled = true;
  });
  await page.focus('#scene-select');
  await page.focus('#cctv-camera-select');
  check(
    'disabled native selects cannot receive keyboard focus',
    await page.evaluate(
      () => document.activeElement.id !== 'cctv-camera-select',
    ),
  );
  await page.evaluate(() => {
    document.getElementById('cctv-camera-select').disabled = false;
  });
  const begin = async (field) => {
    await page.evaluate((field) => {
      const owner = window.__godsEyeView.styleManager._cctvControls;
      owner._beginCctvCalValueEdit(
        document.querySelector(`[data-cal-field="${field}"]`),
      );
    }, field);
  };
  for (const [field, step, value] of [
    ['heading', '0.1', '30.0'],
    ['pitch', '0.1', '-10.0'],
    ['fov', '1', '45'],
    ['range', '1', '120'],
    ['height', '1', '8'],
    ['north', '0.1', '0.0'],
    ['east', '0.1', '0.0'],
  ]) {
    await begin(field);
    const result = await page.$eval('.cctv-cal-input', (input) => ({
      step: input.step,
      value: input.value,
      native: input.type === 'number',
      shared: input.classList.contains('gev-field'),
      label: input.getAttribute('aria-label'),
      focus: document.activeElement === input,
    }));
    check(
      `${field} editor retains precision, initial value and focus`,
      result.step === step &&
        result.value === value &&
        result.native &&
        result.shared &&
        !!result.label &&
        result.focus,
      result,
    );
    await page.keyboard.press('Escape');
  }
  check(
    'Escape cancels each field without a calibration write',
    await page.evaluate(() => window.__qaFormCalls.length === 0),
  );
  await begin('heading');
  await page.keyboard.press('Backspace');
  await page.type('.cctv-cal-input', '100');
  await page.evaluate(() => {
    window.__godsEyeView.styleManager._cctvControls._cctvState.activeCamera.basePose.headingDeg = 60;
  });
  await page.keyboard.press('Enter');
  const commit = await page.evaluate(() => window.__qaFormCalls);
  check(
    'Enter commits once against the frozen camera base',
    commit.length === 1 &&
      commit[0][0].calibration.patch.headingDeg === 80 &&
      commit[0][0].calibration.cameraId === 'a' &&
      commit[0][1].origin === 'user',
    commit,
  );
  await begin('north');
  await page.keyboard.press('Backspace');
  await page.type('.cctv-cal-input', '12.5');
  await page.$eval('.cctv-cal-input', (input) => input.blur());
  const blur = await page.evaluate(() => window.__qaFormCalls);
  check(
    'blur commits a decimal offset exactly once',
    blur.length === 2 && blur[1][0].calibration.patch.offsetNorthM === 12.5,
    blur,
  );
  await begin('east');
  await page.keyboard.press('Backspace');
  await page.keyboard.press('Enter');
  check(
    'an empty numeric draft does not write calibration',
    await page.evaluate(() => window.__qaFormCalls.length === 2),
  );
  await begin('heading');
  await page.type('.cctv-cal-input', '90');
  await page.evaluate(() => {
    window.__godsEyeView.styleManager._cctvControls._cctvState.activeCameraId =
      'b';
  });
  await page.keyboard.press('Enter');
  check(
    'a stale camera editor cannot commit to the next camera',
    await page.evaluate(() => window.__qaFormCalls.length === 2),
  );

  await page.evaluate(() => {
    for (const panel of ['pp-toggles', 'scene-panel', 'cctv-panel'])
      window.__godsEyeView.styleManager.setPanelCollapsed(panel, false, {
        persist: false,
        syncShare: false,
      });
  });
  if (
    await page.$eval(
      '#draw-toggle',
      (node) => node.getAttribute('aria-pressed') !== 'true',
    )
  )
    await page.click('#draw-toggle');
  for (const lang of ['en']) {
    await page.evaluate((lang) => {
      document.documentElement.lang = lang;
    }, lang);
    for (const width of [1440, 620, 390]) {
      await page.setViewport({ width, height: 900 });
      const layout = await page.evaluate(() => {
        const ids = [
          'scene-select',
          'cctv-camera-select',
          'hud-layout-select',
          'draw-color-select',
        ];
        return ids.map((id) => {
          const node = document.getElementById(id),
            rect = node.getBoundingClientRect(),
            panel = node.closest('.panel-collapsible')?.getBoundingClientRect();
          return {
            id,
            width: rect.width,
            fits: rect.width > 0 && rect.width <= (panel?.width || innerWidth),
            radius: getComputedStyle(node).borderRadius,
          };
        });
      });
      check(
        `${lang} fields fit their panels at ${width}px`,
        layout.every((item) => item.fits),
        layout,
      );
      if (width === 390)
        await page.screenshot({
          path: `qa-shots/form-fields/${lang}-${width}.png`,
        });
    }
  }
  await page.evaluate(() => {
    document.documentElement.lang = 'en';
    document.documentElement.dataset.uiTheme = 'cyber';
  });
  const cyber = await page.$eval(
    '#scene-select',
    (node) => getComputedStyle(node).backgroundColor,
  );
  check(
    'Cyber keeps its native field theme',
    cyber === 'rgba(26, 35, 39, 0.96)',
    cyber,
  );
  await begin('heading');
  await page.evaluate(() => {
    const owner = window.__godsEyeView.styleManager._cctvControls;
    window.__qaDetachedInput = document.querySelector('.cctv-cal-input');
    owner.destroy();
    window.__qaDetachedInput.dispatchEvent(new Event('blur'));
  });
  check(
    'disposal removes the editor and prevents late commits',
    await page.evaluate(
      () =>
        !document.querySelector('.cctv-cal-input') &&
        window.__qaFormCalls.length === 2,
    ),
  );
  // Scene selection can restore application settings. Exercise it after the
  // fixture-owned CCTV phase so those asynchronous effects cannot replace ports.
  page.once('dialog', (dialog) => dialog.accept('Baseline selection fixture'));
  await page.click('#scene-new-btn');
  await page.waitForFunction(() =>
    [...document.querySelectorAll('#scene-select option')].some(
      (option) => option.textContent === 'Baseline selection fixture',
    ),
  );
  page.once('dialog', (dialog) => dialog.accept('QA selection fixture'));
  await page.click('#scene-new-btn');
  await page.waitForFunction(
    () => document.querySelectorAll('#scene-select option').length > 1,
  );
  const targetSceneId = await page.$eval(
    '#scene-select',
    (node) =>
      [...node.options].find(
        (option) => option.textContent === 'QA selection fixture',
      ).value,
  );
  const baselineSceneId = await page.$eval(
    '#scene-select',
    (node) =>
      [...node.options].find(
        (option) => option.textContent === 'Baseline selection fixture',
      ).value,
  );
  await page.select('#scene-select', baselineSceneId);
  await page.waitForFunction(
    (id) => window.__godsEyeView.sceneDirector._getSelectedScene().id !== id,
    {},
    targetSceneId,
  );
  await page.evaluate(() => {
    window.__qaFormChanges = [];
  });
  await page.focus('#scene-select');
  // Typeahead is native even when headless Chrome does not drive OS popups.
  await page.keyboard.press('q');
  const sceneSelection = await page.evaluate(() => ({
    id: document.getElementById('scene-select').value,
    selected: window.__godsEyeView.sceneDirector._getSelectedScene().id,
    changes: window.__qaFormChanges,
    focus: document.activeElement.id,
    outline: getComputedStyle(document.activeElement).outlineStyle,
  }));
  check(
    'native typeahead reaches the Scene owner and keeps focus',
    sceneSelection.id === targetSceneId &&
      sceneSelection.selected === targetSceneId &&
      sceneSelection.changes.at(-1) === targetSceneId &&
      sceneSelection.focus === 'scene-select',
    sceneSelection,
  );
  check('keyboard focus remains visible', sceneSelection.outline === 'solid');
  const localized = new URL(page.url());
  localized.searchParams.set('lang', 'ru');
  await page.goto(localized.href, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(
    () =>
      window.__godsEyeView?.styleManager?._cctvControls &&
      document.getElementById('loading-screen')?.classList.contains('hidden'),
    { timeout: 60000 },
  );
  await page.evaluate(() => {
    for (const panel of ['pp-toggles', 'scene-panel', 'cctv-panel'])
      window.__godsEyeView.styleManager.setPanelCollapsed(panel, false, {
        persist: false,
        syncShare: false,
      });
  });
  await page.evaluate(() => {
    for (const panel of ['pp-toggles', 'scene-panel', 'cctv-panel'])
      window.__godsEyeView.styleManager.setPanelCollapsed(panel, false, {
        persist: false,
        syncShare: false,
      });
  });
  if (
    await page.$eval(
      '#draw-toggle',
      (node) => node.getAttribute('aria-pressed') !== 'true',
    )
  )
    await page.click('#draw-toggle');
  const translated = await page.evaluate(() => {
    const nodes = [
      'scene-select',
      'cctv-camera-select',
      'hud-layout-select',
      'draw-color-select',
    ].map((id) => document.getElementById(id));
    return (
      document.documentElement.lang === 'ru' &&
      nodes.every(
        (node) =>
          node.clientWidth > 0 &&
          node.getBoundingClientRect().width <=
            node.closest('.panel-collapsible').getBoundingClientRect().width,
      )
    );
  });
  check('real Russian labels and fields fit at 390px', translated);
  await page.screenshot({ path: 'qa-shots/form-fields/ru-390.png' });
  check('no uncaught browser errors', errors.length === 0, errors);
} finally {
  await browser.close();
}
process.exitCode = failures ? 1 : 0;
