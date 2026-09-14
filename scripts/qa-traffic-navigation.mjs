#!/usr/bin/env node
// Deterministic city-navigation exercise; road/flow responses are fixtures.
import assert from 'node:assert/strict';
import puppeteer from 'puppeteer';
import { trafficFixtureResponse } from './traffic-fixtures.mjs';

const args = process.argv.slice(2);
const url = args[args.indexOf('--url') + 1] || 'http://localhost:4173';
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const browser = await puppeteer.launch({
  headless: true,
  protocolTimeout: 120000,
  args: [
    '--no-sandbox',
    '--disable-dev-shm-usage',
    '--use-gl=angle',
    '--use-angle=swiftshader',
    '--disable-background-timer-throttling',
  ],
});
try {
  for (const cctv of [false, true]) {
    const page = await browser.newPage();
    const errors = [];
    let londonRequests = 0;
    page.on('pageerror', (error) => errors.push(error.message));
    page.on('console', (message) => {
      if (message.text().includes('[Data:Traffic]'))
        console.log(message.text());
    });
    await page.setViewport({ width: 1280, height: 800 });
    await page.setRequestInterception(true);
    page.on('request', (request) => {
      let response = trafficFixtureResponse(request);
      const query = new URLSearchParams(request.postData()).get('data') || '';
      if (query.includes('highway') && query.includes('(51.')) {
        londonRequests++;
        if (londonRequests === 1)
          response = { status: 504, body: 'Temporary road source timeout' };
      }
      return response ? request.respond(response) : request.continue();
    });
    await page.goto(`${url}/?welcome=0`, { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => window.__godsEyeView?.dataManager, {
      timeout: 60000,
    });
    await sleep(5000);
    await page.keyboard.press('Escape');
    await page.evaluate(async (withCctv) => {
      const { viewer, dataManager } = window.__godsEyeView;
      const C = await import('/node_modules/.vite/deps/cesium.js');
      for (const id of ['satellites', 'flights', 'military'])
        await dataManager.setEnabled(id, false);
      viewer.camera.cancelFlight();
      viewer.camera.setView({
        destination: C.Cartesian3.fromDegrees(-97.744, 30.267, 3200),
        orientation: { heading: 0, pitch: -Math.PI / 2, roll: 0 },
      });
      await dataManager.setEnabled('traffic', true);
      if (withCctv) await dataManager.setEnabled('cctv', true);
    }, cctv);
    const ready = () => {
      const stats = window.__godsEyeView.dataManager.layers
        .get('traffic')
        .module.getStats();
      return stats.count > 0 && !stats.loading;
    };
    try {
      await page.waitForFunction(ready, { timeout: 45000 });
    } catch (error) {
      console.log(
        'Traffic timeout state',
        await page.evaluate(() => {
          const { viewer, dataManager } = window.__godsEyeView;
          return {
            stats: dataManager.layers.get('traffic').module.getStats(),
            camera: viewer.camera.positionCartographic,
          };
        }),
      );
      throw error;
    }
    await sleep(2500);
    await page.evaluate(async () => {
      const { viewer } = window.__godsEyeView;
      const C = await import('/node_modules/.vite/deps/cesium.js');
      viewer.camera.flyTo({
        destination: C.Cartesian3.fromDegrees(-0.1276, 51.5072, 3200),
        orientation: { heading: 0, pitch: -Math.PI / 2, roll: 0 },
        duration: 4,
      });
    });
    const deadline = Date.now() + 45000;
    while (londonRequests < 2 && Date.now() < deadline) await sleep(500);
    assert.ok(
      londonRequests >= 2,
      'London must recover its failed request without a toggle',
    );
    await page.waitForFunction(ready, { timeout: 45000 });
    const stats = await page.evaluate(() =>
      window.__godsEyeView.dataManager.layers.get('traffic').module.getStats(),
    );
    assert.equal(stats.error, null);
    assert.deepEqual(errors, []);
    console.log(
      'PASS: Austin → London, first destination request fails then recovers',
      { cctv, londonRequests, count: stats.count },
    );
    await page.evaluate(() =>
      window.__godsEyeView.dataManager.setEnabled('traffic', false),
    );
    assert.equal(
      await page.evaluate(
        () =>
          window.__godsEyeView.dataManager.layers
            .get('traffic')
            .module.getStats().loading,
      ),
      false,
    );
    await page.close();
  }
} finally {
  await browser.close();
}
