#!/usr/bin/env node
/**
 * Sky view QA + performance harness, headless
 * Chromium against a running GEV dev server:
 *
 *   node scripts/qa-sky-render.mjs --url http://127.0.0.1:4337 --out <dir>
 *        [--update-reference] [--reference <png>]
 *
 * 1. Orion-region overlay at a fixed place/time (Houston, ground 15 m,
 *    2026-01-16 03:00 UTC, az 145 el 52 fov 60, boundaries on): the overlay CANVAS (stars, lines, labels, horizon
 *    and compass; no WebGL, so it is deterministic) is compared pixel by
 *    pixel with the stored reference PNG. A pixel "differs" when any channel
 *    differs by more than DIFF_LEVEL; the run passes when at most
 *    DIFF_TOLERANCE of the pixels differ.
 * 2. Betelgeuse and Rigel: the overlay's drawn position vs skyMath az/el pushed
 *    through the live Cesium camera's view and projection matrices (<= 1 px).
 * 3. Redraw timings (setView() once per animation frame = camera apply + the
 *    full overlay redraw: pass + stars,
 *    constellations, boundaries, bodies, labels, grid) over a pan sweep,
 *    desktop 1280x800 DPR 1 and a "mid phone" profile (412x915, DPR 2.625,
 *    CDP CPU throttle x4), at fov 60 (limit 6.5) and fov 100 (wide cap 5.0)
 *    with every layer on, plus the 2 s position update cost. Cesium's render
 *    loop is paused while timing (the headless globe renders with software
 *    GL, which a phone does not); one desktop run keeps it on, for info.
 * Writes results.json, orion-overlay.png, diff.png and page screenshots.
 */
import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer';
import sharp from 'sharp';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const arg = (name, fallback) => {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : fallback;
};
const BASE = arg('--url', 'http://127.0.0.1:4337');
const OUT = path.resolve(arg('--out', 'qa-sky-render'));
const REFERENCE = path.resolve(
  arg(
    '--reference',
    path.join(ROOT, 'src/skyView/reference/orion-overlay.png'),
  ),
);
const UPDATE = process.argv.includes('--update-reference');
export const DIFF_LEVEL = 32;
export const DIFF_TOLERANCE = 0.005;
/** Fixed place/time/view of the Orion reference frame (boundaries on). */
const ORION_STATE = {
  latDeg: 29.7604,
  lonDeg: -95.3698,
  groundM: 15,
  time: '2026-01-16T03:00:00Z',
  view: { azDeg: 145, elDeg: 52, fovDeg: 60, rollDeg: 0 },
};
const SETTLE_MS = Number(arg('--settle-ms', '30000'));
mkdirSync(OUT, { recursive: true });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = [];
const say = (...parts) => {
  const line = parts
    .map((p) => (typeof p === 'string' ? p : JSON.stringify(p)))
    .join(' ');
  log.push(line);
  console.log(line);
};

const browser = await puppeteer.launch({
  headless: true,
  protocolTimeout: 900000,
  args: [
    '--no-sandbox',
    '--use-gl=angle',
    '--use-angle=swiftshader',
    '--enable-unsafe-swiftshader',
    '--ignore-gpu-blocklist',
    '--font-render-hinting=none',
  ],
});
const errors = [];
/** HTTP failures outside the Sky view (no keys on a worktree dev server). */
const unrelated = [];

async function openSky(profile) {
  const page = await browser.newPage();
  await page.setViewport(profile.viewport);
  page.on('pageerror', (e) =>
    errors.push(`${profile.name}: ${String(e).slice(0, 300)}`),
  );
  page.on('console', (m) => {
    // resource failures are reported by URL below instead
    if (m.type() === 'error' && !/Failed to load resource/.test(m.text()))
      errors.push(`${profile.name} console: ${m.text().slice(0, 300)}`);
  });
  page.on('response', (r) => {
    if (r.status() < 400) return;
    const entry = `${profile.name}: ${r.status()} ${r.url().slice(0, 200)}`;
    // anything the Sky view itself loads must succeed
    if (/\/skyView\//.test(r.url())) errors.push(entry);
    else unrelated.push(entry);
  });
  // Open the plain map, let the start-up camera flight finish (it would
  // otherwise move the camera and take Sky mode down), then enter the sky
  // with a fixed time and a known ground height so the run is repeatable.
  await page.goto(`${BASE}/`, {
    waitUntil: 'domcontentloaded',
    timeout: 120000,
  });
  await page.waitForFunction(() => window.__godsEyeView?.viewer, {
    timeout: 180000,
  });
  await page.waitForSelector('.gev-sky-btn', { timeout: 180000 });
  await sleep(SETTLE_MS);
  await page.keyboard.press('Escape');
  let state = null;
  for (let i = 0; i < 60; i++) {
    state = await page.evaluate(async (orion) => {
      const m = await import('/src/skyView/skyView.js');
      const h = m.mountSkyView({ viewer: window.__godsEyeView.viewer });
      if (!h.active) {
        h.clock.setFixed(Date.parse(orion.time));
        await h.enterAt({
          latDeg: orion.latDeg,
          lonDeg: orion.lonDeg,
          source: 'manual',
          heightM: orion.groundM,
          heightKnown: true,
        });
        h.content.setFlags({ boundaries: true });
        h.setView(orion.view);
      }
      return {
        active: Boolean(h?.active),
        status: h?.content?.status ?? null,
        text: document.querySelector('[data-sky=status]')?.textContent ?? '',
      };
    }, ORION_STATE);
    if (state.active && state.status === 'ready') break;
    await sleep(2000);
  }
  if (!(state?.active && state.status === 'ready'))
    throw new Error(
      `${profile.name}: sky never ready ${JSON.stringify(state)}`,
    );
  await sleep(3000);
  if (profile.cpuThrottle > 1) {
    const cdp = await page.createCDPSession();
    await cdp.send('Emulation.setCPUThrottlingRate', {
      rate: profile.cpuThrottle,
    });
  }
  await sleep(1500);
  return page;
}

/** In-page: the sky handle. */
const HANDLE = `(async () => {
  const m = await import('/src/skyView/skyView.js');
  return m.mountSkyView({ viewer: window.__godsEyeView.viewer });
})()`;

async function orionChecks(page) {
  return page.evaluate(async (handleSrc) => {
    const h = await eval(handleSrc);
    const skyMath = await import('/src/skyView/skyMath.js');
    h.setView({ azDeg: 145, elDeg: 52, fovDeg: 60, rollDeg: 0 });
    h.redraw();
    const content = h.content;
    const stars = content.data.stars;
    const field = content.field;
    const viewer = window.__godsEyeView.viewer;
    const camera = viewer.camera;
    const canvas = viewer.scene.canvas;
    const W = canvas.clientWidth;
    const H = canvas.clientHeight;
    const frame = skyMath.starFrame(
      h.clock.getTime(),
      h.observer.latDeg,
      h.observer.lonDeg,
    );
    // ENU basis at the observer (geodetic), Cesium column-major matrices.
    const D = Math.PI / 180;
    const lat = h.observer.latDeg * D;
    const lon = h.observer.lonDeg * D;
    const E = [-Math.sin(lon), Math.cos(lon), 0];
    const N = [
      -Math.sin(lat) * Math.cos(lon),
      -Math.sin(lat) * Math.sin(lon),
      Math.cos(lat),
    ];
    const U = [
      Math.cos(lat) * Math.cos(lon),
      Math.cos(lat) * Math.sin(lon),
      Math.sin(lat),
    ];
    const P = camera.positionWC;
    const mul4 = (m, v) =>
      [0, 1, 2, 3].map(
        (r) =>
          m[r] * v[0] + m[4 + r] * v[1] + m[8 + r] * v[2] + m[12 + r] * v[3],
      );
    const pixel = (az, el) => {
      const d = skyMath.enuFromAzEl(az, el);
      const w = [0, 1, 2].map((i) => d[0] * E[i] + d[1] * N[i] + d[2] * U[i]);
      const pt = [P.x + w[0] * 1e5, P.y + w[1] * 1e5, P.z + w[2] * 1e5, 1];
      const eye = mul4(camera.viewMatrix, pt);
      const clip = mul4(camera.frustum.projectionMatrix, eye);
      return {
        x: ((clip[0] / clip[3] + 1) / 2) * W,
        y: ((1 - clip[1] / clip[3]) / 2) * H,
      };
    };
    const { starModel } = await import('/src/skyView/starLayer.js');
    const model = starModel(field, {
      view: h.view,
      width: W,
      height: H,
      lim: content.lastStats.lim,
    });
    const rows = [];
    for (const name of ['Betelgeuse', 'Rigel']) {
      const i = [...stars.names].find(([, n]) => n === name)[0];
      const k = [...model.index.subarray(0, model.count)].indexOf(i);
      const ref = skyMath.starAzEl(
        frame,
        stars.ra[i],
        stars.dec[i],
        stars.pmRa[i],
        stars.pmDec[i],
        { refraction: true },
      );
      const want = pixel(ref.azDeg, ref.elDeg);
      rows.push({
        name,
        azDeg: ref.azDeg,
        elDeg: ref.elDeg,
        drawn: k >= 0 ? { x: model.x[k], y: model.y[k] } : null,
        cesium: want,
        errorPx:
          k >= 0 ? Math.hypot(model.x[k] - want.x, model.y[k] - want.y) : null,
      });
    }
    return {
      size: [W, H],
      stats: {
        stars: content.lastStats.stars,
        segments: content.lastStats.segments,
        names: content.lastStats.names,
        boundaries: content.lastStats.boundaries,
        bodies: content.lastStats.bodyNames,
        labels: content.lastStats.labels.length,
        lim: content.lastStats.lim,
      },
      stars: rows,
      png: h.elements.canvas.toDataURL('image/png'),
    };
  }, HANDLE);
}

async function timings(
  page,
  {
    fovDeg,
    steps = 200,
    pauseCesium = true,
    warmup = 30,
    layers = 'all',
    satellites = true,
  },
) {
  return page.evaluate(
    async (handleSrc, fov, n, pause, warm, layerSet, sats) => {
      const h = await eval(handleSrc);
      // satellites draw in the same overlay; `satellites: false` stops
      // them (info run: the share of the redraw)
      if (!sats && h.satellites?.running) h.satellites.stop();
      const viewer = window.__godsEyeView.viewer;
      // 'all' = every layer incl. the off-by-default boundaries and grid
      // (worst case); 'default' = the layers a first-time visitor sees.
      const all = layerSet === 'all';
      h.content.setFlags(
        {
          stars: true,
          lines: true,
          names: true,
          boundaries: all,
          starNames: true,
          planets: true,
          grid: all,
        },
        { notify: true },
      );
      await new Promise((r) => setTimeout(r, 500));
      // The budget is the overlay's: pause Cesium's own render loop so the
      // headless software-GL globe does not share the measured time slices.
      if (pause) viewer.useDefaultRenderLoop = false;
      // Warm-up frames (JIT, sprite atlas, font cache) are not measured.
      for (let i = 0; i < warm; i++) {
        await new Promise((resolve) =>
          requestAnimationFrame(() => {
            h.setView({ azDeg: 300 - i, elDeg: 30 + (i % 10), fovDeg: fov });
            resolve();
          }),
        );
      }
      h.content.resetPerf();
      h.resetRedrawPerf();
      const redraw = [];
      // One view change per animation frame, like a drag: the measured time
      // is setView() = camera apply + the full overlay redraw.
      for (let i = 0; i < n; i++) {
        await new Promise((resolve) =>
          requestAnimationFrame(() => {
            const t0 = performance.now();
            h.setView({
              azDeg: 100 + i * 0.9,
              elDeg: 40 + (i % 20),
              fovDeg: fov,
            });
            redraw.push(performance.now() - t0);
            resolve();
          }),
        );
      }
      const contentDraw = h.content.perf();
      const overlayRedraw = h.redrawPerf();
      viewer.useDefaultRenderLoop = true;
      const update = [];
      const base = h.clock.getTime();
      for (let i = 1; i <= 30; i++) {
        const t0 = performance.now();
        h.content.update(base + i * 2000, h.observer);
        update.push(performance.now() - t0);
      }
      const q = (arr, p) => {
        const s = [...arr].sort((a, b) => a - b);
        return s[Math.min(s.length - 1, Math.floor(p * s.length))];
      };
      const stats = h.content.lastStats;
      return {
        fovDeg: fov,
        layers: layerSet,
        warmupFrames: warm,
        cesiumPaused: pause,
        samples: n,
        // budget metric: the overlay redraw itself
        overlayRedraw,
        // info: setView() end to end = Cesium camera apply + its camera
        // listeners (upstream HUD) + overlay redraw + URL scheduling
        setViewEndToEnd: {
          p50: q(redraw, 0.5),
          p95: q(redraw, 0.95),
          max: q(redraw, 1),
        },
        contentDraw,
        update2s: {
          p50: q(update, 0.5),
          p95: q(update, 0.95),
          max: q(update, 1),
        },
        lastFrame: {
          stars: stats.stars,
          lim: stats.lim,
          segments: stats.segments,
          boundaries: stats.boundaries,
          labels: stats.labels.length,
          satellitesRunning: Boolean(h.satellites?.running),
          satelliteObjects: h.satellites?.running
            ? h.satellites.objectsAt(h.clock.getTime()).length
            : 0,
          satelliteDots: h.satelliteModel?.dots?.length ?? 0,
        },
      };
    },
    HANDLE,
    fovDeg,
    steps,
    pauseCesium,
    warmup,
    layers,
    satellites,
  );
}

/** --breakdown: per-layer frame cost (one layer on at a time). */
async function breakdown(page, { fovDeg = 60, steps = 60 } = {}) {
  return page.evaluate(
    async (handleSrc, fov, n) => {
      const h = await eval(handleSrc);
      const viewer = window.__godsEyeView.viewer;
      const none = {
        stars: false,
        lines: false,
        names: false,
        boundaries: false,
        starNames: false,
        planets: false,
        grid: false,
      };
      const sets = [['none', {}]].concat(
        Object.keys(none).map((k) => [k, { [k]: true }]),
      );
      viewer.useDefaultRenderLoop = false;
      const out = {};
      for (const [name, on] of sets) {
        h.content.setFlags({ ...none, ...on }, { notify: true });
        await new Promise((r) => setTimeout(r, 300));
        const t = [];
        for (let i = 0; i < n; i++)
          await new Promise((resolve) =>
            requestAnimationFrame(() => {
              const t0 = performance.now();
              h.setView({ azDeg: 100 + i, elDeg: 40 + (i % 20), fovDeg: fov });
              t.push(performance.now() - t0);
              resolve();
            }),
          );
        t.sort((a, b) => a - b);
        out[name] = {
          p50: t[n >> 1],
          p95: t[Math.floor(n * 0.95)],
        };
      }
      viewer.useDefaultRenderLoop = true;
      return out;
    },
    HANDLE,
    fovDeg,
    steps,
  );
}

async function pngDiff(currentBuffer, referenceBuffer) {
  const a = await sharp(currentBuffer).ensureAlpha().raw().toBuffer({
    resolveWithObject: true,
  });
  const b = await sharp(referenceBuffer).ensureAlpha().raw().toBuffer({
    resolveWithObject: true,
  });
  if (a.info.width !== b.info.width || a.info.height !== b.info.height)
    return { sizeMismatch: [a.info, b.info], fraction: 1 };
  const total = a.info.width * a.info.height;
  const diff = Buffer.alloc(total * 4);
  let differ = 0;
  for (let p = 0; p < total; p++) {
    let bad = false;
    for (let c = 0; c < 4; c++)
      if (Math.abs(a.data[p * 4 + c] - b.data[p * 4 + c]) > DIFF_LEVEL)
        bad = true;
    if (bad) differ++;
    diff[p * 4] = bad ? 255 : 0;
    diff[p * 4 + 1] = 0;
    diff[p * 4 + 2] = 0;
    diff[p * 4 + 3] = bad ? 255 : 40;
  }
  const diffPng = await sharp(diff, {
    raw: { width: a.info.width, height: a.info.height, channels: 4 },
  })
    .png()
    .toBuffer();
  return { differ, total, fraction: differ / total, diffPng };
}

const results = { url: BASE, when: new Date().toISOString(), profiles: {} };
const profiles = [
  {
    name: 'desktop',
    viewport: { width: 1280, height: 800, deviceScaleFactor: 1 },
    cpuThrottle: 1,
    budgetMs: 8,
  },
  {
    name: 'mid-phone',
    viewport: {
      width: 412,
      height: 915,
      deviceScaleFactor: 2.625,
      isMobile: true,
      hasTouch: true,
    },
    cpuThrottle: 4,
    budgetMs: 16,
  },
];
const only = arg('--profile', '');
for (const profile of profiles.filter((p) => !only || p.name === only)) {
  const page = await openSky(profile);
  const entry = {
    budgetMs: profile.budgetMs,
    cpuThrottle: profile.cpuThrottle,
  };
  if (profile.name === 'desktop') {
    const orion = await orionChecks(page);
    const png = Buffer.from(orion.png.split(',')[1], 'base64');
    writeFileSync(path.join(OUT, 'orion-overlay.png'), png);
    await page.screenshot({ path: path.join(OUT, 'orion-page.png') });
    entry.orion = { size: orion.size, stats: orion.stats, stars: orion.stars };
    say('ORION', entry.orion);
    if (UPDATE || !existsSync(REFERENCE)) {
      mkdirSync(path.dirname(REFERENCE), { recursive: true });
      writeFileSync(REFERENCE, png);
      entry.reference = { written: REFERENCE };
      say('REFERENCE written', REFERENCE);
    } else {
      const d = await pngDiff(png, readFileSync(REFERENCE));
      if (d.diffPng) writeFileSync(path.join(OUT, 'orion-diff.png'), d.diffPng);
      entry.reference = {
        file: REFERENCE,
        differingPixels: d.differ,
        totalPixels: d.total,
        fraction: d.fraction,
        tolerance: DIFF_TOLERANCE,
        level: DIFF_LEVEL,
        pass: d.fraction <= DIFF_TOLERANCE,
      };
      say('REFERENCE diff', entry.reference);
    }
  }
  if (process.argv.includes('--breakdown')) {
    entry.breakdown = await breakdown(page);
    say(profile.name, 'breakdown', entry.breakdown);
  }
  entry.runs = [];
  const runs = [
    { fovDeg: 60 },
    { fovDeg: 100 },
    { fovDeg: 60, layers: 'default' },
    { fovDeg: 100, layers: 'default' },
    // info only: desktop with the Cesium globe still rendering in between
    ...(profile.name === 'desktop'
      ? [{ fovDeg: 60, pauseCesium: false, info: true }]
      : []),
    // info only, last (it stops the satellite worker): alone
    { fovDeg: 60, satellites: false, info: true },
  ];
  for (const run of runs) {
    const t = await timings(page, run);
    t.info = Boolean(run.info);
    t.pass = t.info || t.overlayRedraw.p95 < profile.budgetMs;
    entry.runs.push(t);
    say(profile.name, t);
  }
  await page.screenshot({ path: path.join(OUT, `${profile.name}-page.png`) });
  results.profiles[profile.name] = entry;
  await page.close();
}
results.errors = errors;
results.unrelatedHttpFailures = unrelated;
writeFileSync(
  path.join(OUT, 'results.json'),
  `${JSON.stringify(results, null, 2)}\n`,
);
writeFileSync(path.join(OUT, 'log.txt'), `${log.join('\n')}\n`);
say('ERRORS', errors);
say('UNRELATED HTTP FAILURES', unrelated);
await browser.close();
const ok =
  errors.length === 0 &&
  Object.values(results.profiles).every((p) => p.runs.every((r) => r.pass)) &&
  (results.profiles.desktop?.reference.pass ?? true) &&
  (results.profiles.desktop?.orion.stars ?? []).every(
    (s) => s.errorPx !== null && s.errorPx <= 1,
  );
say(ok ? 'QA PASS' : 'QA FAIL');
process.exitCode = ok ? 0 : 1;
