import fs from 'node:fs';
import path from 'node:path';
import puppeteer from 'puppeteer';
import sharp from 'sharp';
import { createHash } from 'node:crypto';
import {
  TRANSIT_EPOCH,
  transitSnapshot,
  installTransitFixture,
} from './fixtures/w2/transit.mjs';
import { blockPaidQaMaps } from './qa-map-policy.mjs';
import { watchW1Page, redact } from './qa-browserEvidence.mjs';
import { transitQaBase } from './qa-transit-browser.mjs';

const args = process.argv.slice(2),
  option = (name) => args[args.indexOf(name) + 1];
if (!args.includes('--url') || !args.includes('--report'))
  throw new Error('Explicit --url and --report required');
const url = transitQaBase(option('--url')),
  output = option('--report');
const shots = output.replace(/\.json$/, '-shots');
fs.mkdirSync(shots, { recursive: true });
const report = {
  engine: new URL(url).searchParams.get('engine') || 'cesium',
  checks: [],
  browserErrors: [],
  fixtureHash: createHash('sha256')
    .update(
      JSON.stringify(Array.from({ length: 9 }, (_, i) => transitSnapshot(i))),
    )
    .digest('hex'),
  pass: false,
};
const check = (name, actual, expected = true) => {
  const pass = JSON.stringify(actual) === JSON.stringify(expected);
  report.checks.push({ name, actual, expected, pass });
  console.log(`[${pass ? 'PASS' : 'FAIL'}] ${name}`);
};
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
let browser, fixture;
try {
  browser = await puppeteer.launch({
    headless: true,
    executablePath:
      '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    args: [
      '--use-angle=metal',
      '--enable-gpu',
      '--disable-background-timer-throttling',
      '--disable-renderer-backgrounding',
    ],
  });
  const page = await browser.newPage();
  await page.setViewport({ width: 1280, height: 800, deviceScaleFactor: 1 });
  await blockPaidQaMaps(page);
  fixture = await installTransitFixture(page);
  watchW1Page(page, report, {
    name: 'transit',
    baseUrl: url,
    preview: args.includes('--preview'),
    allowPaidMaps: false,
  });
  const target = new URL(url);
  target.searchParams.set('welcome', '0');
  target.hash = 'lat=42.355&lon=-71.065&alt=1200&heading=0&pitch=-90&map=osm';
  await page.goto(target.href, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(
    () => window.__godsEyeView?.dataManager?.layers.has('transit'),
    { timeout: 90000 },
  );
  await page.waitForFunction(
    () =>
      !document.getElementById('loading-screen') ||
      document.getElementById('loading-screen').classList.contains('hidden'),
    { timeout: 90000 },
  );
  await page.evaluate(async () => {
    const app = window.__godsEyeView;
    await app.styleManager.initialRestorePromise;
    app.styleManager.orbitController.stop();
    for (const [id, entry] of app.dataManager.layers)
      if (entry.enabled) await app.dataManager.setEnabled(id, false);
    app.styleManager._setDetectionMode('OFF');
  });
  await page.waitForFunction(
    () => window.__godsEyeView.engine.surface.tilesLoaded(),
    { timeout: 90000 },
  );
  await page.evaluate(async () => {
    const app = window.__godsEyeView;
    await app.dataManager.setEnabled('transit', true);
  });
  await page.waitForFunction(
    () =>
      window.__godsEyeView.dataManager.layers
        .get('transit')
        .module._transitStateForTest()._vehicles.size === 12,
    { timeout: 60000 },
  );
  for (let i = 1; i <= 8; i++) {
    fixture.setStep(i);
    await page.evaluate(() =>
      window.__godsEyeView.dataManager.layers.get('transit').module.update(),
    );
  }
  await page.evaluate(async (epoch) => {
    const layer = window.__godsEyeView.dataManager.layers.get('transit').module;
    const state = layer._transitStateForTest(),
      parts = layer._transitPartsForTest();
    const { seek, setRate } = await import('/src/data/contactPlayback.js');
    const clocks = { wallNowMs: Date.now(), monoNowMs: performance.now() };
    for (const entry of state._vehicles.values()) {
      seek(entry.track, epoch - 45000, clocks);
      setRate(entry.track, 0, clocks);
    }
    parts.rendering.onPreRender();
    for (const entry of state._vehicles.values()) {
      entry.pathRevision = -1;
      parts.trails.prepareEntry(entry);
    }
    parts.height.anchorFloors();
    parts.rendering.onPreRender();
    parts.rendering.refreshVisibility(true);
    await parts.renderer.whenReady?.();
  }, TRANSIT_EPOCH);
  const frames = async () =>
    page.evaluate(
      () =>
        new Promise((resolve, reject) => {
          const e = window.__godsEyeView.engine;
          const timer = setTimeout(() => {
            remove();
            reject(new Error('Transit frame deadline'));
          }, 10000);
          const remove = e.frames.postRender.addEventListener(() => {
            remove();
            clearTimeout(timer);
            resolve();
          });
          e.render.request('transit-qa');
        }),
    );
  await page.waitForFunction(
    () => {
      const state = window.__godsEyeView.dataManager.layers
        .get('transit')
        .module._transitStateForTest();
      return [...state._vehicles.values()].every(
        (entry) => entry.surfaceReady !== false && !entry.heightPending,
      );
    },
    { timeout: 30000 },
  );
  await sleep(2000);
  await frames();
  const freeze = () =>
    page.evaluate(async (epoch) => {
      const layer =
        window.__godsEyeView.dataManager.layers.get('transit').module;
      const s = layer._transitStateForTest(),
        p = layer._transitPartsForTest();
      const { seek } = await import('/src/data/contactPlayback.js');
      const { updatePlayback } =
        await import('/src/layers/transit/movement.js');
      const clocks = { wallNowMs: Date.now(), monoNowMs: performance.now() };
      for (const entry of s._vehicles.values()) {
        seek(entry.track, epoch - 45000, clocks);
        updatePlayback(entry, clocks.wallNowMs, clocks.monoNowMs);
        entry.pathRevision = -1;
        p.trails.prepareEntry(entry);
        p.rendering.placeSample(entry);
        p.rendering.schedulePlayback(entry);
      }
      p.trails.update();
      p.rendering.syncRenderHold();
    }, TRANSIT_EPOCH);
  await freeze();
  await frames();
  const snapshot = () =>
    page.evaluate(() => {
      const app = window.__godsEyeView,
        state = app.dataManager.layers
          .get('transit')
          .module._transitStateForTest();
      return [...state._vehicles.values()].map((entry) => {
        const p = app.engine.projector.worldToWindow(entry.marker.position);
        return {
          id: entry.key,
          mode: entry.mode,
          shown: entry.marker.show,
          x: p?.x,
          y: p?.y,
          rotation: entry.marker.rotation,
          fixes: entry.track.count,
          selected: state._selectedKey === entry.key,
          visibility: entry.visibility,
          height: entry.sample?.h,
          surfaceReady: entry.surfaceReady,
        };
      });
    });
  report.vehicles = await snapshot();
  check(
    'real source retains twelve vehicles and rejects stale fix',
    report.vehicles.length,
    12,
  );
  check(
    'all five resolved MBTA modes retained',
    [...new Set(report.vehicles.map((v) => v.mode))].sort(),
    ['bus', 'ferry', 'rail', 'subway', 'tram'],
  );
  check(
    'each moving vehicle retains nine reports',
    report.vehicles
      .filter((v) => Number(v.id.split('-').at(-1)) < 6)
      .every((v) => v.fixes === 9),
  );
  const before = await page.screenshot();
  await page.evaluate(() => {
    const s = window.__godsEyeView.dataManager.layers
      .get('transit')
      .module._transitStateForTest();
    s._markers.show = s._animatedMarkers.show = false;
  });
  await frames();
  const without = await page.screenshot();
  await page.evaluate(() => {
    const s = window.__godsEyeView.dataManager.layers
      .get('transit')
      .module._transitStateForTest();
    s._markers.show = s._animatedMarkers.show = true;
  });
  await frames();
  let a = await sharp(before).ensureAlpha().raw().toBuffer(),
    b = await sharp(without).ensureAlpha().raw().toBuffer();
  function deltaPixels(x, y, radius = 15) {
    let count = 0;
    for (
      let row = Math.max(0, Math.floor(y) - radius);
      row <= Math.min(799, y + radius);
      row++
    )
      for (
        let col = Math.max(0, Math.floor(x) - radius);
        col <= Math.min(1279, x + radius);
        col++
      ) {
        const p = (row * 1280 + col) * 4;
        if (
          Math.abs(a[p] - b[p]) +
            Math.abs(a[p + 1] - b[p + 1]) +
            Math.abs(a[p + 2] - b[p + 2]) >
          50
        )
          count++;
      }
    return count;
  }
  report.controls = report.vehicles
    .filter((v) => v.shown && v.x > 350 && v.x < 1000 && v.y > 120 && v.y < 700)
    .map((v) => ({ ...v, pixels: deltaPixels(v.x, v.y) }));
  check(
    'five positive rendered marker controls',
    report.controls.filter((v) => v.pixels >= 4).length >= 5,
  );
  fs.writeFileSync(path.join(shots, 'markers.png'), before);
  report.poses = [];
  for (const [name, heading, pitch] of [
    ['orbit', Math.PI / 2, -Math.PI / 2],
    ['oblique', 0, -Math.PI / 3],
  ]) {
    await page.evaluate(
      async ({ heading, pitch }) => {
        const geo = await import('/src/geo/index.js');
        window.__godsEyeView.engine.camera.setView({
          destination: geo.cartesian3.fromDegrees(
            -71.065,
            42.355 - 1200 / Math.tan(-pitch) / 111320,
            1200,
          ),
          orientation: { heading, pitch, roll: 0 },
        });
      },
      { heading, pitch },
    );
    await sleep(700);
    await frames();
    const pose = await page.evaluate(async () => {
      const geo = await import('/src/geo/index.js'),
        app = window.__godsEyeView;
      const s = app.dataManager.layers
        .get('transit')
        .module._transitStateForTest();
      const rows = [];
      for (const entry of s._vehicles.values()) {
        if (!entry.marker.show || !Number.isFinite(entry.courseDeg)) continue;
        const pos = entry.marker.position,
          m = geo.transforms.eastNorthUpToFixedFrame(pos);
        const r = (entry.courseDeg * Math.PI) / 180;
        const end = geo.matrix4.multiplyByPoint(
          m,
          { x: 30 * Math.sin(r), y: 30 * Math.cos(r), z: 0 },
          geo.cartesian3.create(),
        );
        const a = app.engine.projector.worldToWindow(pos),
          b = app.engine.projector.worldToWindow(end);
        if (
          !a ||
          !b ||
          Math.hypot(a.x - b.x, a.y - b.y) < 3 ||
          a.x < 300 ||
          a.x > 1000 ||
          a.y < 120 ||
          a.y > 700
        )
          continue;
        const expected = Math.atan2(a.x - b.x, a.y - b.y),
          delta = entry.marker.rotation - expected;
        rows.push({
          id: entry.key,
          x: a.x,
          y: a.y,
          errorDeg: Math.abs(
            (Math.atan2(Math.sin(delta), Math.cos(delta)) * 180) / Math.PI,
          ),
        });
      }
      return rows;
    });
    report.poses.push({ name, controls: pose });
    check(
      `${name}: five visible courses match projected travel`,
      pose.length >= 5 && pose.every((p) => p.errorDeg < 1),
    );
    await page.screenshot({ path: path.join(shots, `${name}.png`) });
  }
  await page.evaluate(async () => {
    const geo = await import('/src/geo/index.js');
    window.__godsEyeView.engine.camera.setView({
      destination: geo.cartesian3.fromDegrees(-71.065, 42.355, 1200),
      orientation: { heading: 0, pitch: -Math.PI / 2, roll: 0 },
    });
  });
  await sleep(700);
  await freeze();
  await frames();
  const motion = await page.evaluate(async () => {
    const { setRate } = await import('/src/data/contactPlayback.js');
    const layer = window.__godsEyeView.dataManager.layers.get('transit').module;
    const s = layer._transitStateForTest(),
      p = layer._transitPartsForTest();
    const entry = s._vehicles.get('mbta:w2-0'),
      before = { ...entry.marker.position };
    setRate(entry.track, 1, {
      wallNowMs: Date.now(),
      monoNowMs: performance.now(),
    });
    p.rendering.sampleIdle(entry);
    p.rendering.schedulePlayback(entry);
    p.rendering.syncRenderHold();
    await new Promise((resolve) => setTimeout(resolve, 700));
    const after = entry.marker.position;
    return {
      distance: Math.hypot(
        after.x - before.x,
        after.y - before.y,
        after.z - before.z,
      ),
      moving: s._moving.has(entry),
    };
  });
  report.motion = motion;
  check(
    'actual 1x playback moves the rendered marker',
    motion.moving && motion.distance > 0.2 && motion.distance < 3,
  );
  await freeze();
  await frames();
  report.vehicles = await snapshot();
  report.controls = report.controls.map((control) => ({
    ...control,
    ...report.vehicles.find((v) => v.id === control.id),
  }));
  const control =
    report.controls.find((v) => v.id === 'mbta:w2-0') ||
    report.controls.find((v) => Number(v.id.split('-').at(-1)) < 6);
  if (!control) throw new Error('No moving marker control visible');
  await page.mouse.click(control.x, control.y);
  await sleep(500);
  await frames();
  check(
    'physical click selects exact vehicle',
    (await snapshot()).find((v) => v.selected)?.id,
    control.id,
  );
  await page.waitForFunction(
    () =>
      !window.__godsEyeView.dataManager.layers
        .get('transit')
        .module._transitPartsForTest()
        .trails.requestDiagnostics().pending,
    { timeout: 15000 },
  );
  await sleep(2000);
  await frames();
  await freeze();
  await frames();
  report.trail = await page.evaluate(() => {
    const app = window.__godsEyeView,
      parts = app.dataManager.layers
        .get('transit')
        .module._transitPartsForTest();
    const d = parts.trails.diagnostics();
    return {
      ground: d?.ground,
      segments: d?.segments,
      rebuilds: d?.rebuilds,
      strategy: d?.headStrategy,
      head: d?.head.show,
    };
  });
  check(
    'selected history requested through real source',
    fixture.requests.some((p) => p.startsWith('/api/transit/trail/mbta/')),
  );
  check(
    'selected trail uses actual ground classification',
    report.trail.ground,
  );
  check('selected trail retains history', report.trail.segments > 0);
  await page.screenshot({ path: path.join(shots, 'selected-trail.png') });
  report.trailControls = await page.evaluate(() => {
    const app = window.__godsEyeView,
      s = app.dataManager.layers.get('transit').module._transitStateForTest();
    const entry = s._vehicles.get(s._selectedKey);
    return entry.trailSegments
      .filter((segment) => segment.toT <= entry.sample.displayT)
      .map((segment) => {
        const [a, b] = segment.positions;
        return app.engine.projector.worldToWindow({
          x: (a.x + b.x) / 2,
          y: (a.y + b.y) / 2,
          z: (a.z + b.z) / 2,
        });
      })
      .filter((p) => p && p.x > 350 && p.x < 1000 && p.y > 120 && p.y < 700);
  });
  a = await sharp(await page.screenshot())
    .ensureAlpha()
    .raw()
    .toBuffer();
  await page.keyboard.press('Escape');
  await frames();
  b = await sharp(await page.screenshot())
    .ensureAlpha()
    .raw()
    .toBuffer();
  report.trailControls = report.trailControls.map((p) => ({
    ...p,
    pixels: deltaPixels(p.x, p.y, 4),
  }));
  check(
    'three positive ground-trail pixel controls',
    report.trailControls.filter((p) => p.pixels >= 3).length >= 3,
  );
  check(
    'Escape clears selection',
    (await snapshot()).some((v) => v.selected),
    false,
  );
  const toggles = await page.evaluate(async () => {
    const manager = window.__godsEyeView.dataManager,
      counts = [];
    for (let i = 0; i < 10; i++) {
      await manager.setEnabled('transit', false);
      await manager.setEnabled('transit', true);
      counts.push(
        manager.layers.get('transit').module._transitStateForTest()._vehicles
          .size,
      );
    }
    return counts;
  });
  check(
    'ten disable/enable cycles retain exactly the fixture fleet',
    toggles,
    Array(10).fill(12),
  );
  await page.evaluate(() =>
    window.__godsEyeView.dataManager.setEnabled('transit', false),
  );
  await frames();
  report.disabled = await page.evaluate(() => {
    const s = window.__godsEyeView.dataManager.layers
      .get('transit')
      .module._transitStateForTest();
    return {
      vehicles: s._vehicles.size,
      moving: s._moving.size,
      selected: s._selectedKey,
      held: s._renderHeld,
      markers: s._markers.length + s._animatedMarkers.length,
      requests: s._inFlight.size,
    };
  });
  check('disable releases fleet, requests and render hold', report.disabled, {
    vehicles: 0,
    moving: 0,
    selected: null,
    held: false,
    markers: 0,
    requests: 0,
  });
  check('no unexpected browser errors', report.browserErrors.length, 0);
  report.pass = report.checks.every((row) => row.pass);
} catch (error) {
  report.failure = redact(error.stack || error.message);
} finally {
  await fixture?.dispose().catch(() => {});
  await browser?.close();
  fs.writeFileSync(output, JSON.stringify(report, null, 2) + '\n');
}
console.log(`Transit ${report.engine}: ${report.pass ? 'PASS' : 'FAIL'}`);
if (!report.pass) process.exitCode = 1;
