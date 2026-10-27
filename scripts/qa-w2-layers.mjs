#!/usr/bin/env node
// W2 contract capture: real source parsers, geometry, raster presence, lifecycle
// and runtime evidence. No missing/empty layer is accepted as positive coverage.
import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import puppeteer from 'puppeteer';
import sharp from 'sharp';
import { watchW1Page } from './qa-browserEvidence.mjs';
import { earthquakeFixture, W2_EPOCH_MS } from './fixtures/w2/earthquakes.mjs';
const arg = (name) =>
  process.argv.find((v) => v.startsWith(`--${name}=`))?.slice(name.length + 3);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const reserved = new Set([4173, 4185, 4186, 4187, 4188, 4189]);
const poses = {
  global: [-100, 35, 15000000, -90],
  city: [-122.42, 37.77, 120000, -90],
  orbit: [-110, 35, 3000000, -90],
  terrain: [-122.42, 37.05, 80000, -45],
};
const sha = (b) => crypto.createHash('sha256').update(b).digest('hex');
const out = path.resolve(
  arg('out') ?? 'qa-artifacts/w2/earthquakes-cesium.json',
);
if (arg('compare')) {
  const [a, b] = await Promise.all(
    arg('compare')
      .split(',')
      .map(async (f) => JSON.parse(await fs.readFile(f, 'utf8'))),
  );
  const errors = [];
  for (const d of [a, b]) {
    if (
      !d.checks?.length ||
      d.checks.some((c) => !c.pass) ||
      !Array.isArray(d.browserErrors) ||
      d.browserErrors.length > 0 ||
      !d.runtimePages?.includes('main')
    )
      errors.push(`${d.engine}: failed checks/runtime errors`);
    if (d.geometryEpochMs !== W2_EPOCH_MS || d.records?.length !== 15)
      errors.push(`${d.engine}: missing fixture geometry`);
  }
  if (JSON.stringify(a.records) !== JSON.stringify(b.records))
    errors.push('analyst records differ');
  for (const pose of Object.keys(poses)) {
    const left = a.poses?.[pose],
      right = b.poses?.[pose];
    if (
      !(left?.known?.length >= 5) ||
      !(right?.known?.length >= 5) ||
      left.engineEpochMs !== W2_EPOCH_MS ||
      right.engineEpochMs !== W2_EPOCH_MS ||
      left.total !== right.total ||
      left.onScreen !== right.onScreen
    ) {
      errors.push(`${pose}: missing/different population`);
      continue;
    }
    for (const p of left.known) {
      const q = right.known.find((v) => v.id === p.id);
      if (
        !q ||
        ![p.screen?.x, p.screen?.y, q.screen?.x, q.screen?.y].every(
          Number.isFinite,
        ) ||
        Math.max(
          Math.abs(p.screen.x - q.screen.x),
          Math.abs(p.screen.y - q.screen.y),
        ) > 2
      )
        errors.push(`${pose}/${p.id}: projection differs`);
    }
  }
  const result = { pass: !errors.length, errors };
  console.log(JSON.stringify(result));
  process.exitCode = result.pass ? 0 : 1;
} else {
  const base = arg('base-url');
  if (!base || reserved.has(Number(new URL(base).port)))
    throw new Error('Supply an unreserved --base-url');
  const engine = arg('engine') ?? 'cesium';
  if (!['cesium', 'navara'].includes(engine)) throw new Error('Unknown engine');
  const layer = arg('layer') ?? 'earthquakes';
  if (layer !== 'earthquakes')
    throw new Error('W2 adapter not implemented for this layer yet');
  const report = {
    layer,
    engine,
    checks: [],
    poses: {},
    geometryEpochMs: W2_EPOCH_MS,
    browserErrors: [],
    driverSha256: sha(await fs.readFile(new URL(import.meta.url))),
  };
  const check = (name, pass, detail) => {
    report.checks.push({ name, pass: Boolean(pass), detail });
    console.log(`${pass ? 'PASS' : 'FAIL'} ${name}`);
  };
  await fs.mkdir(path.dirname(out), { recursive: true });
  const browser = await puppeteer.launch({
    headless: true,
    protocolTimeout: 180000,
    args: ['--use-angle=metal'],
  });
  try {
    const page = await browser.newPage();
    await page.setViewport({ width: 1280, height: 800 });
    const observe = (p, name) =>
      watchW1Page(p, report, {
        name,
        baseUrl: base,
        preview: process.argv.includes('--preview'),
      });
    observe(page, 'main');
    const installFixture = (fixture) => {
      localStorage.setItem('gev:first-run-mission:v1', 'suppressed');
      const fetch = window.fetch.bind(window);
      window.__w2Requests = 0;
      window.fetch = (input, init) => {
        const url = new URL(
          typeof input === 'string' ? input : (input.url ?? input),
          location.href,
        );
        if (
          url.hostname === 'earthquake.usgs.gov' &&
          url.pathname.endsWith('/all_day.geojson')
        ) {
          window.__w2Requests++;
          if (window.__w2FailNext) {
            window.__w2FailNext = false;
            return Promise.resolve(new Response('', { status: 503 }));
          }
          if (window.__w2DelayNext) {
            window.__w2DelayNext = false;
            return new Promise((resolve) => {
              window.__w2Release = () =>
                resolve(
                  new Response(
                    JSON.stringify({ type: 'FeatureCollection', features: [] }),
                    {
                      status: 200,
                      headers: { 'content-type': 'application/json' },
                    },
                  ),
                );
            });
          }
          return Promise.resolve(
            new Response(JSON.stringify(fixture), {
              status: 200,
              headers: { 'content-type': 'application/json' },
            }),
          );
        }
        return fetch(input, init);
      };
    };
    await page.evaluateOnNewDocument(installFixture, earthquakeFixture());
    const url = new URL(base);
    url.searchParams.set('engine', engine);
    await page.goto(url.href, {
      waitUntil: 'domcontentloaded',
      timeout: 180000,
    });
    await page.waitForFunction(
      () => window.__godsEyeView?.layers && window.__godsEyeView?.styleManager,
      { timeout: 180000 },
    );
    await page.evaluate(
      () => window.__godsEyeView.styleManager.initialRestorePromise,
    );
    await page.waitForFunction(
      () =>
        document.getElementById('loading-screen')?.classList.contains('hidden'),
      { timeout: 180000 },
    );
    const available = await page.evaluate(
      async ([id, epoch]) => {
        const app = window.__godsEyeView;
        app.styleManager.orbitController.stop();
        app.engine.camera.cancelFlight();
        for (const [name] of app.dataManager.layers)
          if (app.dataManager.isEnabled(name)) await app.layers.disable(name);
        const { appClock } = await import('/src/time/clock.js');
        appClock.freeze(epoch);
        if (app.viewer)
          app.viewer.clock.currentTime =
            app.viewer.clock.currentTime.constructor.fromDate(new Date(epoch));
        return {
          available: app.dataManager.layers.has(id),
          engine: app.engine.kind,
        };
      },
      [layer, W2_EPOCH_MS],
    );
    check(
      'required layer and engine',
      available.available && available.engine === engine,
      available,
    );
    if (!available.available)
      throw new Error('Required W2 layer is unavailable');
    if (engine === 'navara') {
      const credit = await page.evaluate(() => {
        const roots = [document];
        while (roots.length) {
          const root = roots.pop();
          if (
            (root.body ?? root).textContent?.includes(
              'Data courtesy of the U.S. Geological Survey',
            )
          )
            return true;
          for (const element of root.querySelectorAll('*'))
            if (element.shadowRoot) roots.push(element.shadowRoot);
        }
        return false;
      });
      check('USGS attribution reaches the Navara attribution UI', credit);
    }
    await page.evaluate((id) => window.__godsEyeView.layers.enable(id), layer);
    await page.waitForFunction(
      (id) =>
        window.__godsEyeView.dataManager.layers.get(id).module.getStats()
          .count === 15,
      { timeout: 30000 },
      layer,
    );
    report.records = await page.evaluate(
      (id) =>
        window.__godsEyeView.dataManager.layers
          .get(id)
          .module.getAnalystRecords(),
      layer,
    );
    check(
      'real parser filters magnitude and preserves all 15 records',
      report.records.length === 15 &&
        report.records.every(
          (r) =>
            Number.isFinite(r.lat) &&
            Number.isFinite(r.lon) &&
            r.magnitude >= 2.5,
        ),
      report.records.length,
    );
    // Match existing W1 raster QA: retain only the globe canvas. HUD clocks
    // and world labels must not make an absent ground disc look nonempty.
    await page.evaluate(() => {
      const canvas = window.__godsEyeView.engine.host.canvas;
      const style = document.createElement('style');
      style.textContent =
        '.w2-raster-hidden { visibility: hidden !important; }';
      document.head.append(style);
      for (const element of document.body.querySelectorAll('*'))
        if (element !== canvas && !element.contains(canvas))
          element.classList.add('w2-raster-hidden');
    });
    for (const [name, [lon, lat, height, pitch]] of Object.entries(poses)) {
      if (arg('diagnostic-pose') && arg('diagnostic-pose') !== name) continue;
      await page.evaluate(
        async (pose) => {
          const app = window.__godsEyeView,
            geo = await import('/src/geo/index.js');
          app.engine.camera.setView({
            destination: geo.cartesian3.fromDegrees(pose[0], pose[1], pose[2]),
            orientation: {
              heading: 0,
              pitch: geo.math.toRadians(pose[3]),
              roll: 0,
            },
          });
          app.engine.render.request('w2-pose');
        },
        [lon, lat, height, pitch],
      );
      const ready = await page.evaluate(async () => {
        const e = window.__godsEyeView.engine;
        const start = performance.now();
        let since = null;
        while (performance.now() - start < 90000) {
          if (e.surface.tilesLoaded()) since ??= performance.now();
          else since = null;
          if (since !== null && performance.now() - since >= 1500) return true;
          e.render.request('w2-settle');
          await new Promise((r) => setTimeout(r, 100));
        }
        return false;
      });
      check(`${name}: tiles settle`, ready);
      await sleep(2500);
      const snap = await page.evaluate((id) => {
        const app = window.__godsEyeView,
          e = app.engine,
          module = app.dataManager.layers.get(id).module;
        return import('/src/geo/index.js').then((geo) => {
          const all = module.getAnalystRecords().map((r) => {
            const position = geo.cartesian3.fromDegrees(r.lon, r.lat);
            const screen = e.projector.worldToWindow(position);
            return {
              id: r.id,
              screen: screen ? { x: screen.x, y: screen.y } : null,
              visible:
                screen &&
                e.projector.horizonVisible(position) &&
                screen.x >= 0 &&
                screen.y >= 0 &&
                screen.x <= 1280 &&
                screen.y <= 800,
            };
          });
          const visible = all
            .filter((r) => r.visible)
            .sort((a, b) => a.id.localeCompare(b.id));
          return {
            total: all.length,
            onScreen: visible.length,
            known: visible.slice(0, 5).map(({ id, screen }) => {
              const surface = e.picker.pickPosition(screen);
              const place = surface && geo.cartographic.fromCartesian(surface);
              return {
                id,
                screen,
                surface: surface
                  ? { x: surface.x, y: surface.y, z: surface.z }
                  : null,
                surfaceHeightM: place?.height ?? null,
              };
            }),
            camera: e.camera.pose(),
            engineEpochMs: e.clock.now(),
          };
        });
      }, layer);
      report.poses[name] = snap;
      check(
        `${name}: positive controls at fixed epoch`,
        snap.known.length >= 5 && snap.engineEpochMs === W2_EPOCH_MS,
        { known: snap.known.length, onScreen: snap.onScreen },
      );
      const onFile = out.replace(/\.json$/, `-${name}-on.png`),
        offFile = out.replace(/\.json$/, `-${name}-off.png`);
      const on = await page.screenshot({ path: onFile });
      await page.evaluate(
        (id) => window.__godsEyeView.layers.disable(id),
        layer,
      );
      await sleep(1500);
      const off = await page.screenshot({ path: offFile });
      const [a, b] = await Promise.all(
        [on, off].map((v) => sharp(v).removeAlpha().raw().toBuffer()),
      );
      let pixels = 0;
      for (let i = 0; i < a.length; i += 3)
        if (
          Math.max(
            Math.abs(a[i] - b[i]),
            Math.abs(a[i + 1] - b[i + 1]),
            Math.abs(a[i + 2] - b[i + 2]),
          ) > 16
        )
          pixels++;
      report.poses[name].raster = {
        changedPixels: pixels,
        on: { file: path.basename(onFile), sha256: sha(on) },
        off: { file: path.basename(offFile), sha256: sha(off) },
      };
      check(`${name}: nonempty rendered layer`, pixels >= 100, pixels);
      await page.evaluate(
        (id) => window.__godsEyeView.layers.enable(id),
        layer,
      );
    }
    if (!arg('diagnostic-pose')) {
      const detail = await page.evaluate(async () => {
        const app = window.__godsEyeView;
        const geo = await import('/src/geo/index.js');
        await app.mapStackController.setStack('photoreal');
        app.engine.camera.setView({
          destination: geo.cartesian3.fromDegrees(-122.4028, 37.7952, 1800),
          orientation: { heading: 0, pitch: -Math.PI / 2, roll: 0 },
        });
        app.engine.render.request('w2-photoreal-ground');
        const started = performance.now();
        let since = null;
        while (performance.now() - started < 90000) {
          if (app.engine.surface.tilesLoaded()) since ??= performance.now();
          else since = null;
          if (since !== null && performance.now() - since > 2000) break;
          app.engine.render.request('w2-detail-settle');
          await new Promise((resolve) => setTimeout(resolve, 100));
        }
        return {
          photoreal: app.engine.maps.photorealActive(),
          settled: app.engine.surface.tilesLoaded(),
        };
      });
      await sleep(4000);
      const probes = await page.evaluate(() => {
        const e = window.__godsEyeView.engine;
        return import('/src/geo/index.js').then((geo) =>
          [
            [320, 200],
            [960, 200],
            [640, 400],
            [320, 600],
            [960, 600],
          ].map(([x, y]) => {
            const point = e.picker.pickPosition({ x, y });
            const place = point && geo.cartographic.fromCartesian(point);
            return { x, y, heightM: place?.height ?? null };
          }),
        );
      });
      const detailOn = out.replace(/\.json$/, '-tiles-on.png');
      const detailOff = out.replace(/\.json$/, '-tiles-off.png');
      const on = await page.screenshot({ path: detailOn });
      await page.evaluate(
        (id) => window.__godsEyeView.layers.disable(id),
        layer,
      );
      await sleep(1500);
      const off = await page.screenshot({ path: detailOff });
      const [onPixels, offPixels] = await Promise.all(
        [on, off].map((buffer) => sharp(buffer).removeAlpha().raw().toBuffer()),
      );
      for (const probe of probes) {
        const i = (probe.y * 1280 + probe.x) * 3;
        probe.on = [...onPixels.subarray(i, i + 3)];
        probe.off = [...offPixels.subarray(i, i + 3)];
        probe.delta = Math.max(
          ...probe.on.map((value, channel) =>
            Math.abs(value - probe.off[channel]),
          ),
        );
      }
      report.groundDetail = {
        ...detail,
        probes,
        onSha256: sha(on),
        offSha256: sha(off),
      };
      check(
        'photoreal ground probes include real building roofs',
        detail.photoreal &&
          detail.settled &&
          probes.every((p) => Number.isFinite(p.heightM)) &&
          probes.some((p) => p.heightM > 100),
        report.groundDetail,
      );
      check(
        'ground classification paints five visible Google-tile surfaces',
        probes.every((p) => p.delta > 16),
        probes,
      );
      await page.evaluate(
        (id) => window.__godsEyeView.layers.enable(id),
        layer,
      );
    }
    // Lifecycle/idle uses normal application chrome, not the raster-only DOM.
    await page.evaluate(() => {
      for (const element of document.querySelectorAll('.w2-raster-hidden'))
        element.classList.remove('w2-raster-hidden');
    });
    const sourceLifecycle = await page.evaluate(async (id) => {
      const app = window.__godsEyeView;
      const module = app.dataManager.layers.get(id).module;
      const before = JSON.stringify(module.getAnalystRecords());
      window.__w2FailNext = true;
      const failed = await module.update(app.viewer);
      const retained = JSON.stringify(module.getAnalystRecords()) === before;
      const error = module.getStats().error;
      const recovered = await module.update(app.viewer);
      window.__w2DelayNext = true;
      const pending = module.update(app.viewer);
      await app.layers.disable(id);
      await app.layers.enable(id);
      window.__w2Release();
      const lateResult = await pending;
      return {
        failed,
        retained,
        error,
        recovered,
        lateResult,
        current: module.getAnalystRecords().length,
        recoveredError: module.getStats().error,
      };
    }, layer);
    report.sourceLifecycle = sourceLifecycle;
    check(
      'failed refresh retains last good records and recovers',
      sourceLifecycle.failed === false &&
        sourceLifecycle.retained &&
        sourceLifecycle.error?.includes('503') &&
        sourceLifecycle.recovered &&
        !sourceLifecycle.recoveredError,
      sourceLifecycle,
    );
    check(
      'cancelled late empty refresh cannot overwrite re-enabled data',
      sourceLifecycle.lateResult === false && sourceLifecycle.current === 15,
      sourceLifecycle,
    );
    if (!arg('diagnostic-pose')) {
      await sleep(2500);
      const hash = await page.evaluate(() => location.hash);
      report.shares = {};
      for (const opened of [
        engine,
        engine === 'cesium' ? 'navara' : 'cesium',
      ]) {
        const context = await browser.createBrowserContext();
        try {
          const shared = await context.newPage();
          observe(shared, `share-${opened}`);
          await shared.setViewport({ width: 1280, height: 800 });
          await shared.evaluateOnNewDocument(
            installFixture,
            earthquakeFixture(),
          );
          const sharedUrl = new URL(base);
          sharedUrl.searchParams.set('engine', opened);
          sharedUrl.hash = hash;
          await shared.goto(sharedUrl.href, {
            waitUntil: 'domcontentloaded',
            timeout: 180000,
          });
          const restored = await shared
            .waitForFunction(
              (id) => {
                const app = window.__godsEyeView;
                return (
                  app?.dataManager?.isEnabled(id) &&
                  app.dataManager.layers.get(id)?.module.getAnalystRecords()
                    .length === 15
                );
              },
              { timeout: 60000 },
              layer,
            )
            .then(() => true)
            .catch(() => false);
          const actualEngine = await shared.evaluate(
            () => window.__godsEyeView?.engine.kind,
          );
          report.shares[opened] = { restored, actualEngine };
          check(
            `share restores earthquake layer on ${opened}`,
            restored && actualEngine === opened,
          );
        } finally {
          await context.close();
        }
      }
    }
    if (!arg('diagnostic-pose')) {
      report.detectionModeBeforeEnabledIdle = await page.evaluate(async () => {
        const detection = await import('/src/data/detection.js');
        const mode = detection.getMode();
        detection.setMode('OFF');
        return mode;
      });
      await sleep(3500);
      report.enabledIdleFrames = await page.evaluate(async () => {
        let frames = 0;
        const stop =
          window.__godsEyeView.engine.frames.postRender.addEventListener(
            () => frames++,
          );
        await new Promise((resolve) => setTimeout(resolve, 2000));
        stop();
        return frames;
      });
      check(
        'enabled static earthquake layer has zero frames in 2s',
        report.enabledIdleFrames === 0,
        report.enabledIdleFrames,
      );
    }
    const lifecycle = await page.evaluate(async (id) => {
      const a = window.__godsEyeView,
        module = a.dataManager.layers.get(id).module;
      const before = {
        movers: a.engine.movers.list().length,
        lines: a.engine.lines.list().length,
        native: a.viewer?.dataSources.length ?? 0,
      };
      for (let i = 0; i < 10; i++) {
        await a.layers.disable(id);
        await a.layers.enable(id);
      }
      const after = {
        movers: a.engine.movers.list().length,
        lines: a.engine.lines.list().length,
        native: a.viewer?.dataSources.length ?? 0,
      };
      await a.layers.disable(id);
      return {
        before,
        after,
        disabledRecords: module.getAnalystRecords().length,
        sourceRequests: window.__w2Requests,
      };
    }, layer);
    report.lifecycle = lifecycle;
    check(
      'ten toggles preserve owned resource counts',
      JSON.stringify(lifecycle.before) === JSON.stringify(lifecycle.after) &&
        lifecycle.disabledRecords === 0 &&
        lifecycle.sourceRequests >= 11,
      lifecycle,
    );
    await page.evaluate(() => {
      const a = window.__godsEyeView;
      window.__w2IdleStacks = [];
      const target = a.viewer?.scene ?? a.engine.render;
      const key = a.viewer ? 'requestRender' : 'request';
      const original = target[key];
      target[key] = function (...args) {
        if (window.__w2IdleStacks.length < 40)
          window.__w2IdleStacks.push(new Error('QA render request').stack);
        return original.apply(this, args);
      };
      window.__w2RestoreRequest = () => {
        target[key] = original;
      };
    });
    report.detectionModeBeforeIdle = await page.evaluate(async () => {
      const detection = await import('/src/data/detection.js');
      const mode = detection.getMode();
      detection.setMode('OFF');
      return mode;
    });
    const idleReady = await page.evaluate(async () => {
      const e = window.__godsEyeView.engine;
      const start = performance.now();
      let since = null,
        previous = null,
        lastFrame = start,
        frames = 0;
      const stop = e.frames.postRender.addEventListener(() => {
        lastFrame = performance.now();
        frames++;
      });
      while (performance.now() - start < 90000) {
        const p = e.camera.pose().position;
        const still =
          previous &&
          Math.hypot(p.x - previous.x, p.y - previous.y, p.z - previous.z) <
            0.01;
        previous = { x: p.x, y: p.y, z: p.z };
        if (still && e.surface.tilesLoaded()) since ??= performance.now();
        else since = null;
        if (
          since !== null &&
          performance.now() - since >= 1500 &&
          performance.now() - lastFrame >= 1500
        ) {
          stop();
          return {
            ready: true,
            elapsedMs: performance.now() - start,
            framesWhileSettling: frames,
            tiles: e.surface.tilesLoaded(),
          };
        }
        await new Promise((r) => setTimeout(r, 100));
      }
      stop();
      return {
        ready: false,
        elapsedMs: performance.now() - start,
        framesWhileSettling: frames,
        tiles: e.surface.tilesLoaded(),
        governor: window.__godsEyeView.getRenderGovernorDiagnostics(),
      };
    });
    report.idleReady = idleReady;
    check(
      'disabled camera/tiles settle before idle sample',
      idleReady.ready,
      idleReady,
    );
    const idle = await page.evaluate(async () => {
      const app = window.__godsEyeView,
        e = app.engine;
      let frames = 0;
      const before = app.getRenderGovernorDiagnostics();
      const remove = e.frames.postRender.addEventListener(() => frames++);
      await new Promise((r) => setTimeout(r, 2000));
      remove();
      return { frames, before, after: app.getRenderGovernorDiagnostics() };
    });
    report.idleStacks = await page.evaluate(() => {
      window.__w2RestoreRequest();
      return window.__w2IdleStacks;
    });
    report.overlay = await page.evaluate(() =>
      window.__gevWorldOverlay.getDiagnostics(),
    );
    report.idle = idle;
    check(
      'disabled static scene has zero frames in 2s',
      idle.frames === 0,
      idle,
    );
  } catch (error) {
    check('scenario completes', false, error.message);
  } finally {
    await browser.close();
  }
  check(
    'all observed pages have no runtime errors',
    report.browserErrors.length === 0,
    report.browserErrors,
  );
  if (arg('diagnostic-pose'))
    check(
      'diagnostic subset is not full acceptance',
      false,
      arg('diagnostic-pose'),
    );
  report.pass = report.checks.length > 0 && report.checks.every((c) => c.pass);
  await fs.writeFile(out, JSON.stringify(report, null, 2) + '\n');
  console.log(
    `RESULT ${report.checks.filter((c) => c.pass).length}/${report.checks.length}`,
  );
  process.exitCode = report.pass ? 0 : 1;
}
