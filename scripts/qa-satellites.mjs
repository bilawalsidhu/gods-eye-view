#!/usr/bin/env node
// Phase 3 T14: one deterministic satellite catalog on both engines.
import fs from 'node:fs';
import path from 'node:path';
import puppeteer from 'puppeteer';
import { frozenClockScript } from '../src/tooling/w1Baseline.js';
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
  await page.evaluateOnNewDocument(frozenClockScript(SATELLITE_FIXTURE_EPOCH));
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
  await new Promise((r) => setTimeout(r, 6000));
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
      const { layers, dataManager } = window.__godsEyeView;
      const module = dataManager.layers.get('satellites').module;
      return {
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
    const { getOverlayPaintRect, getWorldOverlayDiagnostics } =
      await import('/src/overlays/worldOverlay.js');
    const { layers, dataManager } = window.__godsEyeView;
    const diagnostics = getWorldOverlayDiagnostics();
    return {
      painted: Boolean(getOverlayPaintRect('satellites-iss', '25544')),
      entries: diagnostics.entriesBySource,
      paintedBySource: diagnostics.paintedBySource,
      screen: layers.screenOf('satellites', 25544),
      params: dataManager.layers.get('satellites').module.getParams(),
      camera: window.__godsEyeView.engine.camera.pose().position,
      iss: dataManager.layers.get('satellites').module.findByQuery(25544)
        ?.position,
    };
  });
  check('ISS label painted by overlay host', label.painted, label);
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
  const selected = await page.evaluate(() => {
    const { dataManager } = window.__godsEyeView;
    return dataManager.layers.get('satellites').module.trackById(25544);
  });
  check('track ISS', selected);
  await new Promise((r) => setTimeout(r, 3000));
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
  await page.keyboard.press('Escape');
  check(
    'Escape clears tracking',
    !(await page.evaluate(() =>
      window.__godsEyeView.layers.selected('satellites'),
    )),
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
  check('no page errors', errors.length === 0, { count: errors.length });
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
