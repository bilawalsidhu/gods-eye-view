#!/usr/bin/env node
/** Supplied decoded weather tiles on Cesium, and inert controls on Navara.
 * Requires a keyless dev server: node scripts/qa-weather-decoded-tiles.mjs http://localhost:4312
 */
import assert from 'node:assert/strict';
import { launchBrowser, closeBrowser } from './qa/browser.mjs';
import { waitForEngine } from './qa-strict-harness.mjs';
import { blockPaidQaMaps } from './qa-map-policy.mjs';
import { evaluateWithGeo } from './qa/geometry.mjs';

const base = new URL(process.argv[2] || 'http://localhost:4312');
const browser = await launchBrowser();
try {
  for (const kind of ['cesium', 'navara']) {
    const page = await browser.newPage();
    await blockPaidQaMaps(page);
    const url = new URL(base);
    url.search = `?engine=${kind}&welcome=0`;
    await page.goto(url.href, { waitUntil: 'domcontentloaded' });
    await waitForEngine(page, kind);
    await evaluateWithGeo(page, (geo) => {
      window.__godsEyeView.engine.camera.setView({
        destination: geo.cartesian3.fromDegrees(-79.38, 43.65, 500000),
      });
    });
    await page.evaluate(async () => {
      const { createWeatherLayer } =
        await import('/src/layers/weather/index.js');
      const { rendererFor } = await import('/src/app/layers/renderers.js');
      const { engine } = window.__godsEyeView;
      const time = '2026-11-01T12:00:00.000Z';
      const probe = { requests: 0, time, before: engine.imagery.list().length };
      probe.layer = createWeatherLayer({
        id: 'weather-radar',
        feed: {
          getSnapshot: async () => ({
            schemaVersion: 1,
            product: 'radar',
            times: [time],
            latest: time,
            bounds: { west: -130, south: 20, east: -60, north: 55 },
            tileSize: 256,
            maxLevel: 6,
            tilingScheme: 'geographic',
          }),
          getFrameTile: async () => {
            probe.requests++;
            const canvas = document.createElement('canvas');
            canvas.width = canvas.height = 256;
            const ctx = canvas.getContext('2d');
            ctx.fillStyle = '#ff00ff';
            ctx.fillRect(0, 0, 256, 256);
            return canvas;
          },
        },
        createNativeRendering: (engine, options) =>
          rendererFor('weather-radar', engine, options),
      });
      probe.layer.attachRenderer({ engine });
      probe.layer.enable();
      window.__decodedWeatherProbe = probe;
      await probe.layer.update();
    });
    if (kind === 'cesium')
      await page.waitForFunction(
        () => {
          const probe = window.__decodedWeatherProbe;
          return (
            probe.requests > 0 &&
            probe.layer.getDiagnostics().time === probe.time
          );
        },
        { timeout: 60000 },
      );
    const result = await page.evaluate(() => {
      const probe = window.__decodedWeatherProbe;
      const diagnostics = probe.layer.getDiagnostics();
      const controls = probe.layer.getRowControls();
      probe.layer.destroy();
      delete window.__decodedWeatherProbe;
      return {
        requests: probe.requests,
        time: diagnostics.time,
        expectedTime: probe.time,
        controls: controls !== null,
        remaining: window.__godsEyeView.engine.imagery.list().length,
        before: probe.before,
      };
    });
    if (kind === 'cesium') {
      assert.ok(result.requests > 0);
      assert.equal(result.time, result.expectedTime);
      assert.equal(result.controls, true);
    } else {
      assert.equal(result.requests, 0);
      assert.equal(result.time, null);
      assert.equal(result.controls, false);
    }
    assert.equal(result.remaining, result.before);
    console.log(
      `[PASS] decoded weather tiles on ${kind}: ${JSON.stringify(result)}`,
    );
    await page.close();
  }
} finally {
  await closeBrowser(browser);
}
