#!/usr/bin/env node
// W2 static ground-layer cost: a discarded warm-up, then three fresh
// contexts per engine, identical parser-fed populations and camera poses.
import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import puppeteer from 'puppeteer';
import { watchW1Page } from './qa-browserEvidence.mjs';
import {
  earthquakePerformanceFixture,
  W2_EPOCH_MS,
} from './fixtures/w2/earthquakes.mjs';
const arg = (name) =>
  process.argv.find((v) => v.startsWith(`--${name}=`))?.slice(name.length + 3);
const base = arg('base-url'),
  mode = arg('mode') ?? 'uncapped';
if (
  !base ||
  [4173, 4185, 4186, 4187, 4188, 4189].includes(Number(new URL(base).port))
)
  throw new Error('Supply unreserved --base-url');
if (!['uncapped', 'paced'].includes(mode)) throw new Error('Unknown mode');
const diagnostic = process.argv.includes('--diagnostic-city');
const out = path.resolve(
  arg('out') ?? `qa-artifacts/w2/earthquakes-navara/perf-${mode}.json`,
);
await fs.mkdir(path.dirname(out), { recursive: true });
const fixture = earthquakePerformanceFixture(500);
const report = {
  mode,
  look: 'minimal',
  count: 500,
  fixtureSha256: crypto
    .createHash('sha256')
    .update(JSON.stringify(fixture))
    .digest('hex'),
  diagnostic,
  measuredContextsPerEngine: diagnostic ? 1 : 3,
  warmContextsPerEngine: 1,
  measureMs: 10000,
  warmMs: 3000,
  browserErrors: [],
  runs: { cesium: [], navara: [] },
  driverSha256: crypto
    .createHash('sha256')
    .update(await fs.readFile(new URL(import.meta.url)))
    .digest('hex'),
};
const percentile = (a, p) => {
  const sorted = [...a].sort((a, b) => a - b);
  return (
    sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))] ?? null
  );
};
const median = (a) => percentile(a, 0.5);
const browser = await puppeteer.launch({
  headless: true,
  protocolTimeout: 300000,
  args: [
    '--use-angle=metal',
    ...(mode === 'uncapped'
      ? ['--disable-gpu-vsync', '--disable-frame-rate-limit']
      : []),
  ],
});
try {
  for (const engine of ['cesium', 'navara'])
    for (let run = -1; run < (diagnostic ? 1 : 3); run++) {
      const context = await browser.createBrowserContext();
      try {
        const page = await context.newPage();
        await page.setViewport({ width: 1280, height: 800 });
        watchW1Page(page, report, {
          name: `${engine}-${run}`,
          baseUrl: base,
          preview: process.argv.includes('--preview'),
        });
        await page.evaluateOnNewDocument((fixture) => {
          localStorage.setItem('gev:first-run-mission:v1', 'suppressed');
          const fetch = window.fetch.bind(window);
          window.fetch = (input, init) => {
            const url = new URL(
              typeof input === 'string' ? input : (input.url ?? input),
              location.href,
            );
            if (
              url.hostname === 'earthquake.usgs.gov' &&
              url.pathname.endsWith('/all_day.geojson')
            )
              return Promise.resolve(
                new Response(JSON.stringify(fixture), {
                  status: 200,
                  headers: { 'content-type': 'application/json' },
                }),
              );
            return fetch(input, init);
          };
        }, fixture);
        const url = new URL(base);
        url.searchParams.set('engine', engine);
        url.searchParams.set('look', 'minimal');
        const started = Date.now();
        await page.goto(url.href, {
          waitUntil: 'domcontentloaded',
          timeout: 180000,
        });
        await page.waitForFunction(
          () =>
            window.__godsEyeView?.layers &&
            document
              .getElementById('loading-screen')
              ?.classList.contains('hidden'),
          { timeout: 180000 },
        );
        await page.evaluate(
          () => window.__godsEyeView.styleManager.initialRestorePromise,
        );
        await page.evaluate(async (epoch) => {
          const a = window.__godsEyeView;
          a.styleManager.orbitController.stop();
          a.engine.camera.cancelFlight();
          for (const [id] of a.dataManager.layers)
            if (a.dataManager.isEnabled(id)) await a.layers.disable(id);
          (await import('/src/time/clock.js')).appClock.freeze(epoch);
          (await import('/src/data/detection.js')).setMode('OFF');
          if (a.viewer) {
            a.viewer.clock.currentTime =
              a.viewer.clock.currentTime.constructor.fromDate(new Date(epoch));
            a.viewer.targetFrameRate = undefined;
          }
          await a.layers.enable('earthquakes');
        }, W2_EPOCH_MS);
        const result = { startupMs: Date.now() - started, scenes: {} };
        for (const [name, pose] of Object.entries({
          global: [-100, 35, 15000000],
          city: [-122.42, 37.77, 120000],
          orbit: [-110, 35, 3000000],
        })) {
          if (diagnostic && name !== 'city') continue;
          const sample = await page.evaluate(async (pose) => {
            const a = window.__godsEyeView,
              e = a.engine,
              geo = await import('/src/geo/index.js');
            e.camera.setView({
              destination: geo.cartesian3.fromDegrees(...pose),
              orientation: { heading: 0, pitch: -Math.PI / 2, roll: 0 },
            });
            let since = null;
            const started = performance.now();
            while (performance.now() - started < 90000) {
              if (e.surface.tilesLoaded()) since ??= performance.now();
              else since = null;
              if (since !== null && performance.now() - since > 1500) break;
              e.render.request('w2-perf-settle');
              await new Promise((r) => setTimeout(r, 100));
            }
            if (!e.surface.tilesLoaded())
              throw new Error('Tiles did not settle');
            if (
              a.dataManager.layers.get('earthquakes').module.getStats()
                .count !== 500
            )
              throw new Error('Performance population is not 500');
            e.render.setContinuous(true);
            await new Promise((r) => setTimeout(r, 3000));
            const times = [],
              work = [];
            let start = null;
            const stopPre = e.frames.preRender.addEventListener(() => {
              start = performance.now();
            });
            const stopPost = e.frames.postRender.addEventListener(() => {
              const now = performance.now();
              times.push(now);
              if (start !== null) work.push(now - start);
              start = null;
            });
            const measuredFrom = performance.now();
            try {
              await new Promise((r) => setTimeout(r, 10000));
              return {
                wallMs: performance.now() - measuredFrom,
                times,
                work,
                count: a.dataManager.layers.get('earthquakes').module.getStats()
                  .count,
                canvas: {
                  width: e.host.canvas.width,
                  height: e.host.canvas.height,
                  dpr: devicePixelRatio,
                },
                epochMs: e.clock.now(),
              };
            } finally {
              stopPre();
              stopPost();
              e.render.setContinuous(false);
            }
          }, pose);
          if (
            sample.times.length < 50 ||
            sample.work.length !== sample.times.length ||
            sample.count !== 500 ||
            sample.epochMs !== W2_EPOCH_MS ||
            sample.canvas.width !== 1280 ||
            sample.canvas.height !== 800
          )
            throw new Error('Incomplete performance sample');
          const deltas = sample.times
            .slice(1)
            .map((t, i) => t - sample.times[i]);
          result.scenes[name] = {
            frames: sample.times.length,
            wallMs: sample.wallMs,
            count: sample.count,
            canvas: sample.canvas,
            workP95: percentile(sample.work, 0.95),
            intervalP95: percentile(deltas, 0.95),
            longFrames33: deltas.filter((t) => t > 33.4).length,
            longFrames50: deltas.filter((t) => t > 50).length,
            maxInterval: Math.max(...deltas),
          };
        }
        if (run >= 0) report.runs[engine].push(result);
        console.log('DONE', mode, engine, run < 0 ? 'warm' : run + 1);
      } finally {
        await context.close();
      }
      await fs.writeFile(out, JSON.stringify(report, null, 2) + '\n');
    }
  report.gates = {};
  for (const name of diagnostic ? ['city'] : ['global', 'city', 'orbit']) {
    const c = report.runs.cesium.map((r) => r.scenes[name]),
      n = report.runs.navara.map((r) => r.scenes[name]);
    const key = mode === 'uncapped' ? 'workP95' : 'intervalP95';
    const native = median(c.map((r) => r[key])),
      navara = median(n.map((r) => r[key]));
    const longNative = median(c.map((r) => r.longFrames33)),
      longNavara = median(n.map((r) => r.longFrames33));
    report.gates[name] = {
      metric: key,
      native,
      navara,
      ratio: navara / native,
      longNative,
      longNavara,
      pass:
        navara / native <= 1.1 &&
        (mode === 'uncapped' || longNavara <= longNative + 2),
    };
  }
} catch (error) {
  report.failure = error.message;
} finally {
  await browser.close();
}
report.pass =
  !diagnostic &&
  !report.failure &&
  report.browserErrors.length === 0 &&
  Object.keys(report.gates ?? {}).length === 3 &&
  Object.values(report.gates).every((g) => g.pass);
await fs.writeFile(out, JSON.stringify(report, null, 2) + '\n');
console.log('RESULT', report.pass, JSON.stringify(report.gates ?? {}));
process.exitCode = report.pass ? 0 : 1;
