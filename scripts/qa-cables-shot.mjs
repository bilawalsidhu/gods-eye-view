#!/usr/bin/env node
/**
 * qa-cables-shot — capture the cables layer at two fixed cameras for
 * before/after visual-identity comparison. Writes to gitignored qa-shots/.
 * Usage: node scripts/qa-cables-shot.mjs [--url http://localhost:4214] [--tag before]
 */
import puppeteer from 'puppeteer';
import { mkdirSync } from 'node:fs';
import { installCompositorFramePump } from './lib/headlessFrames.mjs';

const argv = process.argv;
const url = argv.includes('--url') ? argv[argv.indexOf('--url') + 1] : 'http://localhost:4214';
const tag = argv.includes('--tag') ? argv[argv.indexOf('--tag') + 1] : 'shot';
const LAYER_ID = 'telegeography-submarine-cables';
mkdirSync(new URL('../qa-shots', import.meta.url), { recursive: true });

const browser = await puppeteer.launch({
  headless: 'new',
  protocolTimeout: 300_000,
  args: [
    '--no-sandbox', '--disable-setuid-sandbox', '--window-size=1440,900',
    '--disable-backgrounding-occluded-windows', '--disable-renderer-backgrounding',
    '--disable-background-timer-throttling',
  ],
});
try {
  const page = await browser.newPage();
  // A settled scene stops producing BeginFrames, so neither the boot waits
  // below nor the 240-frame settle would ever observe a tick — pump frames
  // from Node instead of hoping rAF flows (headlessFrames.mjs header).
  await installCompositorFramePump(page);
  await page.setViewport({ width: 1440, height: 860 });
  await page.goto(url, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => Boolean(window.__godsEyeView?.viewer), { timeout: 90_000 });
  await new Promise((r) => setTimeout(r, 12_000));
  await page.evaluate(async (layerId) => {
    const gev = window.__godsEyeView;
    gev.viewer.camera.cancelFlight();
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
    await page.evaluate((v) => {
      const viewer = window.__godsEyeView.viewer;
      const ell = viewer.scene.globe.ellipsoid;
      viewer.camera.setView({
        destination: ell.cartographicToCartesian({
          longitude: v.lon * Math.PI / 180, latitude: v.lat * Math.PI / 180, height: v.height,
        }),
        orientation: { heading: 0, pitch: -Math.PI / 2, roll: 0 },
      });
    }, view);
    // Let the sweep + labels settle. Each forced frame services the pending
    // requestRender — the original 240-tick `requestAnimationFrame` chain
    // hung forever here: on a settled scene the compositor produces no
    // BeginFrames, so the FIRST rAF of the chain never fired and the
    // evaluate ran into its 300 s protocolTimeout.
    await page.evaluate(async () => {
      const v = window.__godsEyeView.viewer;
      for (let ticks = 0; ticks < 240; ticks += 1) {
        v.scene.requestRender?.();
        if (typeof window.__qaForceCompositorFrame === 'function') {
          await window.__qaForceCompositorFrame();
        } else {
          await new Promise((resolve) => requestAnimationFrame(resolve));
        }
      }
    });
    await new Promise((r) => setTimeout(r, 1_000));
    const path = new URL(`../qa-shots/cables-${tag}-${view.name}.png`, import.meta.url).pathname;
    await page.screenshot({ path });
    console.log(`saved ${path}`);
  }
} finally {
  await browser.close();
}
