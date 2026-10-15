#!/usr/bin/env node
/**
 * qa-weather-perf — matched-route throughput and idle-work measurement for the
 * Weather layers (Wind, Rain radar, Satellite clouds, Lightning density).
 *
 * This is a measurement harness, not a pass/fail gate. It reproduces one fixed
 * camera route per weather state so two builds (or two basemaps) can be
 * compared on the same numbers:
 *
 *   park 10 km over Austin → 3 s flight to 1.2 km (heading 20°, pitch −45°)
 *   → 6 s close idle → 8 s orbit at 1.8 km range → 3 s flight back to the
 *   17,368 km globe view → 6 s globe idle.
 *
 * Route windows hold render demand constant (`scene.requestRender()` on every
 * animation frame) so the idle-render governor cannot masquerade as low FPS.
 * FPS counts `scene.postRender` fires, and every window asserts the canvas
 * size did not change, because a stopped renderer with a free-running rAF
 * reads as a clean 60 fps otherwise.
 *
 * The separate idle test restores the normal governor, parks the camera at
 * the 1.2 km pose with Wind off, and counts scene redraws, DOM mutations
 * inside `.weather-summary`, and `.weather-summary` height changes over
 * 8-second windows for: weather off, history paused, history playing.
 *
 * Usage:
 *   node scripts/qa-weather-perf.mjs [--url http://localhost:4173]
 *     [--label google-baseline] [--states off,wind,...] [--repeat 1]
 *     [--headless] [--no-route] [--no-idle] [--out qa-shots/weather-perf]
 *
 * States: off · history-paused · history-playing · wind · wind+history-paused
 * · wind+history-playing. "history" is radar + regional clouds + lightning
 * together; "wind" is animated GFS wind with the Speed field selected.
 * Requires a running dev server. Screenshots and results.json land in
 * <out>/<label>/.
 */
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import puppeteer from 'puppeteer';

const argv = process.argv.slice(2);
const arg = (name, fallback) => {
  const i = argv.indexOf(name);
  return i >= 0 && argv[i + 1] !== undefined && !argv[i + 1].startsWith('--')
    ? argv[i + 1]
    : fallback;
};
const flag = (name) => argv.includes(name);

const rawUrl = arg('--url', 'http://localhost:4173');
// The first-launch chooser would otherwise sit over the globe; `?welcome=0`
// is the app's own suppression flag (src/firstRunExperience.js).
const url = rawUrl.includes('welcome=')
  ? rawUrl
  : `${rawUrl}${rawUrl.includes('?') ? '&' : '?'}welcome=0`;
const label = arg(
  '--label',
  new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-'),
);
const ALL_STATES = [
  'off',
  'history-paused',
  'history-playing',
  'wind',
  'wind+history-paused',
  'wind+history-playing',
];
const states = arg('--states', ALL_STATES.join(','))
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);
for (const s of states)
  if (!ALL_STATES.includes(s)) {
    console.error(`unknown state "${s}"; choose from ${ALL_STATES.join(', ')}`);
    process.exit(2);
  }
const repeat = Math.max(1, Number(arg('--repeat', '1')) || 1);
// `--scale 2` renders at 2× resolutionScale (4× the pixels) so a GPU that idles
// at 60 fps natively still exposes per-frame cost differences.
const scale = Number(arg('--scale', '1')) || 1;
const outDir = path.resolve(arg('--out', 'qa-shots/weather-perf'), label);
mkdirSync(outDir, { recursive: true });

const WEATHER = ['weather-radar', 'weather-satellite', 'weather-lightning'];
const AUSTIN = { lon: -97.7431, lat: 30.2672 };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const chromePath =
  process.env.PUPPETEER_EXECUTABLE_PATH ||
  ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'].find((p) =>
    existsSync(p),
  );

const browser = await puppeteer.launch({
  headless: flag('--headless') ? 'new' : false,
  executablePath: chromePath,
  protocolTimeout: 300_000,
  defaultViewport: null,
  args: [
    '--no-sandbox',
    '--disable-setuid-sandbox',
    '--window-size=1200,960',
    '--disable-backgrounding-occluded-windows',
    '--disable-renderer-backgrounding',
    '--disable-background-timer-throttling',
  ],
});

const results = [];
let reportFailures = null;
const record = (row) => {
  results.push(row);
  reportFailures?.();
  const {
    phase,
    state,
    run,
    window: win,
    fps,
    p95,
    longTasks,
    mutations,
    heightChanges,
    canvasStable,
  } = row;
  console.log(
    `  ${phase.padEnd(5)} ${state.padEnd(22)} r${run} ${win.padEnd(12)} ` +
      `fps=${String(fps).padStart(5)} p95=${String(p95).padStart(6)}ms ` +
      `long=${String(longTasks).padStart(2)} dom=${String(mutations).padStart(4)} ` +
      `h∆=${String(heightChanges).padStart(2)}${canvasStable ? '' : ' CANVAS CHANGED'}`,
  );
};

try {
  const page = await browser.newPage();
  await page.setViewport({ width: 1200, height: 886, deviceScaleFactor: 2 });
  page.on('pageerror', (e) => console.log('  [pageerror]', e.message));
  // Non-2xx responses, counted per path so a burst of throttled tiles reads
  // as one line instead of one console error per tile.
  const failures = new Map();
  page.on('response', (r) => {
    const status = r.status();
    if (status < 400) return;
    const key = `${status} ${new URL(r.url()).pathname}`;
    failures.set(key, (failures.get(key) || 0) + 1);
  });
  reportFailures = () => {
    if (!failures.size) return;
    console.log(
      '  [http failures] ' +
        [...failures].map(([k, n]) => `${k} ×${n}`).join(' · '),
    );
    failures.clear();
  };
  await page.goto(url, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => !!window.__godsEyeView?.viewer, {
    timeout: 120_000,
  });
  await sleep(15_000);

  if (scale !== 1)
    await page.evaluate((scale) => {
      window.__godsEyeView.viewer.resolutionScale = scale;
      window.__godsEyeView.viewer.scene.requestRender();
    }, scale);
  const env = await page.evaluate(() => {
    const gev = window.__godsEyeView;
    const scene = gev.viewer.scene;
    return {
      basemap: gev.tileset ? 'google-3d' : 'keyless-globe',
      globeShown: scene.globe.show,
      canvas: `${scene.canvas.width}x${scene.canvas.height}`,
      dpr: devicePixelRatio,
      ua:
        navigator.userAgent.match(/Chrome\/[\d.]+/)?.[0] || navigator.userAgent,
      msaa: scene.msaaSamples,
      resolutionScale: gev.viewer.resolutionScale,
    };
  });
  console.log(`\nqa-weather-perf · ${label}\n  url=${url}`);
  console.log(`  ${JSON.stringify(env)}`);

  // Park deterministically, disable every layer, and instrument once.
  await page.evaluate(async () => {
    const gev = window.__godsEyeView;
    const v = gev.viewer;
    v.camera.cancelFlight();
    for (const [id, entry] of gev.dataManager.layers)
      if (entry.enabled) {
        try {
          await gev.dataManager.setEnabled(id, false, { origin: 'user' });
        } catch {
          /* counted through the layer, not here */
        }
      }
    const P = (window.__gevWeatherPerf = {
      renders: 0,
      longTasks: 0,
      longTaskMs: 0,
      mutations: 0,
    });
    v.scene.postRender.addEventListener(() => {
      P.renders += 1;
    });
    try {
      new PerformanceObserver((list) => {
        for (const entry of list.getEntries()) {
          P.longTasks += 1;
          P.longTaskMs += entry.duration;
        }
      }).observe({ type: 'longtask', buffered: false });
    } catch {
      /* longtask unsupported → stays 0 */
    }
    const summary = document.querySelector('.weather-summary');
    if (summary)
      new MutationObserver((records) => {
        P.mutations += records.length;
      }).observe(summary, {
        subtree: true,
        childList: true,
        attributes: true,
        characterData: true,
      });
  });

  const pose = (which) =>
    page.evaluate(
      ({ which, AUSTIN }) => {
        const C = window.Cesium || null;
        const v = window.__godsEyeView.viewer;
        v.camera.cancelFlight();
        v.camera.lookAtTransform?.(
          (C || v.camera.constructor).Matrix4?.IDENTITY ??
            v.scene.camera.transform,
        );
        const ell = v.scene.ellipsoid || v.scene.globe.ellipsoid;
        const d2r = Math.PI / 180;
        const destination = ell.cartographicToCartesian({
          longitude: AUSTIN.lon * d2r,
          latitude: AUSTIN.lat * d2r,
          height:
            which === 'overhead'
              ? 10_000
              : which === 'close'
                ? 1_200
                : 17_368_000,
        });
        v.camera.setView({
          destination,
          orientation:
            which === 'close'
              ? { heading: 20 * d2r, pitch: -45 * d2r, roll: 0 }
              : { heading: 0, pitch: -90 * d2r, roll: 0 },
        });
      },
      { which, AUSTIN },
    );

  /** Start a 3 s flight without awaiting it; the caller measures alongside. */
  const fly = (which) =>
    page.evaluate(
      ({ which, AUSTIN }) => {
        const v = window.__godsEyeView.viewer;
        const ell = v.scene.ellipsoid || v.scene.globe.ellipsoid;
        const d2r = Math.PI / 180;
        v.camera.flyTo({
          destination: ell.cartographicToCartesian({
            longitude: AUSTIN.lon * d2r,
            latitude: AUSTIN.lat * d2r,
            height: which === 'close' ? 1_200 : 17_368_000,
          }),
          orientation:
            which === 'close'
              ? { heading: 20 * d2r, pitch: -45 * d2r, roll: 0 }
              : { heading: 0, pitch: -90 * d2r, roll: 0 },
          duration: 3,
        });
      },
      { which, AUSTIN },
    );

  /** Start an 8 s orbit at 1.8 km range around the Austin anchor (not awaited). */
  const orbit = () =>
    page.evaluate(
      ({ AUSTIN }) => {
        const v = window.__godsEyeView.viewer;
        const camera = v.camera;
        const ell = v.scene.ellipsoid || v.scene.globe.ellipsoid;
        const d2r = Math.PI / 180;
        const center = ell.cartographicToCartesian({
          longitude: AUSTIN.lon * d2r,
          latitude: AUSTIN.lat * d2r,
          height: 0,
        });
        const HPR = camera.constructor?.HeadingPitchRange
          ? camera.constructor.HeadingPitchRange
          : null;
        const t0 = performance.now();
        let heading = 20 * d2r;
        const step = (now) => {
          const elapsed = (now - t0) / 1000;
          heading = 20 * d2r + (elapsed / 8) * Math.PI * 2;
          const hpr = HPR
            ? new HPR(heading, -45 * d2r, 1800)
            : { heading, pitch: -45 * d2r, range: 1800 };
          camera.lookAt(center, hpr);
          if (elapsed < 8) requestAnimationFrame(step);
          else camera.lookAtTransform(camera.transform.constructor.IDENTITY);
        };
        requestAnimationFrame(step);
      },
      { AUSTIN },
    );

  /** Measure one window; `hold` keeps render demand constant. */
  const measure = (ms, hold) =>
    page.evaluate(
      ({ ms, hold }) =>
        new Promise((resolve) => {
          const gev = window.__godsEyeView;
          const scene = gev.viewer.scene;
          const P = window.__gevWeatherPerf;
          const canvas = scene.canvas;
          const w0 = canvas.width;
          const h0 = canvas.height;
          const r0 = P.renders;
          const l0 = P.longTasks;
          const lm0 = P.longTaskMs;
          const m0 = P.mutations;
          const summary = document.querySelector('.weather-summary');
          const intervals = [];
          const heights = [];
          let lastH = -1;
          let rafs = 0;
          let last = performance.now();
          const t0 = last;
          const finish = (now) => {
            const seconds = (now - t0) / 1000;
            intervals.sort((a, b) => a - b);
            const q = (p) =>
              intervals[
                Math.min(intervals.length - 1, Math.floor(p * intervals.length))
              ] ?? 0;
            const hs = heights.map(([, h]) => h);
            resolve({
              seconds: Number(seconds.toFixed(2)),
              renders: P.renders - r0,
              fps: Number(((P.renders - r0) / seconds).toFixed(1)),
              rafHz: Number((rafs / seconds).toFixed(1)),
              p50: Number(q(0.5).toFixed(1)),
              p95: Number(q(0.95).toFixed(1)),
              max: Number((intervals.at(-1) ?? 0).toFixed(1)),
              longTasks: P.longTasks - l0,
              longTaskMs: Math.round(P.longTaskMs - lm0),
              mutations: P.mutations - m0,
              heightChanges: Math.max(0, heights.length - 1),
              heightMin: hs.length ? Math.min(...hs) : null,
              heightMax: hs.length ? Math.max(...hs) : null,
              canvasStable: canvas.width === w0 && canvas.height === h0,
              canvas: `${w0}x${h0}`,
            });
          };
          const tick = (now) => {
            rafs += 1;
            intervals.push(now - last);
            last = now;
            if (hold) scene.requestRender();
            if (summary && !summary.hidden) {
              const h =
                Math.round(summary.getBoundingClientRect().height * 2) / 2;
              if (h !== lastH) {
                heights.push([Math.round(now - t0), h]);
                lastH = h;
              }
            }
            if (now - t0 < ms) requestAnimationFrame(tick);
            else finish(now);
          };
          requestAnimationFrame(tick);
        }),
      { ms, hold },
    );

  const diagnostics = () =>
    page.evaluate(
      ({ WEATHER }) => {
        const dm = window.__godsEyeView.dataManager;
        const out = {};
        for (const id of ['wind', ...WEATHER]) {
          const entry = dm.layers.get(id);
          if (!entry?.enabled) continue;
          const d = entry.module?.getDiagnostics?.() || {};
          out[id] =
            id === 'wind'
              ? {
                  mode: d.renderMode,
                  ready: d.gpu?.ready,
                  paths: d.gpu?.pathCount,
                  vertices: d.gpu?.vertexCount,
                  buildMs: d.gpu?.buildMs && Math.round(d.gpu.buildMs),
                  cells: d.gpu?.cellCount,
                  visibleCells: d.gpu?.visibleCells,
                  visibleVertices: d.gpu?.visibleVertexCount,
                  heightFade: d.gpu?.heightFade,
                }
              : {
                  time: d.time,
                  playing: d.playing,
                  loading: d.loading,
                  loadedTiles: d.loadedTiles,
                  imageryCount: d.imageryCount,
                  frameLoadMs: d.frameLoadMs && Math.round(d.frameLoadMs),
                  error: d.error,
                  suspended: d.suspended ?? d.globeHidden ?? null,
                };
        }
        return out;
      },
      { WEATHER },
    );

  /** Enable the layers a state names, wait for first imagery/geometry, then set playback. */
  const applyState = async (state) => {
    const wantWind = state.includes('wind');
    const wantHistory = state.includes('history');
    const wantPlaying = state.includes('playing');
    const started = Date.now();
    await page.evaluate(
      async ({ wantWind, wantHistory, WEATHER }) => {
        const dm = window.__godsEyeView.dataManager;
        const set = async (id, on) => {
          const entry = dm.layers.get(id);
          if (!entry || Boolean(entry.enabled) === on) return;
          await dm.setEnabled(id, on, { origin: 'user' });
        };
        await set('wind', wantWind);
        if (wantWind)
          dm.setLayerParams('wind', { overlay: 'speed' }, { origin: 'user' });
        for (const id of WEATHER) await set(id, wantHistory);
      },
      { wantWind, wantHistory, WEATHER },
    );
    let ready = true;
    await page
      .waitForFunction(
        ({ wantWind, wantHistory, WEATHER }) => {
          const dm = window.__godsEyeView.dataManager;
          if (wantWind) {
            const d = dm.layers.get('wind')?.module?.getDiagnostics?.();
            if (!d) return false;
            if (d.renderMode === 'gpu-streamlines' && !d.gpu?.ready)
              return false;
          }
          if (wantHistory)
            for (const id of WEATHER) {
              const d = dm.layers.get(id)?.module?.getDiagnostics?.();
              if (!d || d.loading || (!d.time && !d.error)) return false;
            }
          return true;
        },
        { timeout: 90_000, polling: 250 },
        { wantWind, wantHistory, WEATHER },
      )
      .catch(() => {
        ready = false;
      });
    const readyMs = Date.now() - started;
    await page.evaluate(
      ({ wantPlaying, WEATHER }) => {
        const dm = window.__godsEyeView.dataManager;
        for (const id of WEATHER) {
          const module = dm.layers.get(id)?.module;
          if (!module || !dm.layers.get(id)?.enabled) continue;
          const playing = Boolean(module.getDiagnostics?.().playing);
          if (playing !== wantPlaying)
            dm.setLayerParams(id, { play: true }, { origin: 'user' });
        }
      },
      { wantPlaying, WEATHER },
    );
    await sleep(2_500);
    return { ready, readyMs, layers: await diagnostics() };
  };

  const shot = (name) =>
    page.screenshot({ path: path.join(outDir, `${name}.png`) });

  // ── Matched route ────────────────────────────────────────────────────────
  if (!flag('--no-route')) {
    console.log('\nRoute windows (continuous-render hold):');
    for (let run = 1; run <= repeat; run++) {
      const order = run % 2 === 1 ? states : [...states].reverse();
      for (const state of order) {
        await pose('overhead');
        const setup = await applyState(state);
        console.log(
          `  setup ${state}: ready=${setup.ready} in ${setup.readyMs}ms ${JSON.stringify(setup.layers)}`,
        );
        const base = { phase: 'route', state, run, setup };
        await fly('close');
        record({ ...base, window: 'zoom-in', ...(await measure(6_000, true)) });
        record({
          ...base,
          window: 'close-idle',
          ...(await measure(6_000, true)),
        });
        await shot(`${state}-r${run}-close`);
        await orbit();
        record({ ...base, window: 'orbit', ...(await measure(8_000, true)) });
        await fly('globe');
        record({
          ...base,
          window: 'zoom-out',
          ...(await measure(6_000, true)),
        });
        record({
          ...base,
          window: 'globe-idle',
          ...(await measure(6_000, true)),
        });
        await shot(`${state}-r${run}-globe`);
        console.log(`  after ${state}: ${JSON.stringify(await diagnostics())}`);
      }
    }
  }

  // ── Idle test (normal governor) ──────────────────────────────────────────
  if (!flag('--no-idle')) {
    console.log('\nIdle windows (normal governor, fixed 1.2 km pose):');
    for (const state of ['off', 'history-paused', 'history-playing', 'wind']) {
      await pose('close');
      const setup = await applyState(state);
      await sleep(4_000);
      for (let run = 1; run <= 2; run++)
        record({
          phase: 'idle',
          state,
          run,
          window: 'fixed-8s',
          setup,
          ...(await measure(8_000, false)),
        });
      await shot(`idle-${state}`);
    }
    await applyState('off');
  }

  writeFileSync(
    path.join(outDir, 'results.json'),
    JSON.stringify({ label, url, env, results }, null, 2),
  );
  const lines = [
    `# qa-weather-perf · ${label}`,
    '',
    `url: ${url}  ·  ${env.basemap}  ·  canvas ${env.canvas} @ DPR ${env.dpr}  ·  ${env.ua}`,
    '',
    '| phase | state | run | window | fps | p50 ms | p95 ms | max ms | long tasks | long ms | dom mut | height ∆ | height min–max |',
    '|---|---|---|---|---|---|---|---|---|---|---|---|---|',
    ...results.map(
      (r) =>
        `| ${r.phase} | ${r.state} | ${r.run} | ${r.window} | ${r.fps}${r.canvasStable ? '' : ' ⚠'} | ${r.p50} | ${r.p95} | ${r.max} | ${r.longTasks} | ${r.longTaskMs} | ${r.mutations} | ${r.heightChanges} | ${r.heightMin ?? '—'}–${r.heightMax ?? '—'} |`,
    ),
  ];
  writeFileSync(path.join(outDir, 'summary.md'), lines.join('\n') + '\n');
  console.log(`\nWrote ${path.join(outDir, 'results.json')} and summary.md`);
} finally {
  await browser.close();
}
