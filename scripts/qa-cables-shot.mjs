#!/usr/bin/env node
import { evaluateWithGeo } from './qa/geometry.mjs';
import { whenSettled } from './qa/ready.mjs';
/**
 * qa-cables-shot — capture the cables layer at two fixed cameras for
 * before/after visual-identity comparison. Writes to gitignored qa-shots/.
 * Usage: node scripts/qa-cables-shot.mjs [--url http://localhost:4214] [--tag before]
 */
import { launchBrowser, closeBrowser } from './qa/browser.mjs';
import { mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const argv = process.argv;
const url = argv.includes('--url') ? argv[argv.indexOf('--url') + 1] : 'http://localhost:4214';
const tag = argv.includes('--tag') ? argv[argv.indexOf('--tag') + 1] : 'shot';
const LAYER_ID = 'telegeography-submarine-cables';
mkdirSync(new URL('../qa-shots', import.meta.url), { recursive: true });

const browser = await launchBrowser({
  headless: true,
  protocolTimeout: 300_000,
  args: ['--no-sandbox', '--disable-setuid-sandbox', '--window-size=1440,900', '--disable-backgrounding-occluded-windows', '--disable-renderer-backgrounding', '--disable-background-timer-throttling'],
});
try {
  const page = await browser.newPage();
  await page.setViewport({ width: 1440, height: 860 });
  await page.goto(url, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => !!window.__godsEyeView?.engine, { timeout: 90_000 });
  await whenSettled(page);
  await page.evaluate(async (layerId) => {
    const gev = window.__godsEyeView;
    window.__godsEyeView.engine.camera.cancelFlight();
    for (const [id, entry] of gev.dataManager.layers) {
      if (entry.enabled && id !== layerId) {
        try { await gev.dataManager.setEnabled(id, false, { origin: 'user' }); } catch { /* shot only */ }
      }
    }
    await gev.dataManager.setEnabled(layerId, true, { origin: 'user' });
  }, LAYER_ID);

  const views = [
    { name: 'atlantic', lon: -40, lat: 35, height: 4_500_000 },
    { name: 'ny-coast', lon: -73.5, lat: 40.4, height: 500_000 },
  ];
  for (const view of views) {
    await evaluateWithGeo(page, async (qaGeo, v) => {
      window.__godsEyeView.engine.camera.setView({
        destination: qaGeo.cartographic.toCartesian({
          longitude: v.lon * Math.PI / 180, latitude: v.lat * Math.PI / 180, height: v.height,
        }),
        orientation: { heading: 0, pitch: -Math.PI / 2, roll: 0 },
      });
    }, view);
    // Let the sweep + labels settle with frames flowing.
    await page.evaluate(() => new Promise((resolve) => {
      let ticks = 0;
      const tick = () => {
        window.__godsEyeView.engine.render.request?.();
        if (++ticks < 240) requestAnimationFrame(tick); else resolve();
      };
      requestAnimationFrame(tick);
    }));
    await whenSettled(page);
    const path = fileURLToPath(
      new URL(`../qa-shots/cables-${tag}-${view.name}.png`, import.meta.url),
    );
    await page.screenshot({ path });
    console.log(`saved ${path}`);
  }
} finally {
  await closeBrowser(browser);
}
