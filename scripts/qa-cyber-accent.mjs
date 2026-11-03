/** Browser acceptance for Display's composed action route and panel placement.
 * Run against a dev server: QA_BASE_URL=http://127.0.0.1:5173 node scripts/qa-cyber-accent.mjs
 */
import assert from 'node:assert/strict';
import puppeteer from 'puppeteer';

const browser = await puppeteer.launch({ headless: true });
try {
  const page = await browser.newPage();
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.setViewport({ width: 1440, height: 900 });
  await page.goto(
    `${process.env.QA_BASE_URL || 'http://localhost:4173'}/?welcome=0`,
    {
      waitUntil: 'networkidle2',
    },
  );
  const ready = () =>
    page.waitForFunction(
      () =>
        window.__godsEyeView?.styleManager &&
        document.querySelector('.gev-panel-rail--right button') &&
        getComputedStyle(document.getElementById('loading-screen'))
          .pointerEvents === 'none',
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
        gap: button.left - rect.right,
        title: getComputedStyle(panel.querySelector('.pp-header-label')).color,
        accent: getComputedStyle(document.documentElement)
          .getPropertyValue('--cyber-accent')
          .trim(),
        stored: JSON.parse(localStorage.getItem('gev:cyber-accent:v1')),
      };
    });
  await open();
  await page.select('#hud-layout-select', 'cyber');
  await page.waitForSelector('#cyber-accent-row', { visible: true });
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
  const colors = {
    red: '#c45454',
    green: '#4ec98a',
    cyan: '#69cbd1',
    amber: '#e89d4e',
    purple: '#7d4fae',
  };
  const titleColors = new Set();
  for (const [name, color] of Object.entries(colors)) {
    await page.click(`[data-accent='${name}']`);
    await page.waitForFunction(
      (hex) =>
        document.documentElement.style.getPropertyValue('--cyber-accent') ===
        hex,
      {},
      color,
    );
    const result = await inspect();
    assert.equal(result.stored.id, name);
    titleColors.add(result.title);
  }
  assert.equal(titleColors.size, 5, 'every preset changes the painted title');
  await page.$eval('#cyber-accent-custom', (picker) => {
    picker.value = '#2367ab';
    picker.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await page.waitForFunction(
    () =>
      document.documentElement.style.getPropertyValue('--cyber-accent') ===
      '#2367ab',
  );
  assert.equal((await inspect()).stored.id, 'custom');
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
  await page.reload({ waitUntil: 'networkidle2' });
  await ready();
  assert.equal(
    (await inspect()).accent,
    '#2367ab',
    'custom accent survives reload',
  );
  assert.deepEqual(errors, []);
  console.log(
    'PASS: sonar toggle with hidden/visible HUD, rotating sweep, accent presets, custom color, persistence, layout switching, adjacent placement and clean close/reopen at two desktop widths.',
  );
} finally {
  await browser.close();
}
