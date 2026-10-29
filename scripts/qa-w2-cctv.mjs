#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createHash } from 'node:crypto';
import puppeteer from 'puppeteer';
import sharp from 'sharp';
import { installCctvFixture } from './fixtures/w2/cctv.mjs';
import { watchW1Page, redact } from './qa-browserEvidence.mjs';
import { computeFrustumGeometry } from '../src/data/cctv.js';
import { blockPaidQaMaps } from './qa-map-policy.mjs';

const args = process.argv.slice(2);
const option = (name) =>
  args.includes(name) ? args[args.indexOf(name) + 1] : null;
const url = option('--url');
const output = option('--report');
if (!url || !output)
  throw new Error('Explicit --url and --report are required');
const mapPolicy = { allowPaidMaps: args.includes('--allow-paid-maps') };
if (
  ['4173', '4185', '4186', '4187', '4188', '4189', '4194'].includes(
    new URL(url).port,
  )
)
  throw new Error('CCTV QA may not use a reserved port');
const shots = path.resolve(output.replace(/\.json$/, '-shots'));
fs.mkdirSync(shots, { recursive: true });
const report = {
  engine: new URL(url).searchParams.get('engine') || 'cesium',
  checks: [],
  poses: {},
  browserErrors: [],
  pass: false,
};
const check = (name, actual, expected = true) => {
  const pass = JSON.stringify(actual) === JSON.stringify(expected);
  report.checks.push({ name, actual, expected, pass });
  console.log(`[${pass ? 'PASS' : 'FAIL'}] ${name}`);
};
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
let browser;
let page;
let fixture;
async function frames(count = 4) {
  await page.evaluate(
    (count) =>
      new Promise((resolve, reject) => {
        const engine = window.__godsEyeView.engine;
        const timer = setTimeout(() => {
          remove();
          reject(new Error('CCTV frame deadline'));
        }, 10000);
        const remove = engine.frames.postRender.addEventListener(() => {
          if (--count <= 0) {
            remove();
            clearTimeout(timer);
            resolve();
          } else
            requestAnimationFrame(() => engine.render.request('cctv-qa-frame'));
        });
        engine.render.request('cctv-qa-frame');
      }),
    count,
  );
}
async function enabled(value) {
  await page.evaluate(
    (value) =>
      window.__godsEyeView.dataManager.setEnabled('cctv', value, {
        origin: 'user',
      }),
    value,
  );
  if (value)
    await page.waitForFunction(
      () =>
        !window.__godsEyeView.dataManager.layers.get('cctv').module.getStats()
          .loading,
      { timeout: 90000 },
    );
  await frames();
}
async function params(value) {
  await page.evaluate(
    (value) =>
      window.__godsEyeView.dataManager.layers
        .get('cctv')
        .module.setParams(value),
    value,
  );
}
async function view(height) {
  await page.evaluate(async (height) => {
    const geo = await import('/src/geo/index.js');
    const engine = window.__godsEyeView.engine;
    engine.camera.cancelFlight();
    engine.camera.setView({
      destination: geo.cartesian3.fromDegrees(-97.7431, 30.2672, height),
      orientation: { heading: 0, pitch: -Math.PI / 2, roll: 0 },
    });
  }, height);
  await sleep(800);
  await page.waitForFunction(
    () => window.__godsEyeView.engine.surface.tilesLoaded(),
    { timeout: 90000 },
  );
  await frames();
}
async function snapshot() {
  return page.evaluate(() => {
    const app = window.__godsEyeView;
    const layer = app.dataManager.layers.get('cctv').module;
    const state = layer.getUIState();
    const controls = [];
    for (const object of layer
      .getDetectableObjects()
      .sort((a, b) => a.sourceId.localeCompare(b.sourceId))) {
      if (object.sourceId === state.activeCameraId) continue;
      const p = app.engine.projector.worldToWindow(object.position);
      if (
        !p ||
        !app.engine.projector.horizonVisible(object.position) ||
        p.x < 400 ||
        p.x > 1000 ||
        p.y < 180 ||
        p.y > 720
      )
        continue;
      if (controls.some((c) => Math.hypot(c.x - p.x, c.y - p.y) < 45)) continue;
      const picked = app.engine.picker.pick(p);
      const id = typeof picked?.id === 'string' ? picked.id : picked?.id?.id;
      if (id !== object.sourceId) continue;
      controls.push({ id, x: p.x, y: p.y });
      if (controls.length === 5) break;
    }
    return {
      cameras: state.cameras.map(({ frameUrl, mediaUrl, ...camera }) => camera),
      activeCameraId: state.activeCameraId,
      controls,
    };
  });
}
async function imageData(buffer) {
  return sharp(buffer)
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
}
function countPixels(data, point, predicate, radius = 16) {
  let count = 0;
  for (
    let y = Math.max(0, Math.floor(point.y) - radius);
    y <= Math.min(data.info.height - 1, point.y + radius);
    y++
  )
    for (
      let x = Math.max(0, Math.floor(point.x) - radius);
      x <= Math.min(data.info.width - 1, point.x + radius);
      x++
    ) {
      const at = (y * data.info.width + x) * 4;
      if (predicate(...data.data.subarray(at, at + 3))) count++;
    }
  return count;
}
function changedPlanePixels(before, after, projection) {
  const { center, corners } = projection;
  if (!center || corners.some((p) => !p)) return { changed: 0, sampled: 0 };
  const quad = corners.map((p) => ({
    x: center.x + (p.x - center.x) * 0.9,
    y: center.y + (p.y - center.y) * 0.9,
  }));
  let changed = 0,
    sampled = 0;
  const left = Math.max(0, Math.floor(Math.min(...quad.map((p) => p.x)))),
    right = Math.min(
      before.info.width,
      Math.ceil(Math.max(...quad.map((p) => p.x))),
    ),
    top = Math.max(0, Math.floor(Math.min(...quad.map((p) => p.y)))),
    bottom = Math.min(
      before.info.height,
      Math.ceil(Math.max(...quad.map((p) => p.y))),
    );
  for (let y = top; y < bottom; y++)
    for (let x = left; x < right; x++) {
      const cross = quad.map((a, i) => {
        const b = quad[(i + 1) % 4];
        return (b.x - a.x) * (y - a.y) - (b.y - a.y) * (x - a.x);
      });
      if (!cross.every((v) => v >= 0) && !cross.every((v) => v <= 0)) continue;
      sampled++;
      const at = (y * before.info.width + x) * 4;
      if (
        [0, 1, 2].some(
          (c) => Math.abs(before.data[at + c] - after.data[at + c]) > 25,
        )
      )
        changed++;
    }
  return { changed, sampled };
}
async function mediaPose(id) {
  await params({
    selectedCameraId: id,
    showProjection: true,
    coverageMode: 'on',
    calibration: {
      patch: { heightM: 180, pitchDeg: 34, rangeScale: 0.6, fovDeg: -14 },
    },
  });
  await params({ focusSelected: true, focusDurationSec: 0.2 });
  await sleep(1800);
  await page.waitForFunction(
    () => window.__godsEyeView.engine.surface.tilesLoaded(),
    { timeout: 90000 },
  );
  await frames();
  const camera = await page.evaluate(
    () =>
      window.__godsEyeView.dataManager.layers.get('cctv').module.getUIState()
        .activeCamera,
  );
  const geometry = computeFrustumGeometry(
    camera,
    camera.elevationM - camera.mountHeightM,
  );
  const projection = await page.evaluate(async (geometry) => {
    const geo = await import('/src/geo/index.js');
    const engine = window.__godsEyeView.engine;
    const points = Object.fromEntries(
      Object.entries(geometry.corners).map(([key, p]) => [
        key,
        geo.cartesian3.fromDegrees(p.lon, p.lat, p.alt),
      ]),
    );
    const project = (u, v) => {
      const p = {};
      for (const axis of ['x', 'y', 'z'])
        p[axis] =
          points.tl[axis] * (1 - u) * (1 - v) +
          points.tr[axis] * u * (1 - v) +
          points.bl[axis] * (1 - u) * v +
          points.br[axis] * u * v;
      const screen = engine.projector.worldToWindow(p);
      return screen ? { x: screen.x, y: screen.y } : null;
    };
    return {
      corners: [project(0, 0), project(1, 0), project(1, 1), project(0, 1)],
      quadrants: [
        project(0.25, 0.25),
        project(0.75, 0.25),
        project(0.25, 0.75),
        project(0.75, 0.75),
      ],
      center: project(0.5, 0.5),
    };
  }, geometry);
  return { id, geometry, projection };
}
async function idle(name) {
  await sleep(5000);
  const result = await page.evaluate(async () => {
    const { getRenderGovernorDiagnostics } =
      await import('/src/renderGovernor.js');
    const engine = window.__godsEyeView.engine;
    let count = 0;
    const remove = engine.frames.postRender.addEventListener(() => count++);
    // Span two catalog/health ticks so unchanged panel notifications cannot
    // evade the idle gate merely by landing outside a short sample.
    await new Promise((resolve) => setTimeout(resolve, 22000));
    remove();
    return { frames: count, governor: getRenderGovernorDiagnostics() };
  });
  report[name] = result;
  check(`${name}: zero frames over 22s`, result.frames, 0);
}
try {
  // Generate real decoded media before launching the browser. No play stub or
  // synthetic readiness flags; both engines consume these identical bytes.
  const videoPath = path.join(shots, 'fixture.mp4');
  const ffmpegArgs = [
    '-hide_banner',
    '-loglevel',
    'error',
    '-f',
    'lavfi',
    '-i',
    'testsrc2=size=320x180:rate=12',
    '-t',
    '4',
    '-an',
    '-c:v',
    'libx264',
    '-pix_fmt',
    'yuv420p',
    '-preset',
    'ultrafast',
    '-crf',
    '18',
    '-movflags',
    '+faststart',
    '-threads',
    '1',
    '-y',
    videoPath,
  ];
  await promisify(execFile)('ffmpeg', ffmpegArgs);
  const video = fs.readFileSync(videoPath);
  report.videoFixture = {
    bytes: video.length,
    sha256: createHash('sha256').update(video).digest('hex'),
    generation: ffmpegArgs.slice(0, -1),
  };
  browser = await puppeteer.launch({
    headless: 'new',
    args: ['--use-angle=metal', '--enable-gpu'],
  });
  page = await browser.newPage();
  await blockPaidQaMaps(page, mapPolicy);
  report.browser = await browser.version();
  await page.setViewport({ width: 1440, height: 900 });
  watchW1Page(page, report, {
    name: 'cctv',
    baseUrl: url,
    preview: args.includes('--preview'),
  });
  fixture = await installCctvFixture(page, { video });
  await page.evaluateOnNewDocument(() => {
    localStorage.clear();
    localStorage.setItem('gev:first-run-mission:v1', 'suppressed');
    sessionStorage.setItem('gev:first-run-mission-session:v1', 'dismissed');
  });
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.waitForFunction(
    () =>
      window.__godsEyeView?.dataManager &&
      document.getElementById('loading-screen')?.classList.contains('hidden'),
    { timeout: 60000 },
  );
  await page.evaluate(async () => {
    const app = window.__godsEyeView;
    await app.styleManager.initialRestorePromise;
    app.styleManager.orbitController.stop();
    for (const [id, layer] of app.dataManager.layers)
      if (layer.enabled) await app.dataManager.setEnabled(id, false);
    app.styleManager._setDetectionMode('OFF');
    (await import('/src/time/clock.js')).appClock.freeze(
      Date.parse('2026-10-28T19:00:00Z'),
    );
  });
  for (const [name, height] of [
    ['regional', 4000],
    ['city', 2400],
    ['close', 1400],
  ]) {
    await enabled(false);
    await view(height);
    await enabled(true);
    await params({ showProjection: false, coverageMode: 'off' });
    await sleep(2500);
    await frames();
    const state = await snapshot();
    report.poses[name] = state;
    check(
      `${name}: exact fixture catalog`,
      state.cameras.map(({ id }) => id).sort(),
      fixture.cameras.map(({ id }) => id).sort(),
    );
    check(`${name}: five actual GPU marker picks`, state.controls.length, 5);
    const data = await imageData(
      await page.screenshot({ path: path.join(shots, `${name}.png`) }),
    );
    for (const point of state.controls)
      point.cyanPixels = countPixels(
        data,
        point,
        (r, g, b) => g > 170 && b > 190 && r < 180 && b > r * 1.2,
      );
    check(
      `${name}: five positive marker rasters`,
      state.controls.length === 5 &&
        state.controls.every((p) => p.cyanPixels > 5),
    );
  }
  const target = report.poses.close.controls[2];
  if (!target) throw new Error('No actual pickable CCTV marker');
  await page.mouse.click(target.x, target.y);
  check(
    'physical click selects exact camera',
    await page.evaluate(
      () =>
        window.__godsEyeView.dataManager.layers.get('cctv').module.getUIState()
          .activeCameraId,
    ),
    target.id,
  );
  report.imagePlane = await mediaPose('w2-cctv-012');
  await sleep(2200);
  await frames();
  const still = await imageData(
    await page.screenshot({ path: path.join(shots, 'image-plane.png') }),
  );
  const colors = [
    (r, g, b) => r > 150 && r > g * 1.5 && r > b * 1.4,
    (r, g, b) => g > 150 && g > r * 1.5 && g > b * 1.4,
    (r, g, b) => b > 150 && b > r * 1.5 && b > g * 1.4,
    (r, g, b) => r > 150 && g > 140 && b < 100,
  ];
  report.imagePlane.pixels = report.imagePlane.projection.quadrants.map(
    (p, i) => (p ? countPixels(still, p, colors[i], 8) : 0),
  );
  check(
    'image plane has all four decoded quadrants with correct UV orientation',
    report.imagePlane.pixels.every((n) => n > 10),
  );
  await idle('imageIdle');
  check(
    'visible image plane resolves to its camera',
    await page.evaluate((at) => {
      const app = window.__godsEyeView;
      const layer = app.dataManager.layers.get('cctv').module;
      return layer._extractPickedCameraIdForTest(app.engine.picker.pick(at));
    }, report.imagePlane.projection.quadrants[0]),
    'w2-cctv-012',
  );
  await params({ calibrationMode: true });
  await frames();
  report.calibration = await page.evaluate(async () => {
    const app = window.__godsEyeView;
    const camera = app.dataManager.layers
      .get('cctv')
      .module.getUIState().activeCamera;
    const geo = await import('/src/geo/index.js');
    const mount = geo.cartesian3.fromDegrees(
      camera.lon,
      camera.lat,
      camera.elevationM,
    );
    const enu = geo.transforms.eastNorthUpToFixedFrame(mount);
    const length = Math.min(40, Math.max(6, camera.rangeM * 0.12)) * 1.6;
    const end = {
      x: mount.x + enu[0] * length,
      y: mount.y + enu[1] * length,
      z: mount.z + enu[2] * length,
    };
    const a = app.engine.projector.worldToWindow(mount);
    const b = app.engine.projector.worldToWindow(end);
    const id = 'cctv-gizmo-move-east';
    const picks = [1, 0.8, 0.6, 0.4].map((t) => ({
      x: a.x + (b.x - a.x) * t,
      y: a.y + (b.y - a.y) * t,
    }));
    const at = picks.find((p) => {
      const hit = app.engine.picker.pick(p);
      return (typeof hit?.id === 'string' ? hit.id : hit?.id?.id) === id;
    });
    const count = app.viewer
      ? [
          'ring-heading',
          'ring-pitch',
          'move-east',
          'move-north',
          'move-up',
          'handle-range',
          'handle-fov-l',
          'handle-fov-r',
        ].filter(
          (part) => app.viewer.entities.getById(`cctv-gizmo-${part}`)?.show,
        ).length
      : new Set(
          [
            ...app.engine.lines.list().filter((line) => line.shown),
            ...app.engine.movers.list().filter((set) => set.count > 0),
          ]
            .filter((entry) => entry.id.startsWith('cctv-gizmo-'))
            .map((entry) => entry.id),
        ).size;
    const pixels = Math.hypot(b.x - a.x, b.y - a.y);
    return {
      before: camera,
      count,
      at,
      ux: (b.x - a.x) / pixels,
      uy: (b.y - a.y) / pixels,
      stored: localStorage.getItem('godsEyeView.cctv.calibration.v2'),
    };
  });
  check('all eight calibration handles are shown', report.calibration.count, 8);
  await page.screenshot({ path: path.join(shots, 'calibration.png') });
  check('east handle owns an on-screen pick', Boolean(report.calibration.at));
  if (!report.calibration.at)
    throw new Error('No owned east calibration handle');
  const drag = report.calibration;
  await page.mouse.move(drag.at.x, drag.at.y);
  await page.mouse.down();
  drag.samples = [];
  for (let i = 1; i <= 6; i++) {
    await page.mouse.move(
      drag.at.x + drag.ux * i * 6,
      drag.at.y + drag.uy * i * 6,
    );
    await sleep(40);
    drag.samples.push(
      await page.evaluate(
        () =>
          window.__godsEyeView.dataManager.layers
            .get('cctv')
            .module.getUIState().activeCamera,
      ),
    );
  }
  await page.mouse.up();
  await frames();
  drag.after = await page.evaluate(
    () =>
      window.__godsEyeView.dataManager.layers.get('cctv').module.getUIState()
        .activeCamera,
  );
  check(
    'physical east drag changes the live calibration',
    Math.abs(
      drag.after.calibration.offsetEastM - drag.before.calibration.offsetEastM,
    ) > 0.5,
  );
  check(
    'transient drag preserves the floor and does not sample it',
    drag.samples.every(
      (sample) =>
        sample.elevationM === drag.before.elevationM &&
        sample.groundMeshSampleRequestCount ===
          drag.before.groundMeshSampleRequestCount,
    ),
  );
  check(
    'drag release resolves the committed anchor once',
    drag.after.groundResolveCount,
    drag.before.groundResolveCount + 1,
  );
  check(
    'calibration remains unsaved after drag',
    drag.after.calDirty &&
      (await page.evaluate(
        (stored) =>
          localStorage.getItem('godsEyeView.cctv.calibration.v2') === stored,
        drag.stored,
      )),
  );
  await params({ calibrationMode: false });
  await params({ showProjection: false, coverageMode: 'viewshed' });
  await sleep(6000);
  await frames();
  const volumes = await page.evaluate(() => {
    const app = window.__godsEyeView;
    const records = app.dataManager.layers
      .get('cctv')
      .module._cctvRecordsForTest();
    window.__qaCctvVolumes = records
      .filter((r) => r.viewshedPrimitive)
      .map((record) => ({
        record,
        volume: record.viewshedPrimitive,
        groundRequests: record.groundMeshSampleRequestCount || 0,
      }));
    return window.__qaCctvVolumes.map(({ record }) => ({
      id: record.camera.id,
      points: Object.values(record.frustumPositions)
        .map((p) => app.engine.projector.worldToWindow(p))
        .filter(Boolean),
    }));
  });
  check(
    'viewshed owns between one and fifteen actual volumes',
    volumes.length > 0 && volumes.length <= 15,
  );
  await sleep(8000);
  check(
    'viewshed retains exact volumes and ground sampling counts while idle',
    await page.evaluate(() =>
      window.__qaCctvVolumes.every(
        ({ record, volume, groundRequests }) =>
          record.viewshedPrimitive === volume &&
          (record.groundMeshSampleRequestCount || 0) === groundRequests,
      ),
    ),
  );
  await frames();
  const volumeOn = await imageData(
    await page.screenshot({ path: path.join(shots, 'viewshed-on.png') }),
  );
  await page.evaluate(() => {
    for (const { volume } of window.__qaCctvVolumes) volume.show = false;
  });
  await frames();
  const volumeOff = await imageData(
    await page.screenshot({ path: path.join(shots, 'viewshed-off.png') }),
  );
  const volumePixels = volumes.map(({ id, points }) => {
    const left = Math.max(400, Math.floor(Math.min(...points.map((p) => p.x)))),
      right = Math.min(1000, Math.ceil(Math.max(...points.map((p) => p.x)))),
      top = Math.max(180, Math.floor(Math.min(...points.map((p) => p.y)))),
      bottom = Math.min(720, Math.ceil(Math.max(...points.map((p) => p.y))));
    let changed = 0;
    for (let y = top; y < bottom; y++)
      for (let x = left; x < right; x++) {
        const at = (y * volumeOn.info.width + x) * 4;
        if (
          [0, 1, 2].some(
            (c) => Math.abs(volumeOn.data[at + c] - volumeOff.data[at + c]) > 5,
          )
        )
          changed++;
      }
    return { id, changed };
  });
  report.viewshed = { volumes, pixels: volumePixels };
  check(
    'hiding only viewshed volumes removes visible fill pixels',
    volumePixels.some((p) => p.changed > 64),
  );
  await page.evaluate(() => {
    for (const { volume } of window.__qaCctvVolumes) volume.show = true;
  });
  await params({ coverageMode: 'on' });
  check(
    'ordinary coverage releases every viewshed volume',
    await page.evaluate(() =>
      window.__godsEyeView.dataManager.layers
        .get('cctv')
        .module._cctvRecordsForTest()
        .every((r) => !r.viewshedPrimitive),
    ),
  );
  report.videoPlane = await mediaPose('w2-cctv-video');
  await page.waitForFunction(
    () => {
      const v = window.__godsEyeView.dataManager.layers
        .get('cctv')
        .module.getActiveVideoElement();
      return v && v.readyState >= 2 && v.videoWidth === 320 && !v.paused;
    },
    { timeout: 30000 },
  );
  const videoState = () =>
    page.evaluate(() => {
      const v = window.__godsEyeView.dataManager.layers
        .get('cctv')
        .module.getActiveVideoElement();
      return {
        time: v.currentTime,
        frames: v.getVideoPlaybackQuality().totalVideoFrames,
        width: v.videoWidth,
        height: v.videoHeight,
      };
    });
  report.videoPlane.before = await videoState();
  const before = await imageData(
    await page.screenshot({ path: path.join(shots, 'video-before.png') }),
  );
  await sleep(850);
  report.videoPlane.after = await videoState();
  const after = await imageData(
    await page.screenshot({ path: path.join(shots, 'video-after.png') }),
  );
  check(
    'real video decoder advances',
    report.videoPlane.after.frames > report.videoPlane.before.frames + 3 &&
      report.videoPlane.after.time !== report.videoPlane.before.time,
  );
  // The central colour bars can remain static while the decoded diagonal
  // moves elsewhere. Sample the projected plane interior, excluding its edge.
  const videoPixels = changedPlanePixels(
    before,
    after,
    report.videoPlane.projection,
  );
  report.videoPlane.changedPixels = videoPixels.changed;
  report.videoPlane.sampledPixels = videoPixels.sampled;
  check(
    'video plane pixels actually advance on the globe',
    videoPixels.changed > 64,
  );
  await page.evaluate(() =>
    window.__godsEyeView.dataManager.layers
      .get('cctv')
      .module.getActiveVideoElement()
      .pause(),
  );
  await frames();
  const pausedBefore = await imageData(await page.screenshot());
  await sleep(350);
  await frames();
  const pausedAfter = await imageData(await page.screenshot());
  report.videoPlane.pausedControl = changedPlanePixels(
    pausedBefore,
    pausedAfter,
    report.videoPlane.projection,
  );
  check(
    'paused video negative control has no changing plane pixels',
    report.videoPlane.pausedControl.changed,
    0,
  );
  await page.evaluate(() => {
    window.__qaRetiredVideo = window.__godsEyeView.dataManager.layers
      .get('cctv')
      .module.getActiveVideoElement();
  });
  await enabled(false);
  check(
    'disable releases the real video source',
    await page.evaluate(
      () =>
        window.__qaRetiredVideo.paused &&
        !window.__qaRetiredVideo.getAttribute('src') &&
        !window.__godsEyeView.dataManager.layers
          .get('cctv')
          .module.getActiveVideoElement(),
    ),
  );
  await enabled(true);
  await params({
    selectedCameraId: 'w2-cctv-012',
    showProjection: false,
    coverageMode: 'off',
  });
  await idle('afterVideoIdle');
  for (let i = 0; i < 10; i++) {
    await enabled(false);
    await enabled(true);
  }
  check(
    'ten toggles preserve the exact catalog',
    (await snapshot()).cameras.map(({ id }) => id).sort(),
    fixture.cameras.map(({ id }) => id).sort(),
  );
  await idle('toggleIdle');
  check('no browser runtime errors', report.browserErrors, []);
} catch (error) {
  report.error = redact(error?.stack || error);
  console.error(report.error);
} finally {
  await fixture?.dispose();
  await browser?.close();
  report.pass =
    !report.error &&
    !report.browserErrors.length &&
    report.checks.length > 0 &&
    report.checks.every((c) => c.pass);
  fs.writeFileSync(output, JSON.stringify(report, null, 2) + '\n');
  if (!report.pass) process.exitCode = 1;
}
