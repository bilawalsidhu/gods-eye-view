#!/usr/bin/env node
// Cesium-only probes: manual native renders isolate Cesium cable render cost.
import { evaluateWithGeo } from './qa/geometry.mjs';
import { whenSettled } from './qa/ready.mjs';
import { launchBrowser, closeBrowser } from './qa/browser.mjs';
/**
 * qa-cables-render-probe — replicates the owner-side perf probe methodology
 * for the cables layer (relative numbers; SwiftShader when run headless):
 *
 *  1. PARKED: timed full `viewer.render()` loop (40 calls) with cables ON,
 *     then OFF, at the fixed mid-Atlantic camera. Reports mean/max.
 *  2. PAN-STOP: 3 cycles of { setView to an offset, raise camera.moveEnd,
 *     wait 650 ms, 20 timed `viewer.render()` calls }. Reports per-cycle
 *     mean/max and the worst frame across cycles, cables ON vs OFF.
 *
 * Usage: node scripts/qa-cables-render-probe.mjs [--url http://localhost:4216]
 */

const argv = process.argv;
const url = argv.includes('--url') ? argv[argv.indexOf('--url') + 1] : 'http://localhost:4216';
const LAYER_ID = 'telegeography-submarine-cables';

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

  await evaluateWithGeo(page, async (qaGeo) => {
    const gev = window.__godsEyeView;
    window.__godsEyeView.engine.camera.cancelFlight();
    window.__godsEyeView.engine.camera.setView({
      destination: qaGeo.cartographic.toCartesian({
        longitude: -40 * Math.PI / 180, latitude: 35 * Math.PI / 180, height: 4_500_000,
      }),
      orientation: { heading: 0, pitch: -Math.PI / 2, roll: 0 },
    });
    for (const [id, entry] of gev.dataManager.layers) {
      if (entry.enabled) { try { await gev.dataManager.setEnabled(id, false, { origin: 'user' }); } catch { /* probe */ } }
    }
  });
  await whenSettled(page);

  const stats = (values) => ({
    mean: +(values.reduce((s, v) => s + v, 0) / Math.max(1, values.length)).toFixed(2),
    max: +Math.max(...values).toFixed(2),
  });

  const measure = async (label, enabled) => {
    await page.evaluate(async (id, on) => {
      const gev = window.__godsEyeView;
      await gev.dataManager.setEnabled(id, on, { origin: 'user' });
    }, LAYER_ID, enabled);
    await whenSettled(page); // load/teardown + settle

    // 1. PARKED timed renders.
    const parked = await page.evaluate(() => {
      const v = window.__godsEyeView.viewer;
      const durations = [];
      for (let i = 0; i < 40; i++) {
        const t0 = performance.now();
        v.render();
        durations.push(performance.now() - t0);
      }
      return durations;
    });

    // 2. PAN-STOP cycles: move, raise moveEnd, wait 650 ms, 20 timed renders.
    const cycles = [];
    for (let cycle = 0; cycle < 3; cycle++) {
      const frames = await evaluateWithGeo(page, async (qaGeo, step) => {
        const v = window.__godsEyeView.viewer;
        window.__godsEyeView.engine.camera.setView({
          destination: qaGeo.cartographic.toCartesian({
            longitude: (-40 + step * 3) * Math.PI / 180,
            latitude: 35 * Math.PI / 180,
            height: 4_500_000,
          }),
          orientation: { heading: 0, pitch: -Math.PI / 2, roll: 0 },
        });
        window.__godsEyeView.engine.camera.moveEnd.raiseEvent();
        await new Promise((resolve) => setTimeout(resolve, 650));
        const durations = [];
        for (let i = 0; i < 20; i++) {
          const t0 = performance.now();
          v.render();
          durations.push(performance.now() - t0);
        }
        return durations;
      }, cycle + 1);
      cycles.push(stats(frames));
    }

    const worst = Math.max(...cycles.map((c) => c.max));
    console.log(`  [${label}] parked render: ${JSON.stringify(stats(parked))}`);
    console.log(`  [${label}] pan-stop cycles: ${JSON.stringify(cycles)} worstFrame=${worst}`);
    return { parked: stats(parked), cycles, worst };
  };

  const on = await measure('cables ON ', true);
  const off = await measure('cables OFF', false);
  console.log(`\nparked delta (ON-OFF mean): ${(on.parked.mean - off.parked.mean).toFixed(2)}ms`);
  console.log(`pan-stop worst: ON ${on.worst}ms vs OFF ${off.worst}ms`);
} finally {
  await closeBrowser(browser);
}
