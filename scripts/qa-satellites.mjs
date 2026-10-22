#!/usr/bin/env node
// Phase 3 T14: one deterministic satellite catalog on both engines.
import fs from 'node:fs';
import path from 'node:path';
import puppeteer from 'puppeteer';
import sharp from 'sharp';
import { SATELLITE_FIXTURE_EPOCH } from '../src/bench/satelliteFixture.js';
const argument = (name) =>
  process.argv.find((v) => v.startsWith(`--${name}=`))?.slice(name.length + 3);
const base = argument('base-url');
if (
  !base ||
  [4173, 4185, 4186, 4187, 4188, 4189].includes(Number(new URL(base).port))
)
  throw new Error('Supply an unreserved --base-url');
const engine = argument('engine') ?? 'cesium';
const out = argument('out') ?? `qa-artifacts/t14/satellites-${engine}.json`;
const report = { engine, checks: [], snapshots: {} };
const check = (name, ok, detail) => {
  report.checks.push({ name, ok: Boolean(ok), detail });
  console.log(
    `[${ok ? 'PASS' : 'FAIL'}] ${name} ${JSON.stringify(detail ?? '')}`,
  );
};
const browser = await puppeteer.launch({
  headless: true,
  args: ['--use-angle=metal'],
});
try {
  const page = await browser.newPage();
  await page.setViewport({ width: 1280, height: 800 });
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.evaluateOnNewDocument(() =>
    localStorage.setItem('gev:first-run-mission:v1', 'suppressed'),
  );
  const url = new URL(base);
  url.searchParams.set('engine', engine);
  url.searchParams.set('qaFeed', 'satellites:fixture');
  await page.goto(url.href, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => Boolean(window.__godsEyeView?.layers), {
    timeout: 180000,
  });
  await page.evaluate(
    () => window.__godsEyeView.styleManager.initialRestorePromise,
  );
  await page.waitForFunction(
    () =>
      document.getElementById('loading-screen')?.classList.contains('hidden'),
    { timeout: 180000 },
  );
  await new Promise((r) => setTimeout(r, 6000));
  await page.evaluate(async (epoch) => {
    const { appClock } = await import('/src/time/clock.js');
    appClock.freeze(epoch);
    const { engine, styleManager } = window.__godsEyeView;
    styleManager.orbitController.stop();
    engine.camera.cancelFlight();
  }, SATELLITE_FIXTURE_EPOCH);
  await page.evaluate(async () => {
    const { layers, engine, dataManager } = window.__godsEyeView;
    for (const [id] of dataManager.layers)
      if (dataManager.isEnabled(id)) await layers.disable(id);
    const geo = await import('/src/geo/index.js');
    engine.camera.setView({
      destination: geo.cartesian3.fromDegrees(0, 0, 15000000),
      orientation: { heading: 0, pitch: -Math.PI / 2, roll: 0 },
    });
    await layers.enable('satellites');
  });
  await page.waitForFunction(
    () =>
      window.__godsEyeView.dataManager.layers
        .get('satellites')
        .module.getStats().count === 839,
    { timeout: 60000 },
  );
  await new Promise((r) => setTimeout(r, 2500));
  const read = () =>
    page.evaluate(() => {
      const { layers, dataManager, engine } = window.__godsEyeView;
      const module = dataManager.layers.get('satellites').module;
      return {
        camera: engine.camera.pose(),
        stats: module.getStats(),
        params: module.getParams(),
        objects: layers.objects('satellites', 10000),
        detectable: module.getDetectableObjects().length,
        drawn: layers.drawn('satellites'),
      };
    });
  report.snapshots.core = await read();
  check('core catalog', report.snapshots.core.stats.count === 839);
  check(
    'points project',
    report.snapshots.core.objects.filter((o) => o.screen).length > 50,
  );
  report.parity = await page.evaluate(() => {
    const { engine, layers } = window.__godsEyeView;
    const drawn = layers.drawn('satellites');
    return {
      points: layers
        .objects('satellites', 10000)
        .filter((o) => o.screen)
        .slice(0, 5),
      ring: drawn.rings[0].anchors.map((p) =>
        engine.projector.worldToWindow(p),
      ),
      shown: drawn.points.filter(
        (p) => p.show && engine.projector.horizonVisible(p.position),
      ).length,
    };
  });
  await page.screenshot({ path: out.replace(/\.json$/, '-global.png') });
  await page.evaluate(async () => {
    const { engine, dataManager } = window.__godsEyeView;
    const geo = await import('/src/geo/index.js');
    const iss = dataManager.layers.get('satellites').module.findByQuery(25544);
    engine.camera.setView({
      destination: geo.cartesian3.fromDegrees(
        iss.longitude,
        iss.latitude,
        15000000,
      ),
      orientation: { heading: 0, pitch: -Math.PI / 2, roll: 0 },
    });
    engine.render.request('satellite-qa');
  });
  await new Promise((r) => setTimeout(r, 2000));
  const label = await page.evaluate(async () => {
    const { layers, dataManager } = window.__godsEyeView;
    const diagnostics = window.__gevWorldOverlay.getDiagnostics();
    return {
      painted: diagnostics.paintedBySource['satellites-iss'] === 1,
      entries: diagnostics.entriesBySource,
      paintedBySource: diagnostics.paintedBySource,
      screen: layers.screenOf('satellites', 25544),
      params: dataManager.layers.get('satellites').module.getParams(),
      camera: window.__godsEyeView.engine.camera.pose().position,
      iss: dataManager.layers.get('satellites').module.findByQuery(25544)
        ?.position,
    };
  });
  check('ISS label painted by overlay host', label.painted, {
    ...label,
    enabled: (await read()).drawn?.enabled,
  });
  report.views = {};
  for (const [pose, height] of [
    ['city', 60000],
    ['orbit', 1500000],
  ]) {
    report.views[pose] = await page.evaluate(async (height) => {
      const { engine, layers } = window.__godsEyeView;
      const geo = await import('/src/geo/index.js');
      engine.camera.setView({
        destination: geo.cartesian3.fromDegrees(0, 0, height),
        orientation: { heading: 0, pitch: -Math.PI / 2, roll: 0 },
      });
      await new Promise((r) => setTimeout(r, 1200));
      return {
        points: layers
          .objects('satellites', 10000)
          .filter(
            (o) =>
              o.screen &&
              o.screen.x >= 0 &&
              o.screen.x <= 1280 &&
              o.screen.y >= 0 &&
              o.screen.y <= 800,
          ).length,
      };
    }, height);
    await page.screenshot({ path: out.replace(/\.json$/, `-${pose}.png`) });
  }
  await page.evaluate(async () => {
    const { engine, dataManager } = window.__godsEyeView;
    const geo = await import('/src/geo/index.js');
    const iss = dataManager.layers.get('satellites').module.findByQuery(25544);
    engine.camera.setView({
      destination: geo.cartesian3.fromDegrees(
        iss.longitude,
        iss.latitude,
        15000000,
      ),
      orientation: { heading: 0, pitch: -Math.PI / 2, roll: 0 },
    });
  });
  await page.evaluate(() =>
    window.__godsEyeView.dataManager.setLayerParams('satellites', {
      catalog: 'dense',
    }),
  );
  await page.waitForFunction(
    () =>
      window.__godsEyeView.dataManager.layers
        .get('satellites')
        .module.getStats().count === 6839,
    { timeout: 60000 },
  );
  report.snapshots.dense = await read();
  report.densePerformance = [];
  for (let run = 0; run < 3; run++) {
    report.densePerformance.push(
      await page.evaluate(async () => {
        const { engine } = window.__godsEyeView;
        let start = 0,
          last = 0;
        const work = [],
          intervals = [];
        const a = engine.frames.preUpdate.addEventListener(() => {
          start = performance.now();
        });
        const b = engine.frames.postRender.addEventListener(() => {
          const now = performance.now();
          work.push(now - start);
          if (last) intervals.push(now - last);
          last = now;
        });
        await new Promise((r) => setTimeout(r, 8000));
        a();
        b();
        const p95 = (a) => a.sort((x, y) => x - y)[Math.floor(a.length * 0.95)];
        return {
          frames: work.length,
          workP95Ms: p95(work),
          intervalP95Ms: p95(intervals),
        };
      }),
    );
  }
  await page.screenshot({ path: out.replace(/\.json$/, '-dense.png') });

  check('dense catalog', report.snapshots.dense.stats.count === 6839);
  check(
    'dense excluded from voice/detection',
    report.snapshots.dense.objects.length === 839 &&
      report.snapshots.dense.detectable === 839,
  );
  await page.evaluate(() =>
    window.__godsEyeView.dataManager.setLayerParams('satellites', {
      catalog: 'core',
    }),
  );
  check('core restores', (await read()).stats.count === 839);
  const click = await page.evaluate(() => {
    const objects = window.__godsEyeView.layers
      .objects('satellites', 10000)
      .filter((o) => o.screen);
    return objects.find(
      (o) =>
        o.screen.x > 150 &&
        o.screen.x < 1100 &&
        o.screen.y > 150 &&
        o.screen.y < 650 &&
        objects.every(
          (p) =>
            p.id === o.id ||
            Math.hypot(p.screen.x - o.screen.x, p.screen.y - o.screen.y) > 15,
        ),
    );
  });
  check('isolated point available for real click', Boolean(click));
  if (click) {
    await page.mouse.click(click.screen.x, click.screen.y);
    await new Promise((r) => setTimeout(r, 250));
    check(
      'real click selects satellite',
      (
        await page.evaluate(() =>
          window.__godsEyeView.layers.selected('satellites'),
        )
      )?.noradId === click.id,
      { id: click.id },
    );
  }
  const empty = await page.evaluate(() => {
    const { engine } = window.__godsEyeView;
    for (const y of [180, 250, 450, 600])
      for (const x of [300, 500, 800, 960])
        if (
          document.elementFromPoint(x, y) === engine.host.canvas &&
          !engine.picker.pick({ x, y })
        )
          return { x, y };
    return null;
  });
  check('clean empty canvas point available', Boolean(empty));
  if (empty) {
    await page.mouse.click(empty.x, empty.y);
    await new Promise((r) => setTimeout(r, 100));
    check(
      'empty click clears satellite',
      !(await page.evaluate(() =>
        window.__godsEyeView.layers.selected('satellites'),
      )),
    );
  }
  await page.evaluate(() =>
    window.__godsEyeView.dataManager.layers
      .get('satellites')
      .module.trackById(25544),
  );
  report.focus = [];
  for (const delay of [300, 300]) {
    await new Promise((r) => setTimeout(r, delay));
    report.focus.push(
      await page.evaluate(() => {
        const points = window.__godsEyeView.layers
          .drawn('satellites')
          .points.filter((p) => p.show);
        return {
          minAlpha: Math.min(...points.map((p) => p.alpha)),
          maxAlpha: Math.max(...points.map((p) => p.alpha)),
        };
      }),
    );
  }
  check(
    'focus dims other points at 300 and 600ms',
    report.focus.every((s) => s.minAlpha > 0 && s.minAlpha < 0.99),
    report.focus,
  );
  await new Promise((r) => setTimeout(r, 2400));
  report.snapshots.tracked = await read();
  check(
    'tracked identity',
    (
      await page.evaluate(() =>
        window.__godsEyeView.layers.selected('satellites'),
      )
    )?.noradId === 25544,
  );
  check(
    'follow active',
    await page.evaluate(() =>
      Boolean(window.__godsEyeView.engine.camera.following()),
    ),
  );
  const neighbor = await page.evaluate(async () => {
    const { engine, layers } = window.__godsEyeView;
    const registry = await import('/src/data/pickRegistry.js');
    const target = layers.drawn('satellites').tracked,
      pose = engine.camera.pose();
    const position = {
      x: target.x + (pose.right.x + pose.up.x) * 60000,
      y: target.y + (pose.right.y + pose.up.y) * 60000,
      z: target.z + (pose.right.z + pose.up.z) * 60000,
    };
    const set = engine.movers.createSet({
      id: 'qa-neighbor',
      kind: 'point',
      capacity: 1,
      pickable: true,
      depthTest: 'always',
      order: 1000,
      point: { sizePx: 16 },
    });
    set.set(0, { position, color: [1, 0, 1, 1], pickId: 'qa:neighbor' });
    set.setCount(1);
    set.commit();
    registry.registerPickOwner('qa-neighbor', (id) => id === 'qa:neighbor');
    window.__satelliteNeighborCleanup = () => {
      set.destroy();
      registry.unregisterPickOwner('qa-neighbor');
    };
    await new Promise((r) => setTimeout(r, 100));
    return engine.projector.worldToWindow(position);
  });
  await page.mouse.click(neighbor.x, neighbor.y);
  await new Promise((r) => setTimeout(r, 100));
  check(
    'neighbor-owned click keeps satellite tracking',
    (
      await page.evaluate(() =>
        window.__godsEyeView.layers.selected('satellites'),
      )
    )?.noradId === 25544,
  );
  await page.evaluate(() => {
    window.__satelliteNeighborCleanup();
    delete window.__satelliteNeighborCleanup;
  });
  const targetScreen = await page.evaluate(() => {
    const { engine, layers } = window.__godsEyeView;
    return engine.projector.worldToWindow(layers.drawn('satellites').tracked);
  });
  const motionPromise = page.evaluate(async (epoch) => {
    const { appClock } = await import('/src/time/clock.js');
    const { engine, layers } = window.__godsEyeView;
    const samples = [];
    const geo = await import('/src/geo/index.js');
    let maxReadoutErrorM = 0;
    const started = performance.now();
    const advance = engine.frames.postRender.addEventListener(() => {
      const p = layers.drawn('satellites').tracked;
      const info = layers.selected('satellites');
      if (p && info)
        maxReadoutErrorM = Math.max(
          maxReadoutErrorM,
          geo.cartesian3.distance(
            p,
            geo.cartesian3.fromDegrees(
              info.longitude,
              info.latitude,
              info.altitudeM,
            ),
          ),
        );
      const screen = p && engine.projector.worldToWindow(p);
      if (screen)
        samples.push({
          t: performance.now() - started,
          x: screen.x,
          y: screen.y,
          p,
        });
      appClock.freeze(epoch + performance.now() - started);
    });
    await new Promise((r) => setTimeout(r, 5200));
    advance();
    appClock.freeze(epoch);
    const xs = samples.map((s) => s.x),
      ys = samples.map((s) => s.y);
    const a = samples[0]?.p,
      b = samples.at(-1)?.p;
    return {
      frames: samples.length,
      maxReadoutErrorM,
      spanPx: Math.hypot(
        Math.max(...xs) - Math.min(...xs),
        Math.max(...ys) - Math.min(...ys),
      ),
      travelM: a && b ? Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z) : 0,
      maxCenterPx: Math.max(
        ...samples.map((s) => Math.hypot(s.x - 640, s.y - 400)),
      ),
    };
  }, SATELLITE_FIXTURE_EPOCH);
  const raster = [];
  const clip = {
    x: Math.floor(targetScreen.x) - 10,
    y: Math.floor(targetScreen.y) - 10,
    width: 20,
    height: 20,
  };
  if (clip.x >= 0 && clip.y >= 0 && clip.x + 20 <= 1280 && clip.y + 20 <= 800) {
    for (let i = 0; i < 8; i++) {
      await new Promise((r) => setTimeout(r, 600));
      const png = await page.screenshot({ clip });
      const { data, info } = await sharp(png)
        .removeAlpha()
        .raw()
        .toBuffer({ resolveWithObject: true });
      let count = 0,
        x = 0,
        y = 0;
      for (let row = 3; row < 17; row++)
        for (let col = 3; col < 17; col++) {
          const k = (row * info.width + col) * info.channels;
          if (data[k] > 150 && data[k + 1] > 150 && data[k + 2] < 130) {
            count++;
            x += col;
            y += row;
          }
        }
      raster.push({
        count,
        x: count ? x / count : null,
        y: count ? y / count : null,
      });
    }
  }
  report.motion = await motionPromise;
  report.raster = raster;
  const present = raster.filter((p) => p.count > 10);
  const rasterSpan = present.length
    ? Math.hypot(
        Math.max(...present.map((p) => p.x)) -
          Math.min(...present.map((p) => p.x)),
        Math.max(...present.map((p) => p.y)) -
          Math.min(...present.map((p) => p.y)),
      )
    : Infinity;
  check(
    'tracked GPU pixels stable for five seconds',
    present.length === 8 && rasterSpan <= 1,
    { samples: raster, spanPx: rasterSpan },
  );
  check(
    'moving ISS stable for five seconds',
    report.motion.frames > 50 &&
      report.motion.travelM > 35000 &&
      report.motion.spanPx <= 1 &&
      report.motion.maxCenterPx <= 3,
    report.motion,
  );
  check(
    'tracked dot and readout share the SGP4 epoch',
    report.motion.maxReadoutErrorM < 1e-5,
    { maxM: report.motion.maxReadoutErrorM },
  );
  await page.screenshot({ path: out.replace(/\.json$/, '-tracked.png') });
  await page.keyboard.press('Escape');
  check(
    'Escape clears tracking',
    !(await page.evaluate(() =>
      window.__godsEyeView.layers.selected('satellites'),
    )),
  );
  report.takeover = await page.evaluate(() => {
    const { engine, layers, dataManager } = window.__godsEyeView;
    const module = dataManager.layers.get('satellites').module;
    module.trackById(25544);
    const target = module.findByQuery(25544).position;
    const other = engine.camera.follow({
      position: () => target,
      viewFrom: { x: -500000, y: -500000, z: 350000 },
    });
    const result = {
      satellite: layers.selected('satellites'),
      otherStillFollows: engine.camera.following() === other,
    };
    other.stop();
    return result;
  });
  check(
    'foreign follow releases only satellite state',
    !report.takeover.satellite && report.takeover.otherStillFollows,
    report.takeover,
  );
  for (const id of [40000, 45000]) {
    check(
      `track high orbit ${id}`,
      await page.evaluate(
        (id) =>
          window.__godsEyeView.dataManager.layers
            .get('satellites')
            .module.trackById(id),
        id,
      ),
    );
    await new Promise((r) => setTimeout(r, 1500));
    report.snapshots[id] = await read();
    await page.evaluate(() =>
      window.__godsEyeView.dataManager.layers
        .get('satellites')
        .module.stopTracking(),
    );
  }
  report.voice = await page.evaluate(async () => {
    const { createGevActionRunner } = await import('/src/voice/gevActions.js');
    const app = window.__godsEyeView;
    const run = createGevActionRunner(app);
    try {
      return await run('next_satellite_pass', {
        target: '25544',
        latitude: 0,
        longitude: 0,
      });
    } finally {
      run.dispose();
    }
  });
  check(
    'nextSatellitePass through runner',
    report.voice.ok && report.voice.noradId === 25544,
    {
      ok: report.voice.ok,
      action: report.voice.action,
      error: report.voice.error,
    },
  );
  const shareHash = await page.evaluate(async () => {
    const { dataManager, styleManager } = window.__godsEyeView;
    dataManager.setLayerParams(
      'satellites',
      {
        catalog: 'core',
        showPoints: true,
        showOrbits: true,
        selectedSatTrackingId: 45000,
      },
      { origin: 'user' },
    );
    await new Promise((r) => setTimeout(r, 1200));
    return styleManager.shareLinkManager._buildHashParams().toString();
  });
  report.share = {};
  console.log('[satellites] share links prepared');
  for (const opened of ['cesium', 'navara']) {
    console.log(`[satellites] opening share on ${opened}`);
    const context = await browser.createBrowserContext();
    try {
      const shared = await context.newPage();
      await shared.setViewport({ width: 1280, height: 800 });
      await shared.evaluateOnNewDocument(() =>
        localStorage.setItem('gev:first-run-mission:v1', 'suppressed'),
      );
      const destination = new URL(base);
      destination.searchParams.set('engine', opened);
      destination.searchParams.set('qaFeed', 'satellites:fixture');
      destination.hash = shareHash;
      await shared.goto(destination.href, { waitUntil: 'domcontentloaded' });
      const restored = await shared
        .waitForFunction(
          () =>
            window.__godsEyeView?.layers?.selected('satellites')?.noradId ===
            45000,
          { timeout: 120000 },
        )
        .then(
          () => true,
          () => false,
        );
      report.share[opened] = await shared.evaluate(() => {
        const { layers, dataManager, engine } = window.__godsEyeView;
        return {
          selected: layers.selected('satellites')?.noradId,
          params: dataManager.layers.get('satellites')?.module.getParams(),
          follow: Boolean(engine.camera.following()),
        };
      });
      check(
        `share restores GEO on ${opened}`,
        restored && report.share[opened].follow,
        report.share[opened],
      );
    } finally {
      await context.close();
    }
  }
  await page.evaluate(() =>
    window.__godsEyeView.dataManager.layers
      .get('satellites')
      .module.stopTracking(),
  );
  report.ring = await page.evaluate(async () => {
    const { engine, styleManager } = window.__godsEyeView;
    const geo = await import('/src/geo/index.js');
    engine.camera.setView({
      destination: geo.cartesian3.fromDegrees(0, 0, 20000000),
      orientation: { heading: 0, pitch: -Math.PI / 2, roll: 0 },
    });
    styleManager.setCelestialRingEnabled(true, {
      syncShare: false,
      focus: false,
    });
    await new Promise((r) => setTimeout(r, 1500));
    return {
      enabled: styleManager.celestialRing?.enabled,
      visible: styleManager.celestialRing?.visible,
    };
  });
  check(
    'celestial ring visible',
    report.ring.enabled && report.ring.visible,
    report.ring,
  );
  await page.screenshot({ path: out.replace(/\.json$/, '-celestial.png') });
  await page.evaluate(() =>
    window.__godsEyeView.dataManager.setLayerParams('satellites', {
      showPoints: false,
      showOrbits: false,
    }),
  );
  check('hidden points leave detection', (await read()).detectable === 0);
  await page.evaluate(() => window.__godsEyeView.layers.disable('satellites'));
  check(
    'disable releases follow',
    !(await page.evaluate(() =>
      window.__godsEyeView.engine.camera.following(),
    )),
  );
  report.cycles = await page.evaluate(async () => {
    const { layers, dataManager, engine, styleManager } = window.__godsEyeView;
    styleManager.setCelestialRingEnabled(false, { syncShare: false });
    const baseline = {
      movers: engine.movers.list().length,
      lines: engine.lines.list().length,
    };
    const samples = [];
    for (let i = 0; i < 10; i++) {
      await layers.enable('satellites');
      dataManager.setLayerParams('satellites', {
        showPoints: true,
        showOrbits: true,
        selectedSatTrackingId: 40000,
      });
      await new Promise((r) => setTimeout(r, 50));
      if (layers.selected('satellites')?.noradId !== 40000)
        throw new Error('Selected ID did not restore');
      await layers.disable('satellites');
      samples.push({
        movers: engine.movers.list().length,
        lines: engine.lines.list().length,
        follow: Boolean(engine.camera.following()),
        activePoints: engine.movers.list().reduce((sum, s) => sum + s.count, 0),
        activeLines: engine.lines.list().filter((s) => s.shown).length,
      });
    }
    await new Promise((r) => setTimeout(r, 1000));
    const frames = layers.framesDrawn();
    await new Promise((r) => setTimeout(r, 2200));
    return { baseline, samples, idleFrames: layers.framesDrawn() - frames };
  });
  check(
    'ten visibility cycles release follow and retain bounded pools',
    report.cycles.samples.every(
      (s) =>
        !s.follow &&
        s.activePoints === 0 &&
        s.activeLines === 0 &&
        s.movers === report.cycles.samples[0].movers &&
        s.lines === report.cycles.samples[0].lines,
    ),
    report.cycles,
  );
  report.destroy = await page.evaluate(() => {
    const { dataManager, engine } = window.__godsEyeView;
    dataManager.layers.get('satellites').module.destroy();
    return {
      movers: engine.movers.list().length,
      lines: engine.lines.list().length,
    };
  });
  check(
    'destroy releases all mover sets and lines',
    report.destroy.movers === 0 && report.destroy.lines === 0,
    report.destroy,
  );
  check('no page errors', errors.length === 0, {
    count: errors.length,
    messages: errors.map((e) => e.replace(/https?:\/\/[^ ]+/g, '[URL]')),
  });
  fs.mkdirSync(path.dirname(out), { recursive: true });
  await page.screenshot({ path: out.replace(/\.json$/, '.png') });
} finally {
  await browser.close();
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, JSON.stringify(report, null, 2));
}
const passed = report.checks.filter((c) => c.ok).length;
console.log(`[satellites] ${passed}/${report.checks.length} passed`);
process.exitCode = passed === report.checks.length ? 0 : 1;
