#!/usr/bin/env node
// Phase-3 mission acceptance: actual LL2 parsing, UI selection and replay frames.
import fs from 'node:fs';
import path from 'node:path';
import puppeteer from 'puppeteer';
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
  fs.mkdirSync(path.dirname(out), { recursive: true });
  const page = await browser.newPage();
  await page.setViewport({ width: 1280, height: 800 });
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => {
    if (m.type() === 'error' && m.text().includes('Rendering has stopped')) {
      const error = m.text().replace(/https?:[^ )]+/g, '[URL]');
      errors.push(error);
      console.log(error.slice(0, 1200));
    }
  });
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
  await page.evaluate(async (epoch) => {
    const { appClock } = await import('/src/time/clock.js');
    appClock.freeze(epoch);
    const { engine, layers, dataManager, styleManager } = window.__godsEyeView;
    styleManager.orbitController.stop();
    engine.camera.cancelFlight();
    for (const [id] of dataManager.layers)
      if (dataManager.isEnabled(id)) await layers.disable(id);
    await layers.enable('rocket-launches');
  }, LAUNCH_FIXTURE_EPOCH);
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
  check('no runtime errors', errors.length === 0, {
    count: errors.length,
    messages: errors.map((e) => e.replace(/https?:[^ ]+/g, '[URL]')),
  });
} finally {
  await browser.close();
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, JSON.stringify(report, null, 2));
}
const passed = report.checks.filter((c) => c.ok).length;
console.log(`[launches] ${passed}/${report.checks.length} passed`);
process.exitCode = passed === report.checks.length ? 0 : 1;
