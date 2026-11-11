#!/usr/bin/env node
/**
 * Browser proof of the layer-panel opacity slider.
 *
 * Enables the Sea Marks overlay (a layer that implements `setOpacity`), drags
 * its slider with the real mouse and checks, in the page: the imagery layer's
 * alpha follows the handle, the page address carries `?lop=` only while the
 * layer is below 100 %, a double-click resets, a fresh load of the address
 * restores the value, and hostile `lop` values neither throw nor change a
 * layer. A layer that cannot be dimmed (Earthquakes) shows no slider.
 *
 * Usage: QA_BASE_URL=http://localhost:4173 node scripts/qa-layer-opacity.mjs
 * It needs no network beyond the page itself: tiles the overlay requests may
 * fail, which does not affect the alpha or the address being checked.
 */
import puppeteer from 'puppeteer';

const BASE = process.env.QA_BASE_URL || 'http://localhost:4173';
const LAYER = 'sea-marks';
const SLIDER = `[data-layer-id="${LAYER}"] input[type="range"]`;

const browser = await puppeteer.launch({
  headless: true,
  executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || undefined,
  args: [
    '--no-sandbox',
    ...(process.platform === 'darwin'
      ? ['--use-angle=metal', '--enable-gpu']
      : ['--use-gl=angle', '--use-angle=swiftshader']),
  ],
});
let failures = 0;
const check = (name, passed, detail = '') => {
  console.log(
    `[${passed ? 'PASS' : 'FAIL'}] ${name}${passed ? '' : ` ${detail}`}`,
  );
  if (!passed) failures++;
};
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function open(query = '') {
  const page = await browser.newPage();
  await page.setViewport({ width: 1280, height: 800 });
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto(`${BASE}/?welcome=0${query}`, {
    waitUntil: 'domcontentloaded',
  });
  await page.waitForFunction(() => window.__godsEyeView?.dataManager, {
    timeout: 90000,
  });
  return { page, errors };
}

/** The overlay's imagery layer: the one the viewer gains when it is enabled. */
const overlayAlpha = (page) =>
  page.evaluate(() => {
    const layers = window.__godsEyeView.viewer.imageryLayers;
    return layers.length ? layers.get(layers.length - 1).alpha : null;
  });
const sliderValue = (page) =>
  page.$eval(SLIDER, (input) => Number(input.value)).catch(() => null);
/** Open the Data Layers panel as a person would, and bring the row into view. */
async function showRow(page) {
  const collapsed = await page.$eval('#data-panel', (el) =>
    el.classList.contains('collapsed'),
  );
  // The panel starts collapsed behind the DATA LAYERS entry in the left rail.
  if (collapsed) {
    // The rail can move during startup; a click may land off the button.
    // Check whether it opened before attempting the gesture again.
    for (let attempt = 0; attempt < 5; attempt++) {
      await page.click('button ::-p-text(DATA LAYERS)');
      await sleep(150);
      if (
        !(await page.$eval('#data-panel', (el) =>
          el.classList.contains('collapsed'),
        ))
      )
        break;
    }
    await page.$eval('#data-panel', (el) => {
      if (el.classList.contains('collapsed'))
        throw new Error('DATA LAYERS click did not open the panel');
    });
  }
  await page.$eval(SLIDER, (input) =>
    input.scrollIntoView({ block: 'center' }),
  );
  await page.waitForFunction(
    (selector) => {
      const rect = document.querySelector(selector)?.getBoundingClientRect();
      return Boolean(rect && rect.width > 0 && rect.height > 0);
    },
    { timeout: 10000 },
    SLIDER,
  );
}
const search = (page) => page.evaluate(() => location.search);

try {
  {
    const { page, errors } = await open();
    await page.evaluate(
      (id) => window.__godsEyeView.dataManager.setEnabled(id, true),
      LAYER,
    );
    await page.waitForSelector(SLIDER, { timeout: 30000 });
    check('an enabled, dimmable layer shows its slider', true);
    await showRow(page);
    check(
      'exactly one slider is on the page',
      (await page.$$('.data-toggle-opacity-slider')).length === 1,
    );
    check(
      'a layer without the hook shows none',
      !(await page.$('[data-layer-id="earthquakes"] input[type="range"]')),
    );
    check('the slider starts at 100 %', (await sliderValue(page)) === 100);
    check(
      'no lop in the address at 100 %',
      !(await search(page)).includes('lop'),
    );

    // A real drag from the right end to 40 % of the track.
    const box = await (await page.$(SLIDER)).boundingBox();
    const y = box.y + box.height / 2;
    await page.mouse.move(box.x + box.width - 2, y);
    await page.mouse.down();
    await page.mouse.move(box.x + box.width * 0.4, y, { steps: 6 });
    await page.mouse.up();
    const value = await sliderValue(page);
    check(
      'dragging moves the handle to about 40 %',
      value >= 30 && value <= 50,
      `got ${value}`,
    );
    await sleep(600);
    const alpha = await overlayAlpha(page);
    check(
      'the imagery alpha follows the handle',
      Math.abs(alpha - value / 100) < 1e-9,
      `alpha ${alpha} vs ${value}`,
    );
    check(
      'the readout shows the percentage',
      (
        await page.$eval(
          `[data-layer-id="${LAYER}"] .data-toggle-opacity-value`,
          (el) => el.textContent,
        )
      ).includes(String(value)),
    );
    const query = await search(page);
    check(
      'the address carries lop for this layer only',
      query.includes(`lop=${LAYER}:${value}`),
      query,
    );
    check('other parameters are kept', query.includes('welcome=0'), query);
    const href = await page.evaluate(() => location.href);

    // Double-click resets.
    await page.$eval(SLIDER, (input) =>
      input.dispatchEvent(new MouseEvent('dblclick', { bubbles: true })),
    );
    await sleep(600);
    check(
      'double-click returns the handle to 100 %',
      (await sliderValue(page)) === 100,
    );
    check('double-click restores full alpha', (await overlayAlpha(page)) === 1);
    check('double-click removes lop', !(await search(page)).includes('lop'));
    check(
      'no uncaught browser errors',
      errors.length === 0,
      `${errors.length} page errors`,
    );
    await page.close();

    // A fresh load of the dimmed address restores the setting.
    const restored = await open(href.slice(href.indexOf('&lop=')));
    await restored.page.evaluate(
      (id) => window.__godsEyeView.dataManager.setEnabled(id, true),
      LAYER,
    );
    await restored.page.waitForSelector(SLIDER, { timeout: 30000 });
    check(
      'a loaded address restores the handle',
      (await sliderValue(restored.page)) === value,
    );
    check(
      'a loaded address restores the alpha',
      Math.abs((await overlayAlpha(restored.page)) - value / 100) < 1e-9,
    );
    check(
      'no uncaught browser errors on restore',
      restored.errors.length === 0,
    );
    await restored.page.close();
  }

  {
    // Hostile values: nothing throws, nothing is dimmed.
    const hostile = [
      '&lop=__proto__:50,constructor:10',
      `&lop=${LAYER}:abc,${LAYER}:-5,:50,${LAYER}`,
      `&lop=${'a:5,'.repeat(3000)}`,
      '&lop[]=sea-marks:40&lop=%ZZ',
      `&lop=nope:5,${LAYER}:100`,
    ];
    for (const query of hostile) {
      const { page, errors } = await open(query);
      await page.evaluate(
        (id) => window.__godsEyeView.dataManager.setEnabled(id, true),
        LAYER,
      );
      await page.waitForSelector(SLIDER, { timeout: 30000 });
      check(
        `hostile lop leaves the layer at 100 % (${query.slice(0, 30)})`,
        (await sliderValue(page)) === 100 && (await overlayAlpha(page)) === 1,
      );
      check(
        'and throws nothing',
        errors.length === 0,
        `${errors.length} page errors`,
      );
      await page.close();
    }
  }
} finally {
  await browser.close();
}
console.log(`RESULT: ${failures} failures`);
process.exitCode = failures ? 1 : 0;
