#!/usr/bin/env node
/**
 * qa-perimeters-perf.mjs — long tasks of the Fire Perimeters layer's redraw
 * on Cesium, for a synthetic peak day (scripts/fixtures/perimeterPeak.mjs:
 * about 1000 pieces, 0.8 million vertices) stepped an hour at a time.
 *
 * Drives the real app in headless Chromium against a keyless dev server:
 *   GOOGLE_MAPS_API_KEY= CESIUM_ION_TOKEN= npm run dev -- --port 5199
 *   node scripts/qa-perimeters-perf.mjs --url http://localhost:5199
 *
 * The layer is made in the page over the app's viewer, with a source that
 * serves the peak snapshot at the moment asked. After the first draw
 * settles, each step moves the moment on an hour and reads again from a
 * task of the page's own (its `longtask` observer never sees a task run by
 * `page.evaluate`), then waits until no long task has run for
 * `--quiet-ms`. It reports the long tasks that overlap the step, then the
 * draw commands of a frame and the time of a frame drawn.
 *
 * Options:
 *   --steps 6
 *   --no-ids       pieces without `pieces[].id`, drawn whole
 *   --layer /src/layers/perimeters/index.js
 *                  the layer module the page imports. To time another version,
 *                  copy it beside this one, where its relative imports resolve
 *                  (e.g. `git show origin/main:src/layers/perimeters/index.js >
 *                  src/layers/perimeters/index.main.js`), and delete the copy afterwards.
 *   --quiet-ms 3000
 *   --json out.json
 *   --no-sandbox   Chromium without its sandbox, where it cannot start with it
 */

import puppeteer from 'puppeteer';
import fs from 'node:fs';

const argv = process.argv.slice(2);
const opt = (name, dflt) => {
  const i = argv.indexOf(name);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : dflt;
};
const APP_URL = opt('--url', 'http://localhost:5199');
const STEPS = Number(opt('--steps', '6'));
const QUIET_MS = Number(opt('--quiet-ms', '3000'));
const IDS = !argv.includes('--no-ids');
const JSON_OUT = opt('--json', null);
const LAYER = opt('--layer', '/src/layers/perimeters/index.js');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const browser = await puppeteer.launch({
  headless: 'new',
  protocolTimeout: 600_000,
  args: [
    ...(argv.includes('--no-sandbox') ? ['--no-sandbox'] : []),
    '--window-size=1440,900',
    '--use-angle=metal',
    '--disable-backgrounding-occluded-windows',
    '--disable-renderer-backgrounding',
    '--disable-background-timer-throttling',
  ],
});

try {
  const page = await browser.newPage();
  page.on('pageerror', (e) =>
    console.error('[page]', JSON.stringify(String(e.message))),
  );
  await page.setViewport({ width: 1440, height: 860 });
  await page.goto(`${APP_URL}/?welcome=0`, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(
    () => window.__godsEyeView?.viewer && window.__godsEyeView?.dataManager,
    { timeout: 120_000 },
  );
  await sleep(8000);
  await page.keyboard.press('Escape');
  await page.evaluate(async () => {
    const gev = window.__godsEyeView;
    const v = gev.viewer;
    v.camera.cancelFlight?.();
    for (const [id, entry] of gev.dataManager.layers)
      if (entry.enabled)
        try {
          await gev.dataManager.setEnabled(id, false, { origin: 'user' });
        } catch {
          /* left on */
        }
    v.camera.setView({
      destination: v.scene.globe.ellipsoid.cartographicToCartesian({
        longitude: (-114 * Math.PI) / 180,
        latitude: (40 * Math.PI) / 180,
        height: 2_500_000,
      }),
      orientation: { heading: 0, pitch: -Math.PI / 2, roll: 0 },
    });
  });
  await sleep(5000);

  const setup = await page.evaluate(
    async (ids, layerUrl, steps) => {
      const { createFirePerimetersLayer } = await import(layerUrl);
      const { perimeterPeak, peakSnapshot, peakVertices } =
        await import('/scripts/fixtures/perimeterPeak.mjs');
      const v = window.__godsEyeView.viewer;
      const peak = perimeterPeak({ afterHours: steps });
      const bench = (window.__perimeterBench = {
        at: peak.start,
        long: [],
        lastLong: performance.now(),
      });
      new PerformanceObserver((list) => {
        for (const entry of list.getEntries()) {
          bench.long.push({ start: entry.startTime, ms: entry.duration });
          bench.lastLong = entry.startTime + entry.duration;
        }
      }).observe({ type: 'longtask', buffered: false });
      // Frames keep coming while it measures, as when the timeline plays.
      const frame = () => {
        v.scene.requestRender();
        requestAnimationFrame(frame);
      };
      requestAnimationFrame(frame);
      const layer = createFirePerimetersLayer({
        source: {
          getSnapshot: async () => peakSnapshot(peak, bench.at, { ids }),
        },
      });
      layer.init(v);
      layer.enable(v);
      bench.layer = layer;
      return peakVertices(peakSnapshot(peak, peak.start));
    },
    IDS,
    LAYER,
    STEPS,
  );
  console.log('peak snapshot:', setup, IDS ? '(with piece ids)' : '(no ids)');

  /** Read at the moment `hours` on, and wait until it is quiet. */
  const step = (hours) =>
    page.evaluate(
      async (hours, quietMs) => {
        const bench = window.__perimeterBench;
        const t0 = performance.now();
        bench.at += hours * 3600000;
        const { ok, updateMs } = await new Promise((resolve) =>
          setTimeout(() => {
            const start = performance.now();
            bench.layer
              .update()
              .then((ok) =>
                resolve({ ok, updateMs: performance.now() - start }),
              );
          }, 0),
        );
        bench.lastLong = Math.max(bench.lastLong, performance.now());
        const deadline = performance.now() + 90_000;
        while (
          performance.now() - bench.lastLong < quietMs &&
          performance.now() < deadline
        )
          await new Promise((r) => setTimeout(r, 250));
        const long = bench.long
          .filter((entry) => entry.start + entry.ms > t0)
          .map((entry) => Math.round(entry.ms));
        const scene = window.__godsEyeView.viewer.scene;
        let drawn = 0;
        const off = scene.postRender.addEventListener(() => {
          drawn += 1;
        });
        const frameStart = performance.now();
        for (let i = 0; i < 20; i++) {
          scene.requestRender();
          scene.render();
        }
        const elapsed = performance.now() - frameStart;
        off();
        return {
          ok,
          updateMs: Math.round(updateMs),
          long,
          commands: scene.frameState.commandList.length,
          frameMs: drawn ? Math.round((elapsed / drawn) * 10) / 10 : null,
        };
      },
      hours,
      QUIET_MS,
    );

  const first = await step(0);
  console.log('first draw:', JSON.stringify(first));
  const steps = [];
  for (let i = 1; i <= STEPS; i++) {
    const result = await step(1);
    const max = Math.max(0, ...result.long);
    const sum = result.long.reduce((a, b) => a + b, 0);
    steps.push({ ...result, max, sum });
    console.log(
      `+${i} h: update ${result.updateMs} ms, long tasks [${result.long.join(', ')}] ms, max ${max}, total ${sum}; then a frame ${result.frameMs} ms, ${result.commands} commands`,
    );
  }
  const maxes = steps.map((s) => s.max).sort((a, b) => a - b);
  const mid = Math.floor(maxes.length / 2);
  const median =
    maxes.length % 2
      ? maxes[mid]
      : Math.round((maxes[mid - 1] + maxes[mid]) / 2);
  console.log(
    `steps: max long task median ${median} ms, worst ${maxes.at(-1)} ms`,
  );
  if (JSON_OUT)
    fs.writeFileSync(
      JSON_OUT,
      JSON.stringify({ setup, first, steps }, null, 2),
    );
} finally {
  await browser.close();
}
