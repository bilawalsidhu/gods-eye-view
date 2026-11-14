/** Browser acceptance for Display's composed action route and panel placement.
 * Run against a dev server: QA_BASE_URL=http://127.0.0.1:5173 node scripts/qa-display-accents.mjs
 */
import assert from 'node:assert/strict';
import puppeteer from 'puppeteer';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';

const browser = await puppeteer.launch({ headless: true });
try {
  const page = await browser.newPage();
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.setViewport({ width: 1440, height: 900 });
  await page.goto(
    `${process.env.QA_BASE_URL || 'http://localhost:4173'}/?welcome=0`,
    {
      waitUntil: 'domcontentloaded',
      timeout: 60000,
    },
  );
  const ready = () =>
    page.waitForFunction(
      () =>
        window.__godsEyeView?.styleManager &&
        document.querySelector('.gev-panel-rail--right button') &&
        getComputedStyle(document.getElementById('loading-screen'))
          .pointerEvents === 'none',
      { timeout: 60000 },
    );
  await ready();
  const open = async () => {
    await page.click('.gev-panel-rail--right button');
    await page.waitForSelector('#pp-toggles:not(.collapsed)', {
      visible: true,
    });
  };
  const inspect = () =>
    page.evaluate(() => {
      const panel = document.getElementById('pp-toggles');
      const rect = panel.getBoundingClientRect();
      const button = document
        .querySelector('.gev-panel-rail--right button')
        .getBoundingClientRect();
      return {
        count: document.querySelectorAll('#pp-toggles').length,
        parent: panel.parentElement.id,
        classes: panel.className,
        bounds: rect.toJSON(),
        launcher: button.toJSON(),
        gap: button.left - rect.right,
        title: getComputedStyle(panel.querySelector('.pp-header-label')).color,
        accent: getComputedStyle(document.documentElement)
          .getPropertyValue('--display-accent')
          .trim(),
        stored: JSON.parse(localStorage.getItem('gev:display-accents:v1')),
      };
    });
  const colors = {
    red: '#c45454',
    green: '#4ec98a',
    cyan: '#69cbd1',
    amber: '#e89d4e',
    purple: '#7d4fae',
  };
  await open();
  const nativeColors = {};
  const customColors = {
    tactical: '#2f785a',
    minimal: '#284c9c',
    cyber: '#2367ab',
  };
  for (const layout of ['tactical', 'minimal']) {
    await page.select('#hud-layout-select', layout);
    await page.waitForSelector('#display-accent-row', { visible: true });
    nativeColors[layout] = await page.$eval(
      '#hud-mode',
      (el) => getComputedStyle(el).color,
    );
    const paintedColors = new Set();
    for (const [name, color] of Object.entries(colors)) {
      await page.click(`[data-accent='${name}']`);
      await page.waitForFunction(
        (hex) =>
          document.documentElement.style.getPropertyValue(
            '--display-accent',
          ) === hex,
        {},
        color,
      );
      paintedColors.add(
        await page.$eval('#hud-mode', (el) => getComputedStyle(el).color),
      );
      assert.equal((await inspect()).stored[layout].id, name);
    }
    assert.equal(
      paintedColors.size,
      5,
      `${layout}: every preset changes the painted HUD`,
    );
    await page.click('[data-accent="default"]');
    await page.waitForFunction(
      () => !document.documentElement.dataset.displayAccent,
    );
    assert.equal(
      await page.$eval('#hud-mode', (el) => getComputedStyle(el).color),
      nativeColors[layout],
    );
    await page.$eval(
      '#display-accent-custom',
      (picker, color) => {
        picker.value = color;
        picker.dispatchEvent(new Event('input', { bubbles: true }));
      },
      customColors[layout],
    );
    await page.waitForFunction(
      (hex) =>
        document.documentElement.style.getPropertyValue('--display-accent') ===
        hex,
      {},
      customColors[layout],
    );
  }
  await page.select('#hud-layout-select', 'cyber');
  await page.waitForSelector('#display-accent-row', { visible: true });
  // Match Cyber + Normal with the HUD hidden: SONAR ON used to silently
  // leave the scanner invisible even though its button changed state.
  await page.evaluate(() =>
    window.__godsEyeView.styleManager.setStyle('normal'),
  );
  await page.click('#hud-toggle');
  await page.waitForSelector('#intel-hud:not(.active)');
  await page.click('#cyber-sonar-toggle');
  await page.waitForFunction(
    () => document.documentElement.dataset.cyberSonar === 'off',
  );
  await page.click('#cyber-sonar-toggle');
  await page.waitForSelector('#intel-hud.active');
  await page.waitForFunction(
    () => document.documentElement.dataset.cyberSonar === 'on',
  );
  const sweepTransform = () =>
    page.$eval('.hud-sonar', (el) => getComputedStyle(el, '::after').transform);
  const firstTransform = await sweepTransform();
  await page.waitForFunction(
    (first) =>
      getComputedStyle(document.querySelector('.hud-sonar'), '::after')
        .transform !== first,
    {},
    firstTransform,
  );
  await page.click('#cyber-sonar-toggle');
  await page.waitForFunction(
    () =>
      getComputedStyle(document.querySelector('.hud-sonar')).display === 'none',
  );
  assert.ok(
    await page.$('#intel-hud.active'),
    'Sonar OFF leaves the HUD visible',
  );
  await page.click('#cyber-sonar-toggle');
  const titleColors = new Set();
  for (const [name, color] of Object.entries(colors)) {
    await page.click(`[data-accent='${name}']`);
    await page.waitForFunction(
      (hex) =>
        document.documentElement.style.getPropertyValue('--display-accent') ===
        hex,
      {},
      color,
    );
    const result = await inspect();
    assert.equal(result.stored.cyber.id, name);
    titleColors.add(result.title);
  }
  assert.equal(titleColors.size, 5, 'every preset changes the painted title');
  await page.$eval('#display-accent-custom', (picker) => {
    picker.value = '#2367ab';
    picker.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await page.waitForFunction(
    () =>
      document.documentElement.style.getPropertyValue('--display-accent') ===
      '#2367ab',
  );
  assert.equal((await inspect()).stored.cyber.id, 'custom');
  await page.select('#hud-layout-select', 'minimal');
  await page.select('#hud-layout-select', 'cyber');
  assert.equal((await inspect()).accent, '#2367ab');
  for (const width of [1440, 1024]) {
    await page.setViewport({ width, height: 900 });
    await page.waitForFunction(() => {
      const panel = document
        .getElementById('pp-toggles')
        .getBoundingClientRect();
      const button = document
        .querySelector('.gev-panel-rail--right button')
        .getBoundingClientRect();
      return (
        panel.width > 0 &&
        button.left - panel.right >= 0 &&
        button.left - panel.right < 70
      );
    });
    const result = await inspect();
    assert.equal(result.count, 1);
    assert.equal(result.parent, 'right-context-rail');
    await page.click('.gev-panel-rail--right button');
    await page.waitForFunction(
      () => document.getElementById('hud-toggle').getClientRects().length === 0,
    );
    await open();
    assert.equal((await inspect()).accent, '#2367ab');
  }
  await page.reload({ waitUntil: 'domcontentloaded', timeout: 60000 });
  await ready();
  assert.equal(
    (await inspect()).accent,
    '#2367ab',
    'custom accent survives reload',
  );
  for (const layout of ['tactical', 'minimal', 'cyber']) {
    await page.select('#hud-layout-select', layout);
    await page.waitForFunction(
      (hex) =>
        document.documentElement.style.getPropertyValue('--display-accent') ===
        hex,
      {},
      customColors[layout],
    );
    assert.equal(
      (await inspect()).stored[layout].customColor,
      customColors[layout],
    );
    assert.equal(
      await page.$eval('#display-accent-custom', (el) => el.value),
      customColors[layout],
    );
    for (const width of [1440, 1024]) {
      await page.setViewport({ width, height: 900 });
      await page
        .waitForFunction(() => {
          const panel = document
            .getElementById('pp-toggles')
            .getBoundingClientRect();
          const button = document
            .querySelector('.gev-panel-rail--right button')
            .getBoundingClientRect();
          return (
            panel.width > 0 &&
            button.left - panel.right >= 0 &&
            button.left - panel.right < 70
          );
        })
        .catch(async (error) => {
          console.error(
            'Template placement failure',
            layout,
            width,
            JSON.stringify(await inspect()),
          );
          throw error;
        });
      assert.equal((await inspect()).count, 1);
      await page.click('.gev-panel-rail--right button');
      await page.waitForFunction(
        () =>
          document.getElementById('hud-toggle').getClientRects().length === 0,
      );
      await open();
    }
    if (process.env.QA_ARTIFACT_DIR) {
      await mkdir(process.env.QA_ARTIFACT_DIR, { recursive: true });
      await page.setViewport({ width: 1440, height: 1000 });
      await page.evaluate(() =>
        window.__godsEyeView.styleManager.setStyle('normal', {
          applyPreset: false,
        }),
      );
      await page.click(
        `[data-accent='${{ tactical: 'green', minimal: 'cyan', cyber: 'purple' }[layout]}']`,
      );
      await page.screenshot({
        type: 'jpeg',
        quality: 88,
        path: path.join(process.env.QA_ARTIFACT_DIR, `display-${layout}.jpg`),
      });
    }
  }
  assert.deepEqual(errors, []);
  console.log(
    'PASS: all three templates, independent colors and persistence, Default restores native HUD colors, sonar toggle with hidden/visible HUD, rotating sweep, accent presets, custom color, persistence, layout switching, adjacent placement and clean close/reopen at two desktop widths.',
  );
} finally {
  await browser.close();
}
