import fs from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import os from 'node:os';
import puppeteer from 'puppeteer';
import { blockPaidQaMaps } from './qa-map-policy.mjs';
import { installTileCache } from './qa/tileCache.mjs';
import { watchW1Page } from './qa-browserEvidence.mjs';
import {
  combinedPayloads,
  COMBINED_EPOCH,
  COMBINED_ORIGIN,
  installCombinedFixture,
} from './fixtures/w2/combined.mjs';

const arg = (name) =>
  process.argv.find((s) => s.startsWith(`--${name}=`))?.slice(name.length + 3);
const base = arg('base-url'),
  output = arg('out'),
  mode = arg('mode') || 'uncapped';
const diagnostic = process.argv.includes('--diagnostic');
const baselineSampling = process.argv.includes('--baseline-sampling');
const baselineStencil = process.argv.includes('--baseline-stencil');
const stencilPairs = process.argv.includes('--stencil-pairs');
const baselineEmptyRenders = process.argv.includes('--baseline-empty-renders');
const emptyRenderPairs = process.argv.includes('--empty-render-pairs');
const paired = stencilPairs || emptyRenderPairs;
if (
  [
    baselineSampling,
    baselineStencil,
    stencilPairs,
    baselineEmptyRenders,
    emptyRenderPairs,
  ].filter(Boolean).length > 1
)
  throw new Error('Choose one baseline override');
const denseQuakes = process.argv.includes('--dense-quakes');
const look = arg('look') || 'minimal';
if (!['minimal', 'cinematic'].includes(look)) throw new Error('Unknown look');
if (
  !base ||
  !output ||
  ['4173', '4185', '4186', '4187', '4188', '4189', '4194'].includes(
    new URL(base).port,
  )
)
  throw new Error('Explicit nonreserved --base-url and --out required');
if (!['paced', 'uncapped'].includes(mode))
  throw new Error('Unknown measurement mode');
const engines = (arg('engines') || 'cesium,navara').split(',');
if (engines.some((e) => !['cesium', 'navara'].includes(e)))
  throw new Error('Unknown engine');
const scenarios = (
  arg('scenarios') ||
  'empty,firms,alpr,cctv,imagery,transit800,transit3000,combined'
).split(',');
const all = [
  'earthquakes',
  'local-firms',
  'military-installations',
  'bikeshare',
  'radio',
  'alpr-cameras',
  'cctv',
  'transit',
  'recent-imagery',
];
const sets = {
  empty: [],
  installations: ['military-installations'],
  firms: ['local-firms'],
  alpr: ['alpr-cameras'],
  cctv: ['cctv'],
  imagery: ['recent-imagery'],
  transit800: ['transit'],
  transit3000: ['transit'],
  combined: all,
};
const expectedCounts = {
  earthquakes: 500,
  'local-firms': 6000,
  'military-installations': 20,
  bikeshare: 200,
  radio: 750,
  'alpr-cameras': 325,
  cctv: 25,
  'recent-imagery': 2,
};
if (scenarios.some((s) => !sets[s])) throw new Error('Unknown scenario');
const report = {
  mode,
  look,
  diagnostic,
  baselineSampling,
  baselineStencil,
  stencilPairs,
  baselineEmptyRenders,
  emptyRenderPairs,
  denseQuakes,
  workload: denseQuakes
    ? '500 co-located earthquake discs: pathological overlap stress'
    : '500 worldwide earthquakes, five near the Boston camera; dense local W2 catalog fixtures',
  head: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(),
  trackedDiffSha256: createHash('sha256')
    .update(execFileSync('git', ['diff', 'HEAD']))
    .digest('hex'),
  host: {
    cpu: os.cpus()[0].model,
    cores: os.cpus().length,
    platform: os.platform(),
    arch: os.arch(),
  },
  base,
  scenarios,
  fixtureSha256: createHash('sha256')
    .update(JSON.stringify(combinedPayloads))
    .digest('hex'),
  fixtureSourceSha256: createHash('sha256')
    .update(
      await fs.readFile(new URL('./fixtures/w2/combined.mjs', import.meta.url)),
    )
    .digest('hex'),
  driverSha256: createHash('sha256')
    .update(await fs.readFile(new URL(import.meta.url)))
    .digest('hex'),
  measurement:
    'preRender listener installed before W2 enable to postRender listener after W2 setup; CPU/submission, not GPU timer',
  warmMs: diagnostic ? 1000 : 3000,
  measureMs: diagnostic ? 1000 : 10000,
  runs: [],
  browserErrors: [],
};
if (process.argv.includes('--preview')) {
  const local = await fs.readFile('qa-artifacts/w1-preview/index.html'),
    served = Buffer.from(await (await fetch(base)).arrayBuffer());
  if (!local.equals(served))
    throw new Error('Preview does not serve the expected local QA build');
  report.previewManifestSha256 = createHash('sha256')
    .update(await fs.readFile('qa-artifacts/w1-preview/.vite/manifest.json'))
    .digest('hex');
}
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const percentile = (values, p) => {
  const s = [...values].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor(s.length * p))] ?? null;
};
const browser = await puppeteer.launch({
  headless: true,
  protocolTimeout: 180000,
  args: [
    '--no-sandbox',
    '--use-angle=metal',
    '--enable-gpu',
    '--disable-background-timer-throttling',
    '--disable-renderer-backgrounding',
    ...(mode === 'uncapped'
      ? ['--disable-gpu-vsync', '--disable-frame-rate-limit']
      : []),
  ],
});
try {
  report.browser = await browser.version();
  for (let run = diagnostic ? 0 : -1; run < (diagnostic ? 1 : 3); run++)
    for (const { kind, original } of engines.flatMap((kind) =>
      paired && kind === 'navara'
        ? (run % 2 === 1 ? [false, true] : [true, false]).map((original) => ({
            kind,
            original,
          }))
        : [{ kind, original: baselineStencil || baselineEmptyRenders }],
    )) {
      const stencilOriginal = original && (baselineStencil || stencilPairs);
      const emptyOriginal =
        original && (baselineEmptyRenders || emptyRenderPairs);
      const context = await browser.createBrowserContext(),
        entry = {
          engine: paired && original ? 'navara-original' : kind,
          baselineStencil: kind === 'navara' && stencilOriginal,
          baselineEmptyRenders: kind === 'navara' && emptyOriginal,
          run,
          discarded: run < 0,
          scenes: {},
        };
      report.runs.push(entry);
      try {
        const page = await context.newPage();
        await page.setViewport({
          width: 1280,
          height: 800,
          deviceScaleFactor: 1,
        });
        await blockPaidQaMaps(page);
        const tileCache = await installTileCache(page);
        const fixture = await installCombinedFixture(page, { denseQuakes });
        watchW1Page(page, report, {
          name: `${entry.engine}-${run}`,
          baseUrl: base,
          preview: process.argv.includes('--preview'),
        });
        await page.evaluateOnNewDocument(() =>
          localStorage.setItem('gev:first-run-mission:v1', 'suppressed'),
        );
        if (baselineSampling)
          await page.evaluateOnNewDocument(() => {
            window.__gevW2NativeProbe = ({ view }) => {
              const add = view.addEffect.bind(view);
              view.addEffect = (config) => {
                if (config.gevPostSampling) {
                  window.__qaBaselineSampling = true;
                  return { delete() {} };
                }
                return add(config);
              };
            };
          });
        if (stencilOriginal)
          await page.evaluateOnNewDocument(() => {
            window.__gevW2NativeProbe = ({ view }) => {
              const register = view.registerEffect.bind(view);
              view.registerEffect = (key, Class) =>
                register(
                  key,
                  key === 'gevInstallationsDrape'
                    ? class extends Class {
                        constructor(...args) {
                          super(...args);
                          window.__qaStencilOwner = this.owner;
                        }
                      }
                    : Class,
                );
            };
          });
        if (emptyOriginal)
          await page.evaluateOnNewDocument(() => {
            window.__gevW2NativeProbe = ({ view }) => {
              const register = view.registerEffect.bind(view);
              view.registerEffect = (key, Class) =>
                register(
                  key,
                  key === 'gevPostSampling'
                    ? class extends Class {
                        constructor(...args) {
                          super(...args);
                          window.__qaEmptyContext = args[1];
                        }
                      }
                    : Class,
                );
            };
          });
        const target = new URL(base);
        target.searchParams.set('engine', kind);
        target.searchParams.set('look', look);
        target.searchParams.set('welcome', '0');
        target.hash =
          'lat=42.3554&lon=-71.0605&alt=6000&heading=0&pitch=-90&map=osm';
        const started = Date.now();
        await page.goto(target.href, { waitUntil: 'domcontentloaded' });
        await page.waitForFunction(
          () =>
            window.__godsEyeView?.engine &&
            document
              .getElementById('loading-screen')
              ?.classList.contains('hidden'),
          { timeout: 90000 },
        );
        if (
          !(await page.evaluate(
            () =>
              !window.__GOOGLE_MAPS_API_KEY__ &&
              !window.__godsEyeView.tileset &&
              !window.__godsEyeView.mapStackController.isStackAvailable(
                'photoreal',
              ),
          ))
        )
          throw new Error('Comparison requires a keyless build');
        if (
          baselineSampling &&
          kind === 'navara' &&
          !(await page.evaluate(() => window.__qaBaselineSampling === true))
        )
          throw new Error('Baseline sampling override did not run');
        await page.evaluate(async (epoch) => {
          const a = window.__godsEyeView;
          await a.styleManager.initialRestorePromise;
          a.styleManager.orbitController.stop();
          a.engine.camera.cancelFlight();
          a.styleManager._setDetectionMode('OFF');
          for (const [id, row] of a.dataManager.layers)
            if (row.enabled) await a.dataManager.setEnabled(id, false);
          (await import('/src/time/clock.js')).appClock.freeze(epoch);
          if (a.viewer) {
            a.viewer.targetFrameRate = undefined;
            a.viewer.clock.shouldAnimate = false;
          }
          window.__w2Perf = { armed: false, start: null };
          a.engine.frames.preRender.addEventListener(() => {
            if (window.__w2Perf.armed)
              window.__w2Perf.start = performance.now();
          });
        }, COMBINED_EPOCH);
        await page.waitForFunction(
          () => window.__godsEyeView.engine.surface.tilesLoaded(),
          { timeout: 90000 },
        );
        entry.startupMs = Date.now() - started;
        for (const name of scenarios) {
          console.log(`START ${entry.engine} ${run} ${name}`);
          const count = name === 'transit3000' ? 3000 : 800;
          await page.evaluate(
            async ({ ids, origin, count, name }) => {
              const a = window.__godsEyeView,
                geo = await import('/src/geo/index.js');
              for (const [id, row] of a.dataManager.layers)
                if (row.enabled) await a.dataManager.setEnabled(id, false);
              a.engine.camera.setView({
                destination: geo.cartesian3.fromDegrees(
                  origin.lon,
                  origin.lat,
                  name === 'transit3000' ? 30000 : 6000,
                ),
                orientation: { heading: 0, pitch: -Math.PI / 2, roll: 0 },
              });
              for (const id of ids) await a.dataManager.setEnabled(id, true);
              if (ids.includes('cctv'))
                a.dataManager.layers
                  .get('cctv')
                  .module.setParams({ coverageMode: 'viewshed' });
              if (ids.includes('recent-imagery'))
                window.__gevRecentImagery.layer.setBox({
                  west: origin.lon - 0.02,
                  east: origin.lon + 0.02,
                  south: origin.lat - 0.015,
                  north: origin.lat + 0.015,
                });
            },
            { ids: sets[name], origin: COMBINED_ORIGIN, count, name },
          );
          await page
            .waitForFunction(
              (ids) =>
                ids.every((id) => {
                  const l =
                      window.__godsEyeView.dataManager.layers.get(id).module,
                    s = l.getStats?.() || {};
                  return (
                    !s.loading &&
                    !s.searching &&
                    (id === 'transit' ||
                      id === 'recent-imagery' ||
                      Number(s.count) > 0)
                  );
                }),
              { timeout: diagnostic ? 15000 : 60000 },
              sets[name],
            )
            .catch(async (error) => {
              entry.pending = await page.evaluate(
                (ids) =>
                  Object.fromEntries(
                    ids.map((id) => [
                      id,
                      window.__godsEyeView.dataManager.layers
                        .get(id)
                        .module.getStats?.(),
                    ]),
                  ),
                sets[name],
              );
              throw error;
            });
          if (sets[name].includes('recent-imagery')) {
            await page.waitForFunction(
              () =>
                window.__gevRecentImagery.layer
                  .getSnapshot()
                  .candidates.filter(
                    (c) =>
                      c.product === 'S30' && c.thumbnail?.status === 'present',
                  ).length >= 2,
              { timeout: 30000 },
            );
            await page.evaluate(() => {
              const l = window.__gevRecentImagery.layer,
                c = l
                  .getSnapshot()
                  .candidates.filter((c) => c.product === 'S30');
              l.setAssignment('a', c[0].key);
              l.setAssignment('b', c[1].key);
              l.setMode('ab');
            });
          }
          await page.waitForFunction(
            () => window.__godsEyeView.engine.surface.tilesLoaded(),
            { timeout: 90000 },
          );
          await sleep(2000);
          if (sets[name].includes('transit'))
            await page.evaluate(
              ({ count, origin }) =>
                window.__godsEyeView.dataManager.layers
                  .get('transit')
                  .module._loadTransitFleetForTest(
                    count,
                    origin,
                    count === 800 ? 5 : 120,
                  ),
              { count, origin: COMBINED_ORIGIN },
            );
          if (
            stencilOriginal &&
            kind === 'navara' &&
            sets[name].includes('military-installations')
          )
            entry.baselineStencilMeshes = await page.evaluate(() => {
              const meshes = [...(window.__qaStencilOwner?.meshes ?? [])];
              if (!meshes.length)
                throw new Error('Stencil baseline found no meshes');
              for (const mesh of meshes) {
                const original = Object.getPrototypeOf(mesh).process;
                if (typeof original !== 'function')
                  throw new Error('Native stencil process absent');
                mesh.process = original;
              }
              return meshes.length;
            });
          if (emptyOriginal && kind === 'navara')
            entry.baselineEmptyScenes = await page.evaluate(() => {
              const scenes = window.__qaEmptyContext?.scenes;
              if (!scenes?.mrt || !scenes.opaque)
                throw new Error('Missing empty-scene control');
              // A no-op callback invokes the conservative original-render path.
              for (const scene of [scenes.mrt, scenes.opaque])
                scene.onBeforeRender = () => {};
              return 2;
            });
          const cdp = await page.createCDPSession();
          await cdp.send('HeapProfiler.collectGarbage');
          const before = await cdp.send('Runtime.getHeapUsage');
          const sample = await page.evaluate(
            async ({ ids, warmMs, measureMs }) => {
              const a = window.__godsEyeView,
                e = a.engine,
                probe = window.__w2Perf;
              const governor = await import('/src/renderGovernor.js');
              governor.holdContinuousRender('qa-w2-comparison');
              await new Promise((r) => setTimeout(r, warmMs));
              const times = [],
                work = [];
              probe.armed = true;
              const off = e.frames.postRender.addEventListener(() => {
                const now = performance.now();
                times.push(now);
                if (probe.start !== null) work.push(now - probe.start);
                probe.start = null;
              });
              try {
                await new Promise((r) => setTimeout(r, measureMs));
                return {
                  times,
                  work,
                  counts: Object.fromEntries(
                    ids.map((id) => {
                      const l = a.dataManager.layers.get(id).module;
                      return [
                        id,
                        id === 'recent-imagery'
                          ? l.diagnostics().ownedCount
                          : id === 'transit'
                            ? l._transitStateForTest()._vehicles.size
                            : l.getStats().count,
                      ];
                    }),
                  ),
                  stats: Object.fromEntries(
                    ids.map((id) => [
                      id,
                      a.dataManager.layers.get(id).module.getStats?.(),
                    ]),
                  ),
                  canvas: {
                    width: e.host.canvas.width,
                    height: e.host.canvas.height,
                    dpr: devicePixelRatio,
                  },
                  moverStats: e.movers.diagnostics?.(),
                  transit: ids.includes('transit')
                    ? a.dataManager.layers
                        .get('transit')
                        .module._transitVisibilityForTest()
                        .reduce(
                          (sum, v) => ({
                            count: sum.count + 1,
                            shown: sum.shown + Number(v.shown),
                            moving: sum.moving + Number(v.moving),
                          }),
                          { count: 0, shown: 0, moving: 0 },
                        )
                    : null,
                  imagery: ids.includes('recent-imagery')
                    ? window.__gevRecentImagery.layer.diagnostics()
                    : null,
                };
              } finally {
                probe.armed = false;
                off();
                governor.releaseContinuousRender('qa-w2-comparison');
              }
            },
            {
              ids: sets[name],
              warmMs: report.warmMs,
              measureMs: report.measureMs,
            },
          );
          await cdp.send('HeapProfiler.collectGarbage');
          const after = await cdp.send('Runtime.getHeapUsage');
          await cdp.detach();
          entry.lastSample = sample;
          if (
            sample.times.length < (diagnostic ? 3 : 20) ||
            sample.work.length !== sample.times.length
          )
            throw new Error(
              `Incomplete frame sample: ${sample.times.length} frames / ${sample.work.length} work samples`,
            );
          if (
            sample.canvas.width !== 1280 ||
            sample.canvas.height !== 800 ||
            sample.canvas.dpr !== 1
          )
            throw new Error('Canvas changed');
          for (const id of sets[name]) {
            const expected = id === 'transit' ? count : expectedCounts[id];
            if (sample.counts[id] !== expected)
              throw new Error(
                `${id} population changed: ${sample.counts[id]} != ${expected}`,
              );
          }
          if (
            sample.transit &&
            (sample.transit.shown !== count || sample.transit.moving !== count)
          )
            throw new Error('Fixture vehicles stopped being visible or moving');
          const intervals = sample.times
            .slice(1)
            .map((t, i) => t - sample.times[i]);
          const { times, work, ...state } = sample;
          entry.scenes[name] = {
            ...state,
            frames: times.length,
            workP50: percentile(work, 0.5),
            workP95: percentile(work, 0.95),
            intervalP50: percentile(intervals, 0.5),
            intervalP95: percentile(intervals, 0.95),
            longFrames33: intervals.filter((t) => t > 33.4).length,
            longFrames50: intervals.filter((t) => t > 50).length,
            heapBefore: before.usedSize,
            heapAfter: after.usedSize,
          };
          delete entry.lastSample;
          await page.screenshot({
            path: output.replace(
              /\.json$/,
              `-${entry.engine}-${run}-${name}.png`,
            ),
          });
          await fs.writeFile(output, JSON.stringify(report, null, 2));
          console.log(
            `DONE ${entry.engine} ${run} ${name} ${entry.scenes[name].workP95.toFixed(2)}ms`,
          );
        }
        entry.requests = fixture.requests.length;
        entry.tileCache = { ...tileCache };
        await fixture.dispose();
      } catch (error) {
        entry.error = error.stack;
        throw error;
      } finally {
        await context.close();
      }
    }
  report.comparison = {};
  if (engines.length === 2)
    for (const name of scenarios) {
      const summary = (kind) => {
        const rows = report.runs
          .filter((r) => !r.discarded && r.engine === kind)
          .map((r) => r.scenes[name]);
        return {
          workP95: percentile(
            rows.map((r) => r.workP95),
            0.5,
          ),
          intervalP95: percentile(
            rows.map((r) => r.intervalP95),
            0.5,
          ),
          longFrames33: percentile(
            rows.map((r) => r.longFrames33),
            0.5,
          ),
          counts: rows[0].counts,
        };
      };
      const c = summary('cesium'),
        n = summary('navara'),
        metric = mode === 'uncapped' ? 'workP95' : 'intervalP95';
      const ratio = n[metric] / c[metric],
        sameCounts = JSON.stringify(c.counts) === JSON.stringify(n.counts);
      report.comparison[name] = {
        cesium: c,
        navara: n,
        ratio,
        sameCounts,
        pass:
          sameCounts &&
          ratio <= 1.1 &&
          (mode === 'uncapped' || n.longFrames33 <= c.longFrames33 + 2),
      };
      if (paired && engines.includes('navara'))
        report.comparison[name].originalNavara = summary('navara-original');
    }
} catch (error) {
  report.failure = error.stack;
  process.exitCode = 1;
} finally {
  await browser.close();
  await fs.writeFile(output, JSON.stringify(report, null, 2));
}
if (
  report.browserErrors.length ||
  Object.values(report.comparison || {}).some((r) => !r.pass)
)
  process.exitCode = 1;
