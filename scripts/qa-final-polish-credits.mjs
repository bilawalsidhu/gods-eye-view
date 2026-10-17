#!/usr/bin/env node
/** Persistent inline attribution through actual OSM layer display lifetimes. */
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import puppeteer from 'puppeteer';
import { moveCamera } from './qa-journey-recorder.mjs';
const url = process.argv.find((a) => /^https?:/.test(a));
if (!url) throw new Error('Supply the running server URL');
const dir = process.env.QA_POLISH_DIR || 'qa-shots/final-polish';
await fs.mkdir(dir, { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const result = { states: [], errors: [] };
const browser = await puppeteer.launch({
  headless: true,
  args: ['--use-angle=metal'],
});
try {
  const page = await browser.newPage();
  await page.setViewport({ width: 1440, height: 900 });
  page.on('pageerror', (e) => result.errors.push(e.message));
  page.on('console', (m) => {
    if (m.type() === 'error') result.errors.push(m.text());
  });
  await page.evaluateOnNewDocument(() =>
    sessionStorage.setItem('gev:first-run-mission-session:v1', 'dismissed'),
  );
  await page.goto(`${url}/?welcome=0`, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(
    () =>
      window.__godsEyeView?.dataManager &&
      document.getElementById('loading-screen')?.classList.contains('hidden'),
    { timeout: 120000 },
  );
  await page.evaluate(
    () => window.__godsEyeView.styleManager.initialRestorePromise,
  );
  await page.keyboard.press('Escape');
  await page.evaluate(async () => {
    const g = window.__godsEyeView;
    for (const [id] of g.dataManager.layers)
      await g.dataManager.setEnabled(id, false);
    g.styleManager.setDetection({ enabled: false });
  });
  await moveCamera(
    page,
    { lon: -97.765, lat: 30.3125, height: 3500, pitch: -80 },
    0,
  );
  const toggle = (id, value) =>
    page.evaluate(
      (id, value) => window.__godsEyeView.dataManager.setEnabled(id, value),
      id,
      value,
    );
  const text = () => page.$eval('#cesium-credits', (e) => e.innerText);
  const shot = async (name, osm, tiles) => {
    await sleep(300);
    const state = await page.$eval('#cesium-credits', (e) => {
      const nodes = [
        ...e.querySelectorAll('a,img,.cesium-credit-expand-link'),
      ].filter((n) =>
        n.checkVisibility({ visibilityProperty: true, opacityProperty: true }),
      );
      return {
        text: e.innerText,
        rects: nodes
          .map((n) => {
            const b = n.getBoundingClientRect();
            return {
              text: n.textContent || n.alt || 'image',
              x: b.x,
              y: b.y,
              width: b.width,
              height: b.height,
              reachable: n.contains(
                document.elementFromPoint(
                  b.x + b.width / 2,
                  b.y + b.height / 2,
                ),
              ),
            };
          })
          .filter((b) => b.width > 0 && b.height > 0),
      };
    });
    assert.equal(state.text.includes('© OpenStreetMap'), osm);
    assert.equal(state.text.includes('© OpenMapTiles'), tiles);
    assert.equal(
      (state.text.match(/© OpenStreetMap/g) || []).length,
      osm ? 1 : 0,
    );
    assert.ok(state.rects.length >= 3);
    const centers = state.rects.map((b) => b.y + b.height / 2);
    assert.ok(
      Math.max(...centers) - Math.min(...centers) < 12,
      `${name}: credits stay on one desktop row`,
    );
    assert.ok(
      state.rects.every(
        (b) => b.x >= 0 && b.x + b.width <= page.viewport().width,
      ),
      'no credit clipped',
    );
    assert.ok(
      state.rects.every((b) => b.reachable),
      'all credits and the attribution link remain clear of controls',
    );
    await page.screenshot({ path: `${dir}/after-${name}.png` });
    await page.screenshot({
      path: `${dir}/after-${name}-row.png`,
      clip: { x: 16, y: 750, width: 1150, height: 150 },
    });
    result.states.push({ name, ...state });
  };
  await sleep(1600);
  await shot('nothing', false, false);
  await toggle('alpr-cameras', true);
  await page.waitForFunction(
    () =>
      document
        .querySelector('#cesium-credits')
        .innerText.includes('© OpenStreetMap'),
    { timeout: 60000 },
  );
  await shot('alpr', true, false);
  await sleep(6000);
  await shot('alpr-persistent', true, false);
  await toggle('traffic', true);
  await page.waitForFunction(
    () =>
      document
        .querySelector('#cesium-credits')
        .innerText.includes('© OpenMapTiles'),
    { timeout: 60000 },
  );
  await shot('alpr-and-traffic', true, true);
  await toggle('alpr-cameras', false);
  await shot('traffic', true, true);
  for (const width of [1280, 1920]) {
    await page.setViewport({ width, height: 900 });
    await sleep(500);
    await shot(`traffic-${width}`, true, true);
  }
  await page.setViewport({ width: 1440, height: 900 });
  await page.evaluate(() =>
    window.__godsEyeView.styleManager.setCleanView(true),
  );
  await shot('traffic-clean-ui', true, true);
  await page.evaluate(() =>
    window.__godsEyeView.styleManager.setCleanView(false),
  );
  await toggle('traffic', false);
  await shot('nothing-restored', false, false);
  assert.deepEqual(result.errors, []);
  console.log(JSON.stringify(result, null, 2));
} finally {
  await fs.writeFile(`${dir}/credits.json`, JSON.stringify(result, null, 2));
  await browser.close();
}
