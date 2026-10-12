#!/usr/bin/env node
/**
 * qa-alpr-journey.mjs — ALPR cameras on a realistic Austin camera journey.
 *
 * Run: node scripts/qa-alpr-journey.mjs http://localhost:4173 [--headful]
 *      [--passes off,on,on] [--out qa-shots/alpr-journey] [--no-assert]
 *
 * Drives the same eased camera path several times: a neighbourhood by Camp
 * Mabry (~2 km across), two 600 m pans, a small zoom out and back, downtown
 * (~6 km), the whole city (~30 km) and back to the neighbourhood. The first
 * pass runs with Mapped ALPR Cameras off (it also warms the photoreal tiles),
 * then ALPR is switched on mid-journey from its layer row and the path repeats
 * cold and warm.
 *
 * Per stop it records: time from the camera stopping to cameras shown (or an
 * explicit "zoom in" state), the camera count and row status, rAF interval and
 * Cesium render CPU time (mean / p50 / p95) while moving and while holding, and
 * marker stability while the camera is still (camera-set changes after the stop
 * has settled). Asserts, unless --no-assert: neighbourhood and downtown show
 * cameras within 2 s on the warm pass; the whole-city stop shows cameras or a
 * zoom-in prompt and never ends a hold still loading; at most one visible
 * marker update per stop and none after 3 s while still; warm-pass frame p50/p95 within 10% of the ALPR-off pass (plus a
 * 2 ms floor for timer noise); zero console errors.
 *
 * Rendered-state checks read the recorded frames, not entity state: ALPR-cyan
 * pixels per frame during each hold, minus the ALPR-off pass at the same stop,
 * give when markers actually reached the screen. Cameras projected on screen
 * must be painted, no later than 700 ms after the layer state settled (a
 * missing render request fails here), within 2 s of the stop on the warm pass;
 * a view whose loaded cameras are all off screen must say "None on screen".
 * At the end of each hold the screen is compared with the same scene after
 * forcing four frames; any marker difference is a missing render request.
 * --self-test-drop-renders disables explicit render requests during the ALPR
 * passes to prove those checks fail.
 *
 * Writes <out>/result.json, <out>/clip.mp4 (CDP screencast with real frame
 * timing) and per-stop screenshots. Needs ffmpeg on PATH.
 */
import fs from 'node:fs';
import path from 'node:path';
import puppeteer from 'puppeteer';
import sharp from 'sharp';
import {
  createScreencast,
  frameStats,
  installFrameProbe,
  moveCamera,
  pageNow,
  readFrames,
} from './qa-journey-recorder.mjs';

const argv = process.argv.slice(2);
if (argv.includes('--help') || argv.includes('-h')) {
  console.log(
    'Usage: node scripts/qa-alpr-journey.mjs <dev-server-url> [--headful] [--passes off,on,on] [--out dir] [--no-assert] [--self-test-drop-renders]',
  );
  process.exit(0);
}
const option = (name, fallback) => {
  const i = argv.indexOf(name);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : fallback;
};
const appUrl =
  argv.find((arg) => /^https?:/.test(arg)) || 'http://localhost:4173';
const outDir = path.resolve(option('--out', 'qa-shots/alpr-journey'));
const passes = option('--passes', 'off,on,on').split(',');
const assertOn = !argv.includes('--no-assert');
const dropRenders = argv.includes('--self-test-drop-renders');
fs.mkdirSync(outDir, { recursive: true });
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const cyanCount = async (file) => {
  const { data, info } = await sharp(file)
    .resize({ width: 640 })
    .raw()
    .toBuffer({ resolveWithObject: true });
  let n = 0;
  for (let i = 0; i < data.length; i += info.channels) {
    const r = data[i];
    const g = data[i + 1];
    const b = data[i + 2];
    if (r < 140 && g > 160 && b > 205 && b - r > 80) n += 1;
  }
  return n;
};

/** Cyan pixels (at 640 px width) that mean at least one badge is painted. */
const MIN_MARKER_PIXELS = 12;

// Camp Mabry neighbourhood (Tarrytown / Bryker Woods), downtown, whole city.
const N = {
  lat: 30.2985,
  lon: -97.7655,
  height: 1500,
  heading: 20,
  pitch: -55,
};
const east = (view, m) => ({
  ...view,
  lon: view.lon + m / (111_320 * Math.cos((view.lat * Math.PI) / 180)),
});
const north = (view, m) => ({ ...view, lat: view.lat + m / 111_320 });
const STOPS = [
  { name: 'neighbourhood', view: N, move: 0, hold: 6, scale: 'neighbourhood' },
  {
    name: 'pan-east-600m',
    view: east(N, 600),
    move: 2.5,
    hold: 5,
    scale: 'neighbourhood',
  },
  {
    name: 'pan-north-600m',
    view: north(east(N, 600), 600),
    move: 2.5,
    hold: 5,
    scale: 'neighbourhood',
  },
  {
    name: 'zoom-out-3km',
    view: { ...north(east(N, 600), 600), height: 3000 },
    move: 2.5,
    hold: 5,
    scale: 'neighbourhood',
  },
  {
    name: 'zoom-back-in',
    view: north(east(N, 600), 600),
    move: 2.5,
    hold: 5,
    scale: 'neighbourhood',
  },
  {
    name: 'downtown-6km',
    view: { lat: 30.262, lon: -97.7431, height: 4500, heading: 0, pitch: -60 },
    move: 3,
    hold: 7,
    scale: 'downtown',
  },
  {
    name: 'city-30km',
    view: { lat: 30.2, lon: -97.75, height: 24000, heading: 0, pitch: -65 },
    move: 3,
    hold: 8,
    scale: 'city',
  },
  {
    name: 'back-to-neighbourhood',
    view: N,
    move: 3,
    hold: 6,
    scale: 'neighbourhood',
  },
];

const browser = await puppeteer.launch({
  headless: !argv.includes('--headful'),
  protocolTimeout: 300_000,
  args: [
    '--no-sandbox',
    ...(process.platform === 'darwin'
      ? ['--use-angle=metal', '--enable-gpu']
      : ['--use-gl=angle', '--use-angle=swiftshader']),
    '--disable-background-timer-throttling',
    '--disable-renderer-backgrounding',
    '--disable-backgrounding-occluded-windows',
  ],
});
const result = {
  url: appUrl,
  startedAt: new Date().toISOString(),
  passes: [],
  consoleErrors: [],
  failures: [],
};
const fail = (message) => {
  result.failures.push(message);
  console.log(`[FAIL] ${message}`);
};
let page;
try {
  page = await browser.newPage();
  await page.setViewport({ width: 1440, height: 900 });
  await page.evaluateOnNewDocument(() =>
    sessionStorage.setItem('gev:first-run-mission-session:v1', 'dismissed'),
  );
  page.on('console', (message) => {
    if (message.type() === 'error') result.consoleErrors.push(message.text());
  });
  page.on('pageerror', (error) => result.consoleErrors.push(error.message));
  const url = new URL(appUrl);
  url.searchParams.set('welcome', '0');
  await page.goto(url.href, { waitUntil: 'domcontentloaded', timeout: 90_000 });
  await page.waitForFunction(
    () =>
      window.__godsEyeView?.dataManager &&
      document.getElementById('loading-screen')?.classList.contains('hidden'),
    { timeout: 120_000 },
  );
  await page.evaluate(
    () => window.__godsEyeView.styleManager.initialRestorePromise,
  );
  await page.keyboard.press('Escape');
  await installFrameProbe(page);
  // ALPR watcher: row state every 100 ms and the rendered camera set (ids and
  // visibility) as a cheap hash, so structural churn while still is visible.
  await page.evaluate(() => {
    const samples = [];
    window.__gevAlprSamples = samples;
    setInterval(() => {
      const entry = window.__godsEyeView.dataManager.layers.get('alpr-cameras');
      const stats = entry?.module?.getStats?.() || {};
      // Layers that publish a render revision are measured by it; otherwise
      // hash the rendered entity ids and their visibility.
      let hash = 0;
      let shown = 0;
      if (Number.isFinite(stats.renderRevision)) {
        hash = stats.renderRevision;
        shown = stats.shown ?? stats.count ?? 0;
      } else {
        const entities =
          entry?.module && entry.enabled
            ? window.__godsEyeView.viewer.dataSources.getByName(
                'alpr-cameras',
              )[0]?.entities.values || []
            : [];
        for (const entity of entities) {
          if (entity.show === false) continue;
          shown += 1;
          const id = String(entity.id);
          for (let i = 0; i < id.length; i++)
            hash = (hash * 31 + id.charCodeAt(i)) | 0;
        }
      }
      samples.push({
        t: performance.now(),
        enabled: Boolean(entry?.enabled),
        count: stats.count ?? 0,
        shown,
        hash,
        loading: Boolean(stats.loading),
        status: stats.status || null,
        label: stats.loadingLabel || '',
        onScreen: stats.onScreen ?? null,
      });
      if (samples.length > 20_000) samples.splice(0, 5_000);
    }, 100);
  });
  const recorder = await createScreencast(page, outDir);
  await recorder.start();

  async function waitTiles(maxMs = 20_000) {
    await page
      .waitForFunction(
        () => {
          const { scene } = window.__godsEyeView.viewer;
          if (scene.globe.show) return scene.globe.tilesLoaded;
          for (let i = 0; i < scene.primitives.length; i++) {
            const p = scene.primitives.get(i);
            if (p.show && p.tilesLoaded === false) return false;
          }
          return true;
        },
        { timeout: maxMs, polling: 250 },
      )
      .catch(() => {});
  }

  for (const [passIndex, mode] of passes.entries()) {
    const alpr = mode === 'on';
    const passName = `${passIndex + 1}-${mode}${alpr && passes.slice(0, passIndex).includes('on') ? '-warm' : alpr ? '-cold' : ''}`;
    console.log(`Pass ${passName}`);
    await moveCamera(page, STOPS[0].view, 0);
    await waitTiles();
    if (
      alpr !==
      (await page.evaluate(() =>
        window.__godsEyeView.dataManager.isEnabled('alpr-cameras'),
      ))
    ) {
      // The user's switch: the layer row, not a private API.
      await page.evaluate(
        (enabled) =>
          window.__godsEyeView.dataManager.setEnabled('alpr-cameras', enabled, {
            origin: 'user',
          }),
        alpr,
      );
    }
    if (alpr && dropRenders)
      // Self-test: drop explicit render requests so markers reach the screen
      // only with the next camera move. The rendered-pixel checks must fail.
      await page.evaluate(() => {
        window.__godsEyeView.viewer.scene.requestRender = () => {};
      });
    const pass = { name: passName, alpr, stops: [] };
    for (const stop of STOPS) {
      const moveStart = await pageNow(page);
      if (stop.move) await moveCamera(page, stop.view, stop.move);
      else await moveCamera(page, stop.view, 0);
      const holdStart = await pageNow(page);
      const holdStartEpoch = await page.evaluate(
        () => performance.timeOrigin + performance.now(),
      );
      await sleep(stop.hold * 1000);
      const holdEnd = await pageNow(page);
      // Render truth: what the screen shows at the end of the hold versus the
      // same scene after forcing a few frames. A difference means the layer
      // changed state without asking for a render.
      let staleFrame = null;
      if (alpr) {
        const shown = await cyanCount(await page.screenshot({ type: 'png' }));
        await page.evaluate(async () => {
          const { scene } = window.__godsEyeView.viewer;
          const mode = scene.requestRenderMode;
          scene.requestRenderMode = false;
          for (let i = 0; i < 4; i++)
            await new Promise((resolve) => requestAnimationFrame(resolve));
          scene.requestRenderMode = mode;
        });
        const forced = await cyanCount(await page.screenshot({ type: 'png' }));
        staleFrame = {
          shown,
          forced,
          stale: Math.abs(forced - shown) > Math.max(8, forced * 0.15),
        };
      }
      const moving = frameStats(await readFrames(page, moveStart, holdStart));
      const holding = frameStats(await readFrames(page, holdStart, holdEnd));
      const samples = await page.evaluate(
        (a, b) => window.__gevAlprSamples.filter((s) => s.t >= a && s.t < b),
        holdStart,
        holdEnd,
      );
      // Time to cameras: the last visible change (or the end of loading) after
      // the camera stopped. More than one visible change, or any change after
      // 3 s, is flicker: a still camera must see one clean update at most.
      let visualChanges = 0;
      const changeLog = [];
      let lastChangeAt = null;
      let loadingEndAt = null;
      let wasLoading = false;
      let previous = null;
      for (const s of samples) {
        if (
          previous &&
          (s.hash !== previous.hash || s.shown !== previous.shown)
        ) {
          visualChanges += 1;
          lastChangeAt = s.t;
          changeLog.push({
            atMs: Math.round(s.t - holdStart),
            shown: s.shown,
            loading: s.loading,
          });
        }
        if (s.loading) wasLoading = true;
        else if (wasLoading && loadingEndAt === null) loadingEndAt = s.t;
        previous = s;
      }
      const first = samples[0] || {};
      const settledAt = Math.max(
        lastChangeAt ?? holdStart,
        loadingEndAt ?? (first.loading ? holdEnd : holdStart),
      );
      const end = samples.at(-1) || {};
      const row = {
        stop: stop.name,
        scale: stop.scale,
        holdEpochMs: [holdStartEpoch, holdStartEpoch + (holdEnd - holdStart)],
        onScreen: end.onScreen ?? null,
        staleFrame,
        timeToCamerasMs: alpr ? Math.round(settledAt - holdStart) : null,
        cameras: end.count ?? 0,
        shown: end.shown ?? 0,
        status: end.status,
        label: end.label,
        loadingAtHoldEnd: Boolean(end.loading),
        visualChanges,
        changeLog,
        lateChanges: samples.filter(
          (sample, i) =>
            i > 0 &&
            sample.t > holdStart + 3000 &&
            (sample.hash !== samples[i - 1].hash ||
              sample.shown !== samples[i - 1].shown),
        ).length,
        moving,
        holding,
      };
      pass.stops.push(row);
      console.log(
        `  ${stop.name.padEnd(22)} cams ${String(row.cameras).padStart(5)} t ${String(row.timeToCamerasMs ?? '-').padStart(5)} ms  frame p50/p95 ${holding.frameP50}/${holding.frameP95}  render p50/p95 ${holding.renderP50}/${holding.renderP95}  changes ${visualChanges}/${row.lateChanges} ${row.status || ''} ${row.label || ''}`,
      );
      if (passIndex === passes.length - 1) {
        await page.screenshot({
          path: path.join(outDir, `${passName}-${stop.name}.png`),
        });
      }
    }
    result.passes.push(pass);
  }
  const clip = await recorder.stop();
  result.clip = clip;
  // Clip-relative hold windows, so a reviewer can jump to each stop.
  const clipStart = recorder.frames[0]?.timestamp * 1000;
  for (const pass of result.passes)
    for (const stop of pass.stops)
      stop.clipSeconds = stop.holdEpochMs.map(
        (ms) => Math.round((ms - clipStart) / 100) / 10,
      );
  console.log('clip', clip);

  // Rendered-state check from the recorded frames themselves: count ALPR-cyan
  // pixels per frame during each hold, subtract the ALPR-off pass at the same
  // stop, and find when the markers actually became visible on screen. Entity
  // state can be ready while nothing is painted (a missing render request),
  // which this catches and the in-page samples cannot.
  const framesIn = ([a, b]) =>
    recorder.frames.filter(
      (frame) => frame.timestamp * 1000 >= a && frame.timestamp * 1000 < b,
    );
  const median = (list) =>
    list.length ? [...list].sort((x, y) => x - y)[list.length >> 1] : 0;
  const offPass = result.passes.find((p) => !p.alpr);
  for (const pass of result.passes) {
    for (const [index, stop] of pass.stops.entries()) {
      const frames = framesIn(stop.holdEpochMs);
      const counts = [];
      for (const frame of frames)
        counts.push({
          atMs: Math.round(frame.timestamp * 1000 - stop.holdEpochMs[0]),
          cyan: await cyanCount(frame.file),
        });
      stop.pixelTimeline = counts;
      if (!pass.alpr) {
        stop.cyanBaseline = median(counts.map((c) => c.cyan));
        continue;
      }
      const baseline = offPass?.stops[index]?.cyanBaseline ?? 0;
      const tail = counts.filter(
        (c) => c.atMs >= stop.holdEpochMs[1] - stop.holdEpochMs[0] - 1000,
      );
      const final = median(tail.map((c) => c.cyan)) - baseline;
      stop.renderedMarkerPixels = final;
      let visibleAt = null;
      if (final >= MIN_MARKER_PIXELS) {
        for (let i = counts.length - 1; i >= 0; i--) {
          if (counts[i].cyan - baseline >= final * 0.8)
            visibleAt = counts[i].atMs;
          else break;
        }
      }
      stop.renderedVisibleAtMs = visibleAt;
      console.log(
        `  ${pass.name} ${stop.stop.padEnd(22)} on screen ${stop.onScreen ?? '-'}  marker px ${final}  visible at ${visibleAt ?? '-'} ms (state ${stop.timeToCamerasMs} ms)  end-of-hold px ${stop.staleFrame?.shown} / forced ${stop.staleFrame?.forced}`,
      );
    }
  }

  // Aggregate and assert.
  const aggregate = (pass, phase) => {
    const frames = pass.stops.map((s) => s[phase]);
    const weighted = (key) => {
      const total = frames.reduce((n, f) => n + (f.frames || 0), 0);
      return (
        Math.round(
          (frames.reduce((n, f) => n + (f[key] || 0) * (f.frames || 0), 0) /
            Math.max(1, total)) *
            10,
        ) / 10
      );
    };
    return {
      frameP50: weighted('frameP50'),
      frameP95: weighted('frameP95'),
      renderP50: weighted('renderP50'),
      renderP95: weighted('renderP95'),
      longFrames: frames.reduce((n, f) => n + f.longFrames, 0),
    };
  };
  result.summary = result.passes.map((pass) => ({
    pass: pass.name,
    moving: aggregate(pass, 'moving'),
    holding: aggregate(pass, 'holding'),
  }));
  console.table(
    result.summary.map((s) => ({
      pass: s.pass,
      'move p50/p95': `${s.moving.frameP50}/${s.moving.frameP95}`,
      'hold p50/p95': `${s.holding.frameP50}/${s.holding.frameP95}`,
      'render hold p50/p95': `${s.holding.renderP50}/${s.holding.renderP95}`,
      'long frames': s.moving.longFrames + s.holding.longFrames,
    })),
  );
  if (assertOn) {
    const off = result.summary.find((s) => s.pass.includes('off'));
    const warm = result.summary.find((s) => s.pass.endsWith('warm'));
    const warmPass = result.passes.find((p) => p.name.endsWith('warm'));
    const onPasses = result.passes.filter((p) => p.alpr);
    if (off && warm) {
      for (const phase of ['moving', 'holding'])
        for (const key of ['frameP50', 'frameP95'])
          if (warm[phase][key] > off[phase][key] * 1.1 + 2)
            fail(
              `${phase} ${key} ${warm[phase][key]} ms with ALPR vs ${off[phase][key]} ms without`,
            );
    }
    for (const stop of warmPass?.stops || []) {
      if (
        stop.scale !== 'city' &&
        !(
          stop.timeToCamerasMs !== null &&
          stop.timeToCamerasMs <= 2000 &&
          stop.cameras > 0
        )
      )
        fail(
          `${stop.stop}: cameras after ${stop.timeToCamerasMs} ms (${stop.cameras}) on the warm pass`,
        );
    }
    for (const pass of onPasses)
      for (const stop of pass.stops) {
        if (stop.staleFrame?.stale)
          fail(
            `${pass.name} ${stop.stop}: screen showed ${stop.staleFrame.shown} marker px, ${stop.staleFrame.forced} after forcing a render`,
          );
        // Cameras on screen must be painted, and painted when state says so.
        if (stop.onScreen > 0 && stop.renderedMarkerPixels < MIN_MARKER_PIXELS)
          fail(
            `${pass.name} ${stop.stop}: ${stop.onScreen} cameras on screen but no markers rendered`,
          );
        if (
          stop.renderedVisibleAtMs !== null &&
          stop.renderedVisibleAtMs > stop.timeToCamerasMs + 700
        )
          fail(
            `${pass.name} ${stop.stop}: markers rendered ${stop.renderedVisibleAtMs} ms after the stop, ${stop.timeToCamerasMs} ms after state`,
          );
        if (
          pass.name.endsWith('warm') &&
          stop.scale !== 'city' &&
          stop.renderedVisibleAtMs !== null &&
          stop.renderedVisibleAtMs > 2000
        )
          fail(
            `${pass.name} ${stop.stop}: markers visible only after ${stop.renderedVisibleAtMs} ms`,
          );
        if (
          stop.cameras > 0 &&
          stop.onScreen === 0 &&
          !/none on screen/i.test(stop.label)
        )
          fail(
            `${pass.name} ${stop.stop}: no camera on screen and no explicit state`,
          );
        if (stop.loadingAtHoldEnd)
          fail(`${pass.name} ${stop.stop}: still loading when the hold ended`);
        if (
          stop.scale === 'city' &&
          !(stop.cameras > 0 || /zoom in/i.test(stop.label))
        )
          fail(
            `${pass.name} ${stop.stop}: neither cameras nor a zoom-in prompt`,
          );
        if (stop.visualChanges > 1 || stop.lateChanges > 0)
          fail(
            `${pass.name} ${stop.stop}: ${stop.visualChanges} marker changes (${stop.lateChanges} after 3 s) while the camera was still`,
          );
      }
    const errors = result.consoleErrors.filter(
      (text) => !/favicon/i.test(text),
    );
    if (errors.length)
      fail(`console errors: ${errors.slice(0, 3).join(' | ')}`);
  }
} catch (error) {
  fail(error.stack || error.message);
} finally {
  fs.writeFileSync(
    path.join(outDir, 'result.json'),
    JSON.stringify(result, null, 1),
  );
  await browser.close();
}
console.log(
  `${result.failures.length ? 'FAIL' : 'PASS'} — ${path.join(outDir, 'result.json')}`,
);
process.exit(result.failures.length ? 1 : 0);
