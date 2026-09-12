import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import puppeteer from 'puppeteer';

const browser = await puppeteer.launch({ headless: true, args: ['--no-sandbox', '--enable-unsafe-swiftshader', '--use-gl=angle', '--use-angle=swiftshader'] });
const page = await browser.newPage();
const errors = [];
page.on('pageerror', error => errors.push(error.message));
page.on('console', message => { if (message.type() === 'error') console.error('Console:', message.text()); });
const base = process.env.QA_URL || 'http://127.0.0.1:5173';
const ready = async () => {
  await page.waitForFunction(() => (window.__godsEyeView && !document.querySelector('#interface-toggle').disabled) || document.querySelector('.loader-status')?.textContent.startsWith('Error:'), { timeout: 90000 });
  assert.equal(await page.evaluate(() => Boolean(window.__godsEyeView)), true, 'Globe initialized');
};
const visible = selector => page.$eval(selector, el => el.getBoundingClientRect().height > 0 && getComputedStyle(el).display !== 'none');
try {
  await page.setViewport({ width: 1440, height: 900 });
  await page.goto(base, { waitUntil: 'domcontentloaded' });
  await ready();
  assert.equal(await page.$eval('body', el => el.dataset.interface), 'simple');
  assert.equal(await visible('#simple-explorer'), true);
  assert.equal(await visible('#pp-toggles'), false);
  assert.equal(await page.$$eval('#simple-layer-host .data-toggle-row', rows => rows.filter(row => row.getBoundingClientRect().height > 0).length), 3);
  await page.waitForFunction(() => window.__godsEyeView.viewer.camera.positionCartographic.height > 10000000, { timeout: 15000 });
  await page.select('#simple-city', 'tokyo');
  await page.waitForFunction(() => window.__godsEyeView.styleManager._activeLocationId === 'tokyo');
  await page.waitForFunction(() => Math.abs(window.__godsEyeView.viewer.camera.positionCartographic.longitude * 180 / Math.PI - 139.75) < 2, { timeout: 30000 });
  const longitude = await page.evaluate(() => window.__godsEyeView.viewer.camera.positionCartographic.longitude * 180 / Math.PI);
  assert.ok(Math.abs(longitude - 139.75) < 2, `Tokyo longitude: ${longitude}`);
  await page.select('#simple-city', 'tokyo');
  assert.equal(await page.evaluate(() => window.__godsEyeView.styleManager._activePoiIndex), 0);
  console.log('PASS: simple default, three layers, city navigation and repeated destination');

  await page.click('#simple-layer-host [data-layer-id="earthquakes"] button');
  await page.waitForFunction(() => window.__godsEyeView.dataManager.isEnabled('earthquakes'), { timeout: 60000 });
  await page.click('#simple-clear');
  await page.waitForFunction(() => window.__godsEyeView.dataManager.getEnabledLayerIds().size === 0);
  await page.click('#simple-reset');
  await page.waitForFunction(() => window.__godsEyeView.viewer.camera.positionCartographic.height > 1000000, { timeout: 15000 });
  console.log('PASS: actual earthquake layer enable, clear all and globe reset');

  await page.click('#interface-toggle');
  assert.equal(await visible('#simple-explorer'), false);
  assert.equal(await page.$eval('#data-toggles', el => el.parentElement.className), 'data-panel-inner');
  await page.reload({ waitUntil: 'domcontentloaded' });
  await ready();
  assert.equal(await page.$eval('body', el => el.dataset.interface), 'full');
  // Dismiss the full interface's welcome card through its actual close path.
  await new Promise(resolve => setTimeout(resolve, 2200));
  await page.keyboard.press('Escape');
  await page.click('#interface-toggle');
  assert.equal(await visible('#simple-explorer'), true);
  console.log('PASS: full interface restores layer panel, preference survives reload, switch back');

  await page.reload({ waitUntil: 'domcontentloaded' });
  await ready();
  assert.equal(await page.$eval('body', el => el.dataset.interface), 'simple');
  await page.click('#simple-reset');
  await page.waitForFunction(() => window.__godsEyeView.viewer.camera.positionCartographic.height > 10000000, { timeout: 15000 });
  await new Promise(resolve => setTimeout(resolve, 2500));
  console.log('PASS: saved simple view survives a URL containing restored map state');

  await mkdir('qa-shots/simple-view', { recursive: true });
  await page.screenshot({ path: 'qa-shots/simple-view/desktop.png' });
  await page.setViewport({ width: 390, height: 844 });
  const rect = await page.$eval('#simple-explorer', el => { const r = el.getBoundingClientRect(); return { left: r.left, right: r.right, top: r.top, bottom: r.bottom }; });
  assert.ok(rect.left >= 0 && rect.right <= 390 && rect.top >= 0 && rect.bottom <= 844);
  await page.click('#simple-layers summary');
  assert.equal(await page.$eval('#simple-layers', el => el.open), false);
  await page.screenshot({ path: 'qa-shots/simple-view/mobile.png' });
  console.log('PASS: phone layout fits viewport and layers collapse');
  assert.deepEqual(errors, [], 'Unhandled browser errors');
} catch (error) {
  console.error('Browser errors:', errors);
  console.error('Loading status:', await page.$eval('.loader-status', el => el.textContent).catch(() => 'unavailable'));
  await mkdir('qa-shots/simple-view', { recursive: true });
  await page.screenshot({ path: 'qa-shots/simple-view/failure.png' });
  throw error;
} finally {
  await browser.close();
}
