#!/usr/bin/env node
/**
 * qa-admin-outlines.mjs — bundled state/province/county outlines, driven like a
 * user would drive them.
 *
 * Run: node scripts/qa-admin-outlines.mjs http://localhost:4173 [--headful] [--no-video]
 *
 * Journey: frame Texas at state scale and outline "Texas"; pan and zoom toward
 * Austin in smooth 2–3 s moves; outline "Travis County, Texas"; pan north and
 * outline the neighbouring "Williamson County, Texas"; zoom out to see both;
 * then outline "Bavaria" (framed, as a voice request for a distant place is),
 * and finally Brandenburg (Berlin is a hole) and Hawaii (eight islands).
 *
 * Asserts for every outline: it resolves from the bundled packs (no geocode,
 * boundary or Overpass request), is drawn as a draped outline within the
 * budget, and holds still — no rebuilt primitives and no new entities while
 * the camera is still. The whole journey must log zero console/page errors and
 * send zero requests to any Overpass host or nominatim.openstreetmap.org.
 *
 * Evidence in qa-shots/ (gitignored): admin-outlines-<step>.png screenshots,
 * admin-outlines-journey.mp4 (CDP screencast at ~24 fps, frames re-timed from
 * their capture timestamps), and admin-outlines-result.json with per-step
 * timings, frame-time p50/p95 and still-camera frame-difference statistics.
 * Exits nonzero on any failed assertion.
 */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import puppeteer from 'puppeteer';
import sharp from 'sharp';

const args = process.argv.slice(2);
if (args.includes('--help')) {
  console.log(
    'Usage: node scripts/qa-admin-outlines.mjs <dev-server-url> [--headful] [--no-video]',
  );
  process.exit(0);
}
const url = args.find((arg) => !arg.startsWith('--'));
if (!url || !['http:', 'https:'].includes(new URL(url).protocol))
  throw new Error('Supply a running dev server URL; see --help');
const recordVideo = !args.includes('--no-video');
const shots = path.resolve('qa-shots');
const framesDir = path.join(shots, 'admin-outlines-frames');
await fs.mkdir(shots, { recursive: true });
await fs.rm(framesDir, { recursive: true, force: true });
await fs.mkdir(framesDir, { recursive: true });

const OUTLINE_BUDGET_MS = 1500;
const STILL_MS = 3000;
const FRAME_INTERVAL_S = 1 / 24;

const result = {
  url,
  steps: [],
  forbiddenRequests: [],
  lookups: [],
  packRequests: [],
  consoleErrors: [],
  pageErrors: [],
  screenshots: [],
  video: null,
};

const browser = await puppeteer.launch({
  headless: !args.includes('--headful'),
  protocolTimeout: 300_000,
  args: [
    '--no-sandbox',
    '--use-gl=angle',
    '--disable-dev-shm-usage',
    '--disable-background-timer-throttling',
    '--disable-renderer-backgrounding',
  ],
});

let page;
const frames = [];
let lastKept = -Infinity;
let recording = false;
let marker = 'startup';

try {
  page = await browser.newPage();
  await page.evaluateOnNewDocument(() => {
    sessionStorage.setItem('gev:first-run-mission-session:v1', 'dismissed');
  });
  await page.setViewport({ width: 1280, height: 800 });
  const client = await page.createCDPSession();
  await client.send('Network.enable');
  client.on('Network.requestWillBeSent', ({ request }) => {
    const target = new URL(request.url);
    const where = `${request.method} ${target.origin}${target.pathname}`;
    if (
      target.hostname.includes('overpass') ||
      target.hostname === 'nominatim.openstreetmap.org'
    )
      result.forbiddenRequests.push({ step: marker, request: where });
    // Lookups an outline could make: a forward geocode, a place search, an
    // Overpass boundary query. The HUD's reverse geocode of the camera centre
    // (latlng=) is not one of them.
    const local = target.origin === new URL(url).origin;
    const reverse = target.searchParams.has('latlng');
    const lookup =
      !reverse &&
      ((local &&
        /^\/api\/(overpass|geocode|google\/text-search|nominatim|photon)/.test(
          target.pathname,
        )) ||
        (target.hostname === 'maps.googleapis.com' &&
          target.pathname.includes('/geocode/')) ||
        target.hostname === 'photon.komoot.io');
    if (lookup) result.lookups.push({ step: marker, request: where });
    if (/\/(states_provinces|countries|counties)\.json$/.test(target.pathname))
      result.packRequests.push({ step: marker, pack: target.pathname });
  });
  page.on('pageerror', (error) =>
    result.pageErrors.push({ step: marker, message: error.message }),
  );
  page.on('console', (message) => {
    if (message.type() === 'error')
      result.consoleErrors.push({ step: marker, message: message.text() });
  });

  client.on('Page.screencastFrame', async ({ data, metadata, sessionId }) => {
    client.send('Page.screencastFrameAck', { sessionId }).catch(() => {});
    if (!recording) return;
    const t = metadata.timestamp;
    if (t - lastKept < FRAME_INTERVAL_S * 0.9) return;
    lastKept = t;
    const file = path.join(
      framesDir,
      `${String(frames.length).padStart(6, '0')}.jpg`,
    );
    frames.push({ file, t, step: marker });
    await fs.writeFile(file, Buffer.from(data, 'base64'));
  });

  console.log('Loading viewer...');
  const navigationUrl = new URL(url);
  navigationUrl.searchParams.set('welcome', '0');
  await page.goto(navigationUrl.href, {
    waitUntil: 'domcontentloaded',
    timeout: 60_000,
  });
  await page.waitForFunction(
    () => window.__godsEyeView?.viewer && window.__godsEyeView?.annotations,
    { timeout: 90_000, polling: 500 },
  );
  await page.waitForFunction(
    () =>
      document.getElementById('loading-screen')?.classList.contains('hidden'),
    { timeout: 90_000, polling: 250 },
  );
  await page.evaluate(
    () => window.__godsEyeView.styleManager.initialRestorePromise,
  );
  await page.keyboard.press('Escape');
  await page.waitForFunction(
    () => !document.querySelector('#first-run-launcher:not([hidden])'),
    { timeout: 10_000 },
  );
  result.renderer = await page.evaluate(() => {
    const gl = window.__godsEyeView.viewer.scene.context._gl;
    const debug = gl.getExtension('WEBGL_debug_renderer_info');
    return debug
      ? gl.getParameter(debug.UNMASKED_RENDERER_WEBGL)
      : gl.getParameter(gl.RENDERER);
  });
  console.log('Renderer:', result.renderer);

  // In-page helpers: camera moves, frame timing and annotation state.
  await page.evaluate(() => {
    const { viewer } = window.__godsEyeView;
    const Cesium = window.__CESIUM__;
    window.__qaOutlines = {
      fly(view, duration) {
        return new Promise((resolve) => {
          viewer.camera.cancelFlight();
          viewer.camera.flyTo({
            destination: Cesium.Cartesian3.fromDegrees(
              view.lon,
              view.lat,
              view.height,
            ),
            orientation: {
              heading: Cesium.Math.toRadians(view.heading ?? 0),
              pitch: Cesium.Math.toRadians(view.pitch ?? -70),
              roll: 0,
            },
            duration,
            easingFunction: Cesium.EasingFunction.QUADRATIC_IN_OUT,
            complete: resolve,
            cancel: resolve,
          });
        });
      },
      frameTimes(ms) {
        return new Promise((resolve) => {
          const deltas = [];
          let last = performance.now();
          const end = last + ms;
          const step = (now) => {
            deltas.push(now - last);
            last = now;
            if (now < end) requestAnimationFrame(step);
            else resolve(deltas.slice(1));
          };
          requestAnimationFrame(step);
        });
      },
      annotationSource() {
        for (let i = 0; i < viewer.dataSources.length; i++) {
          const source = viewer.dataSources.get(i);
          if (source.name === 'gev-annotations') return source;
        }
        return null;
      },
      groundPrimitives() {
        const list = [];
        const walk = (collection) => {
          for (let i = 0; i < collection.length; i++) {
            const item = collection.get(i);
            if (item?.length !== undefined && typeof item.get === 'function')
              walk(item);
            else list.push(item);
          }
        };
        walk(viewer.scene.groundPrimitives);
        return list;
      },
      snapshot() {
        const source = this.annotationSource();
        const entities = source ? source.entities.values : [];
        const primitives = this.groundPrimitives();
        window.__qaPrimitiveIds ??= new WeakMap();
        let next = window.__qaPrimitiveNext ?? 1;
        const ids = primitives.map((primitive) => {
          if (!window.__qaPrimitiveIds.has(primitive))
            window.__qaPrimitiveIds.set(primitive, next++);
          return window.__qaPrimitiveIds.get(primitive);
        });
        window.__qaPrimitiveNext = next;
        return {
          entities: entities.length,
          polygons: entities.filter((e) => e.polygon).length,
          polylines: entities.filter((e) => e.polyline).length,
          draped:
            entities.every(
              (e) =>
                !e.polygon ||
                e.polygon.classificationType?.getValue() ===
                  Cesium.ClassificationType.BOTH,
            ) &&
            entities.every(
              (e) => !e.polyline || e.polyline.clampToGround?.getValue(),
            ),
          primitiveIds: ids,
          ready: viewer.dataSourceDisplay.ready,
        };
      },
    };
  });

  const settle = () =>
    page
      .waitForFunction(
        () => {
          const { scene } = window.__godsEyeView.viewer;
          for (let i = 0; i < scene.primitives.length; i++) {
            const p = scene.primitives.get(i);
            if (p?.show && typeof p.tilesLoaded === 'boolean' && !p.tilesLoaded)
              return false;
          }
          return true;
        },
        { timeout: 60_000, polling: 500 },
      )
      .catch(() => {});

  async function shot(name) {
    await page.evaluate(
      () =>
        new Promise((resolve) =>
          requestAnimationFrame(() => requestAnimationFrame(resolve)),
        ),
    );
    const filename = `admin-outlines-${name}.png`;
    await page.screenshot({ path: path.join(shots, filename) });
    result.screenshots.push(filename);
  }

  async function move(name, view, duration = 2.5) {
    marker = `move:${name}`;
    const [, times] = await Promise.all([
      page.evaluate((v, d) => window.__qaOutlines.fly(v, d), view, duration),
      page.evaluate((ms) => window.__qaOutlines.frameTimes(ms), duration * 900),
    ]);
    result.steps.push({ step: `move:${name}`, frameTimes: stats(times) });
  }

  /** Annotate like the voice tool does, then watch the mark while still. */
  async function outline(name, target, { flyTo = false } = {}) {
    marker = `outline:${name}`;
    const lookupsBefore = result.lookups.length;
    const errorsBefore = result.consoleErrors.length + result.pageErrors.length;
    const timing = await page.evaluate(
      async (target, flyTo) => {
        const started = performance.now();
        const response = await window.__godsEyeView.annotations.annotate(
          [{ type: 'area', target, label: target, footprint: true }],
          { flyTo },
        );
        const resolvedMs = performance.now() - started;
        // "Drawn" = the first rendered frame after the entity visualizers have
        // built the mark's primitives (each tick updates them before render).
        const { viewer } = window.__godsEyeView;
        await new Promise((resolve) => {
          const off = viewer.scene.postRender.addEventListener(() => {
            if (!viewer.dataSourceDisplay.ready) return;
            off();
            resolve();
          });
        });
        const drawnMs = performance.now() - started;
        const mark = window.__godsEyeView.annotations
          .list()
          .find((m) => m.id === response.ids?.[0]);
        return {
          response: response.results?.[0] ?? null,
          resolvedMs,
          drawnMs,
          parts: mark?.polygons?.length ?? (mark?.ring ? 1 : 0),
          holes: (mark?.polygons ?? []).reduce(
            (n, part) => n + part.length - 1,
            0,
          ),
          ringVertices: mark?.ring?.length ?? 0,
          pending: Boolean(mark?.pendingOutline),
        };
      },
      target,
      flyTo,
    );
    if (flyTo) await new Promise((r) => setTimeout(r, 2200));
    await settle();
    // Hold still: the drawn mark must not rebuild or grow.
    marker = `still:${name}`;
    const before = await page.evaluate(() => window.__qaOutlines.snapshot());
    const stillStart = frames.length;
    const times = await page.evaluate(
      (ms) => window.__qaOutlines.frameTimes(ms),
      STILL_MS,
    );
    const after = await page.evaluate(() => window.__qaOutlines.snapshot());
    const step = {
      step: `outline:${name}`,
      target,
      ...timing,
      entities: after.entities,
      polygons: after.polygons,
      polylines: after.polylines,
      draped: after.draped,
      stableWhileStill:
        before.entities === after.entities &&
        JSON.stringify(before.primitiveIds) ===
          JSON.stringify(after.primitiveIds),
      stillFrameTimes: stats(times),
      stillFrames: [stillStart, frames.length],
      lookups: result.lookups.slice(lookupsBefore),
      errors:
        result.consoleErrors.length + result.pageErrors.length - errorsBefore,
    };
    result.steps.push(step);
    console.log(
      `${name}: resolved ${timing.resolvedMs.toFixed(0)} ms, drawn ${timing.drawnMs.toFixed(0)} ms, ` +
        `${timing.parts} part(s), ${timing.holes} hole(s), via ${timing.response?.resolvedVia}; ` +
        `still p50/p95 ${step.stillFrameTimes.p50}/${step.stillFrameTimes.p95} ms; ` +
        `stable=${step.stableWhileStill}`,
    );
    assert.equal(timing.response?.ok, true, `${name}: annotation drawn`);
    assert.equal(timing.response.outline, true, `${name}: outline, not a pin`);
    assert.equal(timing.response.resolvedVia, 'bundled', `${name}: bundled`);
    assert.equal(timing.pending, false, `${name}: nothing pending`);
    assert.ok(
      timing.drawnMs < OUTLINE_BUDGET_MS,
      `${name}: drawn in ${timing.drawnMs} ms`,
    );
    assert.equal(step.draped, true, `${name}: draped on terrain/tiles`);
    assert.equal(step.stableWhileStill, true, `${name}: no redraw when still`);
    assert.deepEqual(step.lookups, [], `${name}: no network lookups`);
    assert.equal(step.errors, 0, `${name}: no console errors`);
    return step;
  }

  // Start from a clean board and the default layers, as a user would.
  await page.evaluate(() => window.__godsEyeView.annotations.clear?.());
  await page.evaluate(() =>
    window.__qaOutlines.fly(
      { lat: 25.5, lon: -99.6, height: 2_600_000, pitch: -80 },
      0,
    ),
  );
  await settle();
  if (recordVideo) {
    await client.send('Page.startScreencast', {
      format: 'jpeg',
      quality: 72,
      maxWidth: 1280,
      maxHeight: 800,
      everyNthFrame: 1,
    });
    recording = true;
  }

  await outline('texas', 'Texas');
  await shot('texas');
  await move('pan-west', {
    lat: 25.2,
    lon: -101.5,
    height: 2_300_000,
    pitch: -75,
  });
  await move('zoom-central-texas', {
    lat: 28.8,
    lon: -98.2,
    height: 700_000,
    pitch: -65,
  });
  await move('zoom-austin', {
    lat: 29.75,
    lon: -97.8,
    height: 120_000,
    pitch: -55,
  });
  await settle();
  await outline('travis', 'Travis County, Texas');
  await shot('travis');
  await move('pan-williamson', {
    lat: 30.05,
    lon: -97.65,
    height: 110_000,
    pitch: -55,
  });
  await settle();
  await outline('williamson', 'Williamson County, Texas');
  // Close over the shared Travis/Williamson line near Pflugerville: the
  // outline must lie on the photoreal mesh, not float above or sink into it.
  const border = await page.evaluate(() => {
    const travis = window.__godsEyeView.annotations
      .list()
      .find((m) => m.label === 'Travis County, Texas');
    let best = null;
    for (const [lon, lat] of travis.ring) {
      const d = (lat - 30.46) ** 2 + (lon + 97.62) ** 2;
      if (!best || d < best.d) best = { lon, lat, d };
    }
    return best;
  });
  await move(
    'drape-close',
    { lat: border.lat - 0.035, lon: border.lon, height: 2500, pitch: -40 },
    3,
  );
  await settle();
  await page.evaluate((ms) => new Promise((r) => setTimeout(r, ms)), 2500);
  await shot('drape-close');
  await move('zoom-out-both', {
    lat: 29.55,
    lon: -97.7,
    height: 260_000,
    pitch: -60,
  });
  await settle();
  await page.evaluate((ms) => new Promise((r) => setTimeout(r, ms)), 1500);
  await shot('both-counties');
  await outline('bavaria', 'Bavaria', { flyTo: true });
  await shot('bavaria');
  await move(
    'orbit-bavaria',
    { lat: 46.6, lon: 11.9, height: 650_000, heading: 20, pitch: -55 },
    3,
  );
  await settle();
  await shot('bavaria-orbit');
  // A hole (Berlin inside Brandenburg) and islands (Hawaii) draw as such.
  const brandenburg = await outline('brandenburg', 'Brandenburg', {
    flyTo: true,
  });
  assert.ok(brandenburg.holes >= 1, 'Brandenburg keeps the Berlin hole');
  await shot('brandenburg');
  const hawaii = await outline('hawaii', 'Hawaii', { flyTo: true });
  assert.ok(hawaii.parts >= 7, 'Hawaii keeps its islands');
  await shot('hawaii');
  marker = 'end';

  for (const [name, target, lat, lon, height] of [
    ['scotland', 'Scotland', 57, -4, 800000],
    ['england', 'England', 52.5, -1.5, 800000],
    ['wales', 'Wales', 52.3, -3.7, 420000],
    ['northern-ireland', 'Northern Ireland', 54.7, -6.7, 300000],
    ['switzerland', 'Switzerland', 46.8, 8.2, 500000],
    ['iran', 'Iran', 32, 54, 2200000],
    ['france', 'France', 46.6, 2.2, 1600000],
    ['japan', 'Japan', 37, 138, 2200000],
    ['georgia-state', 'Georgia', 32.6, -83.4, 650000],
    ['georgia-country', 'Georgia', 42, 43.6, 700000],
    ['georgia-qualified', 'the country of Georgia', 42, 43.6, 700000],
  ]) {
    await page.evaluate(() => window.__godsEyeView.annotations.clear());
    await move(name, { lat, lon, height, pitch: -90 }, 1);
    await outline(name, target);
    await shot(name);
    const rendered = await page.evaluate(() => window.__qaOutlines.snapshot());
    assert.ok(rendered.polygons > 0, `${target} polygon renders`);
  }

  if (recordVideo) {
    recording = false;
    await client.send('Page.stopScreencast');
  }
  result.totals = {
    forbiddenRequests: result.forbiddenRequests.length,
    consoleErrors: result.consoleErrors.length,
    pageErrors: result.pageErrors.length,
  };
  assert.deepEqual(
    result.forbiddenRequests,
    [],
    'no Overpass or nominatim.openstreetmap.org requests',
  );
  // The packs load on the first outline that needs them, never at start-up.
  assert.deepEqual(
    result.packRequests.map((r) => [r.step, path.basename(r.pack)]),
    [
      ['outline:texas', 'states_provinces.json'],
      ['outline:travis', 'counties.json'],
      ['outline:scotland', 'countries.json'],
    ],
    'packs load lazily, once each',
  );
  assert.deepEqual(result.pageErrors, [], 'no page errors');
  assert.deepEqual(result.consoleErrors, [], 'no console errors');
} catch (error) {
  result.failure = error.message;
  console.error(error);
  process.exitCode = 1;
  if (page)
    await page
      .screenshot({ path: path.join(shots, 'admin-outlines-failure.png') })
      .catch(() => {});
} finally {
  await browser.close();
}

if (recordVideo && frames.length > 1) {
  // Frame-to-frame change while the camera is still: steady pulses read as
  // small, even values; a flicker (a part vanishing and returning) as a spike.
  for (const step of result.steps.filter((s) => s.stillFrames)) {
    const [start, end] = step.stillFrames;
    const diffs = [];
    let previous = null;
    for (const frame of frames.slice(start, end)) {
      const pixels = await sharp(frame.file)
        .resize(160, 100, { fit: 'fill' })
        .greyscale()
        .raw()
        .toBuffer();
      if (previous) {
        let sum = 0;
        let max = 0;
        for (let i = 0; i < pixels.length; i++) {
          const d = Math.abs(pixels[i] - previous[i]);
          sum += d;
          if (d > max) max = d;
        }
        diffs.push(sum / pixels.length);
      }
      previous = pixels;
    }
    step.stillFrameDiff = {
      frames: end - start,
      meanAbsDiff: stats(diffs, 3),
    };
  }
  const list = [];
  for (let i = 0; i < frames.length; i++) {
    const duration =
      i + 1 < frames.length ? frames[i + 1].t - frames[i].t : FRAME_INTERVAL_S;
    list.push(`file '${frames[i].file}'`, `duration ${duration.toFixed(4)}`);
  }
  list.push(`file '${frames.at(-1).file}'`);
  const listFile = path.join(framesDir, 'frames.txt');
  await fs.writeFile(listFile, list.join('\n') + '\n');
  const video = path.join(shots, 'admin-outlines-journey.mp4');
  execFileSync('ffmpeg', [
    '-y',
    '-loglevel',
    'error',
    '-f',
    'concat',
    '-safe',
    '0',
    '-i',
    listFile,
    '-vf',
    'fps=24,format=yuv420p',
    '-c:v',
    'libx264',
    '-crf',
    '23',
    video,
  ]);
  const span = frames.at(-1).t - frames[0].t;
  result.video = {
    file: path.relative(process.cwd(), video),
    frames: frames.length,
    seconds: Number(span.toFixed(1)),
    capturedFps: Number(((frames.length - 1) / span).toFixed(1)),
  };
  console.log('Video:', result.video);
  await fs.rm(framesDir, { recursive: true, force: true });
}

await fs.writeFile(
  path.join(shots, 'admin-outlines-result.json'),
  JSON.stringify(result, null, 2),
);
console.table(
  result.steps.map((s) => ({
    step: s.step,
    resolvedMs: s.resolvedMs?.toFixed(0),
    drawnMs: s.drawnMs?.toFixed(0),
    parts: s.parts,
    stable: s.stableWhileStill,
    p50: (s.stillFrameTimes || s.frameTimes)?.p50,
    p95: (s.stillFrameTimes || s.frameTimes)?.p95,
    stillDiffP95: s.stillFrameDiff?.meanAbsDiff.p95,
    stillDiffMax: s.stillFrameDiff?.meanAbsDiff.max,
  })),
);
console.log(process.exitCode ? 'FAILED' : 'PASSED');

function stats(values, digits = 1) {
  if (!values.length) return { n: 0 };
  const sorted = [...values].sort((a, b) => a - b);
  const at = (q) =>
    Number(
      sorted[
        Math.min(sorted.length - 1, Math.floor(q * sorted.length))
      ].toFixed(digits),
    );
  return { n: values.length, p50: at(0.5), p95: at(0.95), max: at(1) };
}
