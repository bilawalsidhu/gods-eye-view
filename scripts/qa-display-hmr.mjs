/** Display HMR regression: run only against this checkout's dev server.
 * QA_BASE_URL=http://127.0.0.1:5181 node scripts/qa-display-hmr.mjs
 * Temporarily edits and restores the two Display views to exercise real HMR.
 */
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import puppeteer from 'puppeteer';

const browser = await puppeteer.launch({ headless: true });
let restore;
try {
  const page = await browser.newPage();
  await page.setViewport({ width: 1440, height: 900 });
  await page.goto(
    `${process.env.QA_BASE_URL || 'http://localhost:4173'}/?welcome=0`,
    { waitUntil: 'networkidle2' },
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
    if (await page.$('#pp-toggles.collapsed'))
      await page.click('.gev-panel-rail--right button');
    await page.waitForSelector('#pp-toggles:not(.collapsed)', {
      visible: true,
    });
  };
  await open();
  await page.select('#hud-layout-select', 'cyber');
  for (const name of ['DisplayPanel.vue', '../DisplayControlsView.vue']) {
    const file = new URL(`../src/ui/views/panels/${name}`, import.meta.url);
    const original = await readFile(file, 'utf8');
    restore = () => writeFile(file, original);
    const before = await page.evaluate(() => performance.timeOrigin);
    await writeFile(
      file,
      original.replace(
        '<script setup>',
        '<script setup>\n// Exercise the relocated Display reload policy.',
      ),
    );
    await page.waitForFunction(
      (previous) => performance.timeOrigin !== previous,
      { timeout: 60000 },
      before,
    );
    await ready();
    assert.equal(
      await page.$$eval('#pp-toggles', (panels) => panels.length),
      1,
    );
    await open();
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
    await page.click('.gev-panel-rail--right button');
    await page.waitForFunction(
      () => document.getElementById('hud-toggle').getClientRects().length === 0,
    );
    const beforeRestore = await page.evaluate(() => performance.timeOrigin);
    await restore();
    restore = null;
    await page.waitForFunction(
      (previous) => performance.timeOrigin !== previous,
      { timeout: 60000 },
      beforeRestore,
    );
    await ready();
    await open();
  }
  console.log(
    'PASS: both Display views reload without duplicate panels, remain beside their launcher and close cleanly.',
  );
} finally {
  if (restore) await restore();
  await browser.close();
}
