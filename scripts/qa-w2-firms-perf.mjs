#!/usr/bin/env node
// W2 static ground-layer cost: a discarded warm-up, then three fresh
// contexts per engine, identical parser-fed populations and camera poses.
import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import puppeteer from 'puppeteer';
import sharp from 'sharp';
import { watchW1Page } from './qa-browserEvidence.mjs';
import { FIRMS_EPOCH_MS as W2_EPOCH_MS } from './fixtures/w2/firms.mjs';
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
const history = process.argv.includes('--diagnostic-close-history');
const diagnostic = history || process.argv.includes('--diagnostic-close');
const overdrawFraction = Number(arg('diagnostic-overdraw') ?? 0);
const drawFraction = Number(arg('diagnostic-draw-fraction') ?? 0);
const compositeControl = process.argv.includes(
  '--diagnostic-composite-control',
);
if (
  ![overdrawFraction, drawFraction].every(
    (fraction) => Number.isFinite(fraction) && fraction >= 0 && fraction < 1,
  )
)
  throw new Error('Diagnostic fractions must be in [0, 1)');
const out = path.resolve(
  arg('out') ?? `qa-artifacts/w2/firms/navara/perf-${mode}.json`,
);
await fs.mkdir(path.dirname(out), { recursive: true });
// Distinct global cells plus a dense SF field: one actual source envelope.
const fires = [];
for (let row = 0; row < 40; row++)
  for (let column = 0; column < 60; column++)
    fires.push({ lat: -20 + row * 2, lon: -170 + column * 2 });
for (let row = 0; row < 60; row++)
  for (let column = 0; column < 60; column++)
    fires.push({
      lat: 37.77 + (row - 29.5) * 0.012,
      lon: -122.42 + (column - 29.5) * 0.012,
    });
fires.forEach((fire, index) =>
  Object.assign(fire, {
    frp: 5 + (index % 120),
    confidence: ['low', 'nominal', 'high'][index % 3],
    brightness: 280 + (index % 90),
    daynight: index % 2 ? 'N' : 'D',
    acqDate: '2026-10-16',
    acqTime: '930',
    instrument: 'VIIRS',
    satellite: 'NOAA-20',
  }),
);
const fixture = { fires, fetchedAt: W2_EPOCH_MS - 120000, stale: false };
const poses = {
  global: [-110, 30, 15000000],
  regional: [-122.42, 37.77, 4000000],
  local: [-122.42, 37.77, 1000000],
  close: [-122.42, 37.77, 100000],
};
const captures = [];

const report = {
  mode,
  look: 'minimal',
  count: 6000,
  terrainFixture: '100m ellipsoid, geoid0; not live terrain accuracy',
  fixtureSha256: crypto
    .createHash('sha256')
    .update(JSON.stringify(fixture))
    .digest('hex'),
  diagnostic,
  diagnosticHistory: history,
  diagnosticOtherPoseMeasureMs: history ? 1000 : null,
  expectedLodByPose: Object.fromEntries(
    Object.entries(poses).map(([name, pose]) => [
      name,
      {
        height: pose[2],
        mode: ['global', 'regional'].includes(name) ? 'cells' : 'detections',
      },
    ]),
  ),
  measuredContextsPerEngine: diagnostic ? 1 : 3,
  warmContextsPerEngine: 1,
  measureMs: 10000,
  warmMs: 8000,
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
            if (url.origin === location.origin && url.pathname === '/api/firms')
              return Promise.resolve(
                new Response(JSON.stringify(fixture), {
                  status: 200,
                  headers: { 'content-type': 'application/json' },
                }),
              );
            if (
              url.origin === location.origin &&
              url.pathname === '/api/openai/hud-summary'
            )
              return Promise.resolve(
                new Response(
                  JSON.stringify({ summary: 'FIRMS performance fixture' }),
                  { headers: { 'content-type': 'application/json' } },
                ),
              );
            if (
              url.origin === location.origin &&
              url.pathname === '/api/terrain/heights'
            )
              return Promise.resolve(
                new Response(
                  JSON.stringify({
                    results: (url.searchParams.get('points') ?? '')
                      .split(';')
                      .filter(Boolean)
                      .map((p) => {
                        const [lon, lat] = p.split(',').map(Number);
                        return {
                          lon,
                          lat,
                          elevation: 100,
                          geoid: 0,
                          ellipsoid: 100,
                        };
                      }),
                  }),
                  { headers: { 'content-type': 'application/json' } },
                ),
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
        const actualEngine = await page.evaluate(
          () => window.__godsEyeView.engine.kind,
        );
        if (actualEngine !== engine)
          throw new Error('Requested performance engine did not boot');
        await page.evaluate(
          () => window.__godsEyeView.styleManager.initialRestorePromise,
        );
        await page.evaluate(
          async ({ epoch, trackMovers, trackOverlay, trackCache }) => {
            const a = window.__godsEyeView;
            a.styleManager.orbitController.stop();
            a.engine.camera.cancelFlight();
            for (const [id] of a.dataManager.layers)
              if (a.dataManager.isEnabled(id)) await a.layers.disable(id);
            (await import('/src/time/clock.js')).appClock.freeze(epoch);
            (await import('/src/data/detection.js')).setMode('OFF');
            if (a.viewer) {
              a.viewer.clock.currentTime =
                a.viewer.clock.currentTime.constructor.fromDate(
                  new Date(epoch),
                );
              a.viewer.targetFrameRate = undefined;
            }
            const canvas = a.engine.host.canvas;
            const style = document.createElement('style');
            style.textContent = '.w2-perf-hidden{visibility:hidden!important}';
            document.head.append(style);
            for (const element of document.body.querySelectorAll('*'))
              if (element !== canvas && !element.contains(canvas))
                element.classList.add('w2-perf-hidden');
            if (trackMovers) {
              const createSet = a.engine.movers.createSet.bind(a.engine.movers);
              a.engine.movers.createSet = (options) => {
                const set = createSet(options);
                if (options.id === 'firms:local-firms')
                  window.__w2FirmsMoverSet = set;
                return set;
              };
            }
            if (trackOverlay)
              globalThis.__gevW2MoverOverlayProbe = (overlay) => {
                window.__w2FirmsOverlay = overlay;
              };
            if (trackCache) {
              window.__w2OverlayCacheStats = {
                hits: 0,
                misses: 0,
                unavailable: 0,
              };
              globalThis.__gevW2OverlayCacheProbe = (hit, cacheable) => {
                const stats = window.__w2OverlayCacheStats;
                if (!cacheable) stats.unavailable++;
                else if (hit) stats.hits++;
                else stats.misses++;
              };
            }
            await a.layers.enable('local-firms');
          },
          {
            epoch: W2_EPOCH_MS,
            trackMovers:
              engine === 'navara' && (overdrawFraction > 0 || drawFraction > 0),
            trackOverlay: engine === 'navara' && compositeControl,
            trackCache: engine === 'navara',
          },
        );
        const result = {
          startupMs: Date.now() - started,
          actualEngine,
          scenes: {},
        };
        for (const [name, pose] of Object.entries(poses)) {
          if (diagnostic && !history && name !== 'close') continue;
          const sample = await page.evaluate(
            async ({
              pose,
              name,
              sampleMs,
              overdrawFraction,
              drawFraction,
              compositeControl,
              trackCache,
            }) => {
              const a = window.__godsEyeView,
                e = a.engine,
                geo = await import('/src/geo/index.js');
              if (trackCache)
                window.__w2OverlayCacheStats = {
                  hits: 0,
                  misses: 0,
                  unavailable: 0,
                };
              await a.layers.enable('local-firms');
              e.camera.setView({
                destination: geo.cartesian3.fromDegrees(...pose),
                orientation: { heading: 0, pitch: -Math.PI / 2, roll: 0 },
              });
              let since = null;
              const started = performance.now();
              while (performance.now() - started < 90000) {
                if (
                  e.surface.tilesLoaded() &&
                  a.dataManager.layers.get('local-firms').module.getStats()
                    .cells > 0
                )
                  since ??= performance.now();
                else since = null;
                if (since !== null && performance.now() - since > 1500) break;
                e.render.request('w2-perf-settle');
                await new Promise((r) => setTimeout(r, 100));
              }
              if (
                !e.surface.tilesLoaded() ||
                !since ||
                performance.now() - since <= 1500
              )
                throw new Error('Tiles did not settle');
              if (
                a.dataManager.layers.get('local-firms').module.getStats()
                  .count !== 6000
              )
                throw new Error('Performance population is not 6000');
              if (Math.abs(e.camera.height() - pose[2]) > 2)
                throw new Error('Performance camera pose differs');
              e.render.setContinuous(true);
              await new Promise((r) => setTimeout(r, 8000));
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
                await new Promise((r) => setTimeout(r, sampleMs));
                let overdrawControl = null;
                if (overdrawFraction > 0) {
                  const set = window.__w2FirmsMoverSet;
                  if (!set || set.count() !== 3000)
                    throw new Error('Diagnostic mover set is unavailable');
                  const hiddenFrom = Math.floor(
                    set.count() * (1 - overdrawFraction),
                  );
                  for (let i = hiddenFrom; i < set.count(); i++)
                    set.set(i, { show: false });
                  set.commit();
                  await new Promise((r) => setTimeout(r, 1000));
                  const controlWork = [];
                  let controlStart = null;
                  const stopControlPre = e.frames.preRender.addEventListener(
                    () => {
                      controlStart = performance.now();
                    },
                  );
                  const stopControlPost = e.frames.postRender.addEventListener(
                    () => {
                      if (controlStart !== null)
                        controlWork.push(performance.now() - controlStart);
                      controlStart = null;
                    },
                  );
                  await new Promise((r) => setTimeout(r, 5000));
                  stopControlPre();
                  stopControlPost();
                  const orderedWork = [...controlWork].sort((a, b) => a - b);
                  overdrawControl = {
                    setCount: set.count(),
                    renderedVisibleCount: hiddenFrom,
                    frames: controlWork.length,
                    workP95:
                      orderedWork[Math.floor(orderedWork.length * 0.95)] ??
                      null,
                  };
                  for (let i = hiddenFrom; i < set.count(); i++)
                    set.set(i, { show: true });
                  set.commit();
                }
                let drawCountControl = null;
                if (drawFraction > 0) {
                  const set = window.__w2FirmsMoverSet;
                  if (!set || set.count() !== 3000)
                    throw new Error('Diagnostic mover set is unavailable');
                  const drawCount = Math.max(
                    1,
                    Math.floor(set.count() * drawFraction),
                  );
                  if (drawCount === 1) set.set(0, { show: false });
                  set.setCount(drawCount);
                  set.commit();
                  await new Promise((r) => setTimeout(r, 1000));
                  const controlWork = [];
                  let controlStart = null;
                  const stopControlPre = e.frames.preRender.addEventListener(
                    () => {
                      controlStart = performance.now();
                    },
                  );
                  const stopControlPost = e.frames.postRender.addEventListener(
                    () => {
                      if (controlStart !== null)
                        controlWork.push(performance.now() - controlStart);
                      controlStart = null;
                    },
                  );
                  await new Promise((r) => setTimeout(r, 5000));
                  stopControlPre();
                  stopControlPost();
                  const orderedWork = [...controlWork].sort((a, b) => a - b);
                  drawCountControl = {
                    drawCount,
                    frames: controlWork.length,
                    workP95:
                      orderedWork[Math.floor(orderedWork.length * 0.95)] ??
                      null,
                  };
                  if (drawCount === 1) set.set(0, { show: true });
                  set.setCount(3000);
                  set.commit();
                }
                let compositeControlResult = null;
                if (compositeControl) {
                  const overlay = window.__w2FirmsOverlay;
                  if (!overlay)
                    throw new Error('Diagnostic overlay is unavailable');
                  overlay.displayBlend = false;
                  await new Promise((r) => setTimeout(r, 1000));
                  const controlWork = [];
                  let controlStart = null;
                  const stopControlPre = e.frames.preRender.addEventListener(
                    () => {
                      controlStart = performance.now();
                    },
                  );
                  const stopControlPost = e.frames.postRender.addEventListener(
                    () => {
                      if (controlStart !== null)
                        controlWork.push(performance.now() - controlStart);
                      controlStart = null;
                    },
                  );
                  await new Promise((r) => setTimeout(r, 5000));
                  stopControlPre();
                  stopControlPost();
                  const orderedWork = [...controlWork].sort((a, b) => a - b);
                  compositeControlResult = {
                    frames: controlWork.length,
                    workP95:
                      orderedWork[Math.floor(orderedWork.length * 0.95)] ??
                      null,
                  };
                  overlay.displayBlend = true;
                }
                return {
                  wallMs: performance.now() - measuredFrom,
                  times,
                  work,
                  count: a.dataManager.layers
                    .get('local-firms')
                    .module.getStats().count,
                  stats: a.dataManager.layers
                    .get('local-firms')
                    .module.getStats(),
                  cameraHeight: e.camera.height(),
                  renderedRecordCount: a.dataManager.layers
                    .get('local-firms')
                    .module.getAnalystRecords(6001).length,
                  moverSets: e.movers
                    .list()
                    .map(({ id, kind, count }) => ({ id, kind, count })),
                  overdrawControl,
                  drawCountControl,
                  compositeControl: compositeControlResult,
                  overlayCacheStats: window.__w2OverlayCacheStats ?? null,
                  nativeRectangles:
                    a.viewer?.dataSources
                      .getByName('local-firms')
                      .flatMap((source) =>
                        source.entities.values.filter(
                          (entity) => entity.rectangle,
                        ),
                      ).length ?? null,
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
            },
            {
              pose,
              name,
              sampleMs: history && name !== 'close' ? 1000 : 10000,
              overdrawFraction:
                engine === 'navara' && name === 'close' ? overdrawFraction : 0,
              drawFraction:
                engine === 'navara' && name === 'close' ? drawFraction : 0,
              compositeControl:
                engine === 'navara' && name === 'close'
                  ? compositeControl
                  : false,
              trackCache: engine === 'navara',
            },
          );
          if (
            sample.times.length < (history && name !== 'close' ? 1 : 50) ||
            sample.work.length !== sample.times.length ||
            sample.count !== 6000 ||
            sample.stats.lastUpdate !== W2_EPOCH_MS - 120000 ||
            sample.stats.loading ||
            sample.stats.error ||
            sample.renderedRecordCount !== 6000 ||
            sample.epochMs !== W2_EPOCH_MS ||
            sample.canvas.width !== 1280 ||
            sample.canvas.height !== 800
          )
            throw new Error('Incomplete performance sample');
          // Capture outside timed windows. Analyze pixels only after Chromium closes.
          const imageBase = `${out}.${engine}-${run < 0 ? 'warm' : run + 1}-${name}`;
          await page.evaluate(() =>
            window.__godsEyeView.engine.render.request('w2-perf-on'),
          );
          await new Promise((r) => setTimeout(r, 200));
          const on = imageBase + '-on.png',
            off = imageBase + '-off.png';
          await page.screenshot({ path: on });
          await page.evaluate(async () => {
            const a = window.__godsEyeView;
            await a.layers.disable('local-firms');
            a.engine.render.request('w2-perf-off');
          });
          await new Promise((r) => setTimeout(r, 400));
          await page.screenshot({ path: off });
          captures.push({ engine, run, name, on, off });
          const deltas = sample.times
            .slice(1)
            .map((t, i) => t - sample.times[i]);
          result.scenes[name] = {
            frames: sample.times.length,
            wallMs: sample.wallMs,
            count: sample.count,
            stats: sample.stats,
            cameraHeight: sample.cameraHeight,
            renderedRecordCount: sample.renderedRecordCount,
            moverSets: sample.moverSets,
            overdrawControl: sample.overdrawControl,
            drawCountControl: sample.drawCountControl,
            compositeControl: sample.compositeControl,
            overlayCacheStats: sample.overlayCacheStats,
            nativeRectangles: sample.nativeRectangles,
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
  for (const name of diagnostic ? ['close'] : Object.keys(poses)) {
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
report.paintControls = [];
for (const capture of captures) {
  const images = await Promise.all(
    [capture.on, capture.off].map((file) =>
      sharp(file)
        .extract({ left: 250, top: 150, width: 780, height: 500 })
        .removeAlpha()
        .raw()
        .toBuffer(),
    ),
  );
  let changedPixels = 0,
    maxDelta = 0;
  for (let i = 0; i < images[0].length; i += 3) {
    const delta = Math.max(
      ...[0, 1, 2].map((k) => Math.abs(images[0][i + k] - images[1][i + k])),
    );
    maxDelta = Math.max(maxDelta, delta);
    if (delta > 3) changedPixels++;
  }
  report.paintControls.push({
    ...capture,
    changedPixels,
    maxDelta,
    pass: changedPixels >= 100 && maxDelta >= 16,
  });
}
report.populationsMatch = (
  diagnostic && !history ? ['close'] : Object.keys(poses)
).every((name) => {
  const rows = ['cesium', 'navara'].flatMap((engine) =>
    report.runs[engine].map((run) => run.scenes[name]?.stats),
  );
  return (
    rows.length === (diagnostic ? 2 : 6) &&
    rows.every(
      (stats) =>
        stats?.count === 6000 &&
        stats.cells === rows[0].cells &&
        stats.cells > 0,
    )
  );
});
report.pass =
  !diagnostic &&
  !report.failure &&
  report.browserErrors.length === 0 &&
  Object.keys(report.gates ?? {}).length === 4 &&
  report.paintControls.length === 32 &&
  report.paintControls.every((c) => c.pass) &&
  report.populationsMatch &&
  Object.values(report.gates).every((g) => g.pass);
await fs.writeFile(out, JSON.stringify(report, null, 2) + '\n');
console.log('RESULT', report.pass, JSON.stringify(report.gates ?? {}));
process.exitCode = report.pass ? 0 : 1;
