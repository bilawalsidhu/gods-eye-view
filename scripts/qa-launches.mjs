#!/usr/bin/env node
// Phase-3 mission acceptance: actual LL2 parsing, UI selection and replay frames.
import { watchW1Page } from './qa-browserEvidence.mjs';
import fs from 'node:fs';
import path from 'node:path';
import puppeteer from 'puppeteer';
import sharp from 'sharp';
import { LAUNCH_FIXTURE_EPOCH } from '../src/bench/launchFixture.js';
const arg = (name) =>
  process.argv.find((v) => v.startsWith(`--${name}=`))?.slice(name.length + 3);
const base = arg('base-url'),
  kind = arg('engine') ?? 'cesium';
if (
  !base ||
  [4173, 4185, 4186, 4187, 4188, 4189].includes(Number(new URL(base).port))
)
  throw new Error('Supply an unreserved --base-url');
const out = arg('out') ?? `qa-artifacts/t15/${kind}.json`;
const report = { engine: kind, checks: [], snapshots: {} };
report.expectedPreviewErrors = [];
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
const errors = (report.browserErrors = []);
const observePage = (page, name) =>
  watchW1Page(page, report, {
    name,
    preview: process.argv.includes('--preview'),
    baseUrl: base,
  });
try {
  fs.mkdirSync(path.dirname(out), { recursive: true });
  const page = await browser.newPage();
  await page.setViewport({ width: 1280, height: 800 });
  observePage(page, 'main');
  await page.evaluateOnNewDocument(() =>
    localStorage.setItem('gev:first-run-mission:v1', 'suppressed'),
  );
  const url = new URL(base);
  url.searchParams.set('engine', kind);
  url.searchParams.set('qaFeed', 'launches:fixture');
  await page.goto(url.href, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => Boolean(window.__godsEyeView?.layers), {
    timeout: 180000,
  });
  await page.evaluate(
    () => window.__godsEyeView.styleManager.initialRestorePromise,
  );
  await new Promise((r) => setTimeout(r, 6000));
  const clockIdentity = await page.evaluate(async (epoch) => {
    const { appClock } = await import('/src/time/clock.js');
    appClock.freeze(epoch);
    const { engine, layers, dataManager, styleManager } = window.__godsEyeView;
    styleManager.orbitController.stop();
    engine.camera.cancelFlight();
    for (const [id] of dataManager.layers)
      if (dataManager.isEnabled(id)) await layers.disable(id);
    await layers.enable('rocket-launches');
    return { moduleMs: appClock.now(), engineMs: engine.clock.now() };
  }, LAUNCH_FIXTURE_EPOCH);
  report.clockIdentity = clockIdentity;
  check(
    'QA imports share the running engine clock',
    clockIdentity.moduleMs === LAUNCH_FIXTURE_EPOCH &&
      clockIdentity.engineMs === LAUNCH_FIXTURE_EPOCH,
    clockIdentity,
  );
  await page.waitForFunction(
    () =>
      window.__godsEyeView.dataManager.layers
        .get('rocket-launches')
        .module.getStats().count === 3,
    { timeout: 60000 },
  );
  await new Promise((r) => setTimeout(r, 3500));
  const read = () =>
    page.evaluate(() => {
      const { layers, dataManager, engine } = window.__godsEyeView;
      return {
        drawn: layers.drawn('rocket-launches'),
        stats: dataManager.layers.get('rocket-launches').module.getStats(),
        camera: engine.camera.pose(),
      };
    });
  report.snapshots.all = await read();
  check('three LL2 missions parsed', report.snapshots.all.stats.count === 3);
  check(
    'ISS uses the shared TLE catalog',
    report.snapshots.all.stats.orbitMatches === 1,
    report.snapshots.all.stats,
  );
  check(
    'three mission pad markers',
    report.snapshots.all.drawn.points.filter((p) =>
      p.id.startsWith('rocket-launch:'),
    ).length === 3,
  );
  report.views = {};
  for (const [name, height] of [
    ['global', 24000000],
    ['city', 200000],
    ['orbit', 3000000],
  ]) {
    await page.evaluate(async (height) => {
      const { engine } = window.__godsEyeView;
      const geo = await import('/src/geo/index.js');
      engine.camera.setView({
        destination: geo.cartesian3.fromDegrees(-80.604333, 28.608389, height),
        orientation: { heading: 0, pitch: -Math.PI / 2, roll: 0 },
      });
      engine.render.request('qa-launch-view');
    }, height);
    await new Promise((r) => setTimeout(r, 350));
    report.views[name] = await page.evaluate(() => {
      const { engine, layers } = window.__godsEyeView;
      const drawn = layers.drawn('rocket-launches');
      return {
        camera: engine.camera.pose(),
        points: drawn.points.map((p) => ({
          ...p,
          screen: engine.projector.worldToWindow(p.position) ?? null,
        })),
        paths: drawn.paths,
        rings: drawn.rings,
      };
    });
    const screenshot = await page.screenshot({
      path: out.replace(/\.json$/, `-view-${name}.png`),
    });
    const { data, info } = await sharp(screenshot)
      .ensureAlpha()
      .raw()
      .toBuffer({ resolveWithObject: true });
    report.views[name].pixels = report.views[name].points
      .filter(
        (p) =>
          p.show &&
          p.screen &&
          p.screen.x > 350 &&
          p.screen.x < 950 &&
          p.screen.y > 200 &&
          p.screen.y < 650,
      )
      .map((p) => {
        let distance = Infinity;
        for (
          let y = Math.floor(p.screen.y) - 5;
          y <= Math.ceil(p.screen.y) + 5;
          y++
        )
          for (
            let x = Math.floor(p.screen.x) - 5;
            x <= Math.ceil(p.screen.x) + 5;
            x++
          ) {
            const offset = (y * info.width + x) * 4;
            distance = Math.min(
              distance,
              Math.hypot(
                data[offset] - p.color[0] * 255,
                data[offset + 1] - p.color[1] * 255,
                data[offset + 2] - p.color[2] * 255,
              ),
            );
          }
        return { id: p.id, colorDistance: distance };
      });
  }
  await page.evaluate(
    (pose) =>
      window.__godsEyeView.engine.camera.setView({
        destination: pose.position,
        orientation: { direction: pose.direction, up: pose.up },
      }),
    report.snapshots.all.camera,
  );
  await new Promise((r) => setTimeout(r, 350));
  check(
    'marker class colors present in actual pixels',
    Object.values(report.views).every(
      (v) =>
        v.pixels.length > 0 && v.pixels.every((p) => p.colorDistance <= 60),
    ),
    Object.fromEntries(
      Object.entries(report.views).map(([k, v]) => [k, v.pixels]),
    ),
  );
  check(
    'supplied stage paths rendered separately',
    report.views.global.paths.filter((p) =>
      p.id.startsWith('rocket-trajectory:'),
    ).length === 2,
  );
  report.voice = await page.evaluate(async () => {
    const { createGevActionRunner } = await import('/src/voice/gevActions.js');
    const app = window.__godsEyeView;
    const run = createGevActionRunner(app);
    try {
      return {
        records: app.dataManager.layers
          .get('rocket-launches')
          .module.getAnalystRecords(),
        answer: await run('analyst_query', {
          layers: ['rocket-launches'],
          scope: { kind: 'anywhere' },
          limit: 5,
        }),
      };
    } finally {
      run.dispose();
    }
  });
  check(
    'mission analyst query through runner',
    report.voice.answer.ok && report.voice.answer.items?.length === 3,
    {
      ok: report.voice.answer.ok,
      code: report.voice.answer.code,
      count: report.voice.answer.items?.length,
    },
  );
  const screen = await page.evaluate(() => {
    const { engine, layers } = window.__godsEyeView;
    const p = layers
      .drawn('rocket-launches')
      .points.find((p) => p.id === 'rocket-launch:qa-iss');
    return engine.projector.worldToWindow(p.position);
  });
  await page.mouse.click(screen.x, screen.y);
  await new Promise((r) => setTimeout(r, 1600));
  check(
    'real pad click selects ISS mission',
    (await read()).drawn.selected === 'qa-iss',
  );
  check(
    'mission panel contains payload',
    await page.evaluate(() =>
      document
        .getElementById('space-mission-panel')
        ?.textContent.includes('ISS (ZARYA)'),
    ),
  );
  await page.mouse.click(420, 600);
  await page.keyboard.press('Escape');
  check(
    'empty click and Escape retain legacy mission selection',
    (await read()).drawn.selected === 'qa-iss',
  );
  await page.screenshot({ path: out.replace(/\.json$/, '-selected.png') });
  await page.evaluate(() =>
    document.querySelector('[data-mission-focus]').click(),
  );
  await new Promise((r) => setTimeout(r, 2200));
  report.snapshots.pad = await read();
  check(
    'focus flies close to launch site',
    report.snapshots.pad.camera.cartographic.height < 150000,
  );
  check('launch-pad zone visible', report.snapshots.pad.drawn.padVisible);
  await page.screenshot({ path: out.replace(/\.json$/, '-pad.png') });
  await page.evaluate(() => {
    const speed = document.querySelector('[data-mission-replay-speed]');
    speed.value = '4';
    speed.dispatchEvent(new Event('input', { bubbles: true }));
    document.querySelector('[data-mission-replay]').click();
  });
  await new Promise((r) => setTimeout(r, 2000));
  check(
    'replay starts at speed four',
    (await read()).drawn.speed === 4 && (await read()).drawn.replay.active,
  );
  report.timeline = await page.evaluate(async (epoch) => {
    const { engine, layers } = window.__godsEyeView;
    const { appClock } = await import('/src/time/clock.js');
    const frames = [],
      checkpoints = [],
      ascent = layers.drawn('rocket-launches').replay.ascentDurationSec;
    const targets = [
      5,
      14,
      ...[0.1, 0.3, 0.6, 0.9].map((p) => 15 + (ascent * p) / 4),
      ...[0, 0.05, 0.1, 0.2, 0.5, 0.9].map(
        (p) => 15 + ascent / 4 + (28 * p) / 4,
      ),
    ];
    let i = 0,
      index = 0;
    await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        remove();
        reject(new Error('Replay frames stopped'));
      }, 45000);
      const remove = engine.frames.postRender.addEventListener(() => {
        const elapsed = (appClock.frameTime() - epoch) / 1000;
        while (index < targets.length && elapsed >= targets[index]) {
          const drawn = layers.drawn('rocket-launches');
          const p = engine.camera.pose();
          checkpoints.push({
            at: targets[index],
            elapsed,
            camera: p,
            replay: drawn.replay,
            pad: drawn.padVisible,
            glyph: (() => {
              const e = document.querySelector(
                '.mission-replay-vehicle-overlay',
              );
              return {
                hidden: e?.hidden,
                mode: e?.dataset.mode,
                svg: Boolean(e?.querySelector('svg')),
              };
            })(),
          });
          index++;
        }
        if (elapsed >= 15 + (ascent + 28) / 4 + 0.5) {
          remove();
          clearTimeout(timeout);
          resolve();
          return;
        }
        appClock.freeze(epoch + Math.round((++i * 1000) / 60));
        engine.render.request('qa-launch-replay');
      });
      engine.render.request('qa-launch-replay');
    });
    return { ascentDurationSec: ascent, checkpoints };
  }, LAUNCH_FIXTURE_EPOCH);
  const checkpoints = report.timeline.checkpoints;
  check(
    'full ten-second countdown after preparation',
    checkpoints[0].replay.countdownSeconds === 10 &&
      checkpoints[1].replay.countdownSeconds === 1,
  );
  check(
    'ten camera checkpoints cover ascent and orbit',
    checkpoints.length === 12 &&
      checkpoints.slice(2, 6).every((s) => s.replay.ascending) &&
      checkpoints.slice(6).every((s) => !s.replay.ascending),
  );
  check(
    'replay vehicle overlay visible in ascent and orbit',
    checkpoints
      .slice(2, 6)
      .every(
        (p) => !p.glyph.hidden && p.glyph.svg && p.glyph.mode === 'ascent',
      ) &&
      checkpoints
        .slice(6)
        .some((p) => !p.glyph.hidden && p.glyph.mode === 'orbit'),
  );
  report.snapshots.orbit = await read();
  await page.screenshot({ path: out.replace(/\.json$/, '-orbit.png') });
  await page.evaluate(() =>
    document.querySelector('[data-mission-replay-toggle]').click(),
  );
  const paused = (await read()).drawn.replay.phaseProgress;
  await page.evaluate(async () => {
    const { appClock } = await import('/src/time/clock.js');
    appClock.freeze(appClock.now() + 10000);
  });
  await new Promise((r) => setTimeout(r, 200));
  check(
    'pause holds replay progress',
    (await read()).drawn.replay.phaseProgress === paused,
  );
  await page.evaluate(() =>
    document.querySelector('[data-mission-replay-toggle]').click(),
  );
  check(
    'resume keeps replay continuity',
    Math.abs((await read()).drawn.replay.phaseProgress - paused) < 0.001,
  );
  await page.evaluate(() =>
    document.querySelector('[data-mission-replay-cancel]').click(),
  );
  check('cancel releases replay camera', !(await read()).drawn.replay.active);
  await page.evaluate(() =>
    document.querySelector('[data-mission-show-all]').click(),
  );
  check('deselect returns to all missions', !(await read()).drawn.selected);
  await page.evaluate(() =>
    window.__godsEyeView.layers.disable('rocket-launches'),
  );
  check(
    'disable restores initially-off satellites',
    !(await page.evaluate(() =>
      window.__godsEyeView.dataManager.isEnabled('satellites'),
    )),
  );
  const shareHash = await page.evaluate(async () => {
    const { layers, engine, styleManager } = window.__godsEyeView;
    await layers.enable('rocket-launches');
    engine.camera.cancelFlight();
    return styleManager.shareLinkManager._buildHashParams().toString();
  });
  report.share = {};
  for (const opened of [kind, kind === 'cesium' ? 'navara' : 'cesium']) {
    const context = await browser.createBrowserContext();
    try {
      const shared = await context.newPage();
      observePage(shared, `share-${opened}`);
      await shared.setViewport({ width: 1280, height: 800 });
      await shared.evaluateOnNewDocument(() =>
        localStorage.setItem('gev:first-run-mission:v1', 'suppressed'),
      );
      const destination = new URL(url);
      destination.searchParams.set('engine', opened);
      destination.hash = shareHash;
      await shared.goto(destination.href, { waitUntil: 'domcontentloaded' });
      await shared.waitForFunction(
        () => Boolean(window.__godsEyeView?.layers),
        { timeout: 180000 },
      );
      await shared.evaluate(
        () => window.__godsEyeView.styleManager.initialRestorePromise,
      );
      const restored = await shared
        .waitForFunction(
          () =>
            window.__godsEyeView.dataManager.isEnabled('rocket-launches') &&
            window.__godsEyeView.layers.drawn('rocket-launches')?.records
              .length === 3,
          { timeout: 60000 },
        )
        .then(() => true)
        .catch(() => false);
      report.share[opened] = { restored };
      check(`share restores enabled missions on ${opened}`, restored);
    } finally {
      await context.close();
    }
  }
  await page.evaluate(() =>
    window.__godsEyeView.layers.disable('rocket-launches'),
  );
  report.cycles = await page.evaluate(async () => {
    const { layers, engine, dataManager, styleManager, viewer } =
      window.__godsEyeView;
    const samples = [];
    for (let i = 0; i < 10; i++) {
      await layers.enable('rocket-launches');
      engine.camera.cancelFlight();
      await new Promise((r) => setTimeout(r, 80));
      await layers.disable('rocket-launches');
      await new Promise((r) => setTimeout(r, 30));
      samples.push({
        sets: engine.movers.list().length,
        movers: engine.movers.list().reduce((n, s) => n + s.count, 0),
        lines: engine.lines.list().length,
        shownLines: engine.lines.list().filter((s) => s.shown).length,
        primitives: viewer?.scene.primitives.length ?? null,
        sources: viewer?.dataSources.length ?? null,
      });
    }
    styleManager.orbitController.stop();
    engine.camera.cancelFlight();
    return samples;
  });
  check(
    'ten cycles keep resource counts bounded',
    report.cycles.every(
      (s) => JSON.stringify(s) === JSON.stringify(report.cycles[0]),
    ),
    report.cycles,
  );
  check(
    'disabled movers and paths are hidden',
    report.cycles.every((s) => s.movers === 0 && s.shownLines === 0),
  );
  await page.evaluate(async () => {
    const { appClock } = await import('/src/time/clock.js');
    appClock.resume();
  });
  await new Promise((r) => setTimeout(r, 5000));
  report.idle = await page.evaluate(async () => {
    const { layers, engine, getRenderGovernorDiagnostics } =
      window.__godsEyeView;
    // As in the engine shell, "settled" requires tile readiness and a still
    // camera. Do not wait for zero frames: that is the measured assertion.
    const started = performance.now();
    let stableSince = null,
      previous = null,
      ready = false;
    let tilesReady = false,
      cameraDeltaM = null;
    while (performance.now() - started < 90000) {
      const pose = engine.camera.pose();
      const current = [
        pose.position.x,
        pose.position.y,
        pose.position.z,
        pose.heading,
        pose.pitch,
        pose.roll,
      ];
      cameraDeltaM = previous
        ? Math.hypot(...current.slice(0, 3).map((v, i) => v - previous[i]))
        : null;
      const still =
        previous &&
        cameraDeltaM < 0.01 &&
        current.slice(3).every((v, i) => Math.abs(v - previous[i + 3]) < 1e-6);
      tilesReady = engine.surface.tilesLoaded();
      if (!tilesReady || !still) stableSince = null;
      else if (stableSince === null) stableSince = performance.now();
      else if (performance.now() - stableSince >= 1500) {
        ready = true;
        break;
      }
      previous = current;
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
    const settling = {
      ready,
      elapsedMs: performance.now() - started,
      tilesReady,
      cameraDeltaM,
    };
    const tilesReadyBefore = engine.surface.tilesLoaded();
    const before = layers.framesDrawn();
    await new Promise((r) => setTimeout(r, 2000));
    return {
      frames: layers.framesDrawn() - before,
      settling,
      tilesReadyBefore,
      tilesReadyAfter: engine.surface.tilesLoaded(),
      governor: getRenderGovernorDiagnostics(),
      continuous: engine.render.isContinuous(),
    };
  });
  check(
    'disabled layer releases continuous rendering',
    !report.idle.continuous,
    report.idle,
  );
  check(
    'settled disabled view draws zero frames in two seconds',
    report.idle.settling.ready && report.idle.frames === 0,
    report.idle,
  );
  await page.evaluate(async () => {
    const { layers, dataManager } = window.__godsEyeView;
    await layers.enable('satellites');
    dataManager.setLayerParams(
      'satellites',
      { catalog: 'core', showPoints: true, showOrbits: true },
      { origin: 'user' },
    );
  });
  await page.waitForFunction(
    () =>
      window.__godsEyeView.dataManager.layers
        .get('satellites')
        .module.getStats().count === 839,
    { timeout: 60000 },
  );
  report.satelliteHandoff = await page.evaluate(async () => {
    const { layers, dataManager, engine } = window.__godsEyeView;
    const satellite = dataManager.layers.get('satellites').module;
    const tracked = satellite.trackById(25544);
    await new Promise((r) => setTimeout(r, 300));
    await layers.enable('rocket-launches');
    engine.camera.cancelFlight();
    await new Promise((r) => setTimeout(r, 300));
    const during = {
      params: satellite.getParams(),
      tracked: satellite.getTrackedInfo(),
      following: Boolean(engine.camera.following()),
    };
    await layers.disable('rocket-launches');
    await new Promise((r) => setTimeout(r, 500));
    const after = {
      enabled: dataManager.isEnabled('satellites'),
      params: satellite.getParams(),
      tracked: satellite.getTrackedInfo(),
    };
    await layers.disable('satellites');
    return { tracked, during, after };
  });
  check(
    'mission camera releases existing satellite tracking',
    report.satelliteHandoff.tracked &&
      !report.satelliteHandoff.during.tracked &&
      !report.satelliteHandoff.during.following,
    report.satelliteHandoff.during,
  );
  check(
    'Context restores satellite visibility, palette and target',
    report.satelliteHandoff.after.enabled &&
      report.satelliteHandoff.after.params.catalog === 'core' &&
      report.satelliteHandoff.after.params.showPoints &&
      report.satelliteHandoff.after.params.showOrbits &&
      report.satelliteHandoff.after.params.selectedSatTrackingId === 25544,
    report.satelliteHandoff.after,
  );
  report.destroy = await page.evaluate(async () => {
    const { dataManager, engine, viewer } = window.__godsEyeView;
    await dataManager.layers.get('rocket-launches').module.destroy(viewer);
    await dataManager.layers.get('satellites').module.destroy(viewer);
    await Promise.resolve();
    return {
      movers: engine.movers.list().length,
      lines: engine.lines.list().length,
    };
  });
  check(
    'destroy releases mover sets and lines',
    report.destroy.movers === 0 && report.destroy.lines === 0,
    report.destroy,
  );
} finally {
  await browser.close();
  check('no runtime errors', errors.length === 0, {
    count: errors.length,
    messages: errors.map((e) => e.replace(/https?:[^ ]+/g, '[URL]')),
  });
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, JSON.stringify(report, null, 2));
}
const passed = report.checks.filter((c) => c.ok).length;
console.log(`[launches] ${passed}/${report.checks.length} passed`);
process.exitCode = passed === report.checks.length ? 0 : 1;
