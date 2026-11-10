#!/usr/bin/env node
// Paired CPU check: pause the inactive renderer and alternate builds in one browser.
import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import puppeteer from 'puppeteer';
import { installTrafficRoutes } from './traffic-fixtures.mjs';
const [
  before = 'http://127.0.0.1:4180',
  after = 'http://127.0.0.1:4182',
  target = 'qa-artifacts/traffic-satellites/paired',
] = process.argv.slice(2);
const out = path.resolve(target);
await fs.mkdir(out, { recursive: true });
const report = {
  harnessSha256: createHash('sha256')
    .update(await fs.readFile(new URL(import.meta.url)))
    .digest('hex'),
  samples: [],
  checks: [],
  errors: [],
};
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const browser = await puppeteer.launch({
  headless: true,
  protocolTimeout: 180000,
  args: [
    '--no-sandbox',
    '--use-angle=metal',
    '--enable-gpu',
    '--disable-backgrounding-occluded-windows',
    '--disable-renderer-backgrounding',
    '--disable-background-timer-throttling',
  ],
});
const check = (name, pass) => {
  report.checks.push({ name, pass: !!pass });
  if (!pass) process.exitCode = 1;
};
const tabs = [];
async function boot(base) {
  const page = await browser.newPage();
  await page.setViewport({ width: 1440, height: 860, deviceScaleFactor: 2 });
  page.on('pageerror', (e) => report.errors.push(e.message));
  await installTrafficRoutes(page, {
    origin: new URL(base).origin,
    fixtures: true,
    keyless: true,
    roadSpacing: 16,
    onError: (e) => report.errors.push(String(e)),
  });
  await page.evaluateOnNewDocument(() => {
    localStorage.clear();
    let seed = 12345;
    Math.random = () =>
      (seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0) / 4294967296;
    const fetch = window.fetch.bind(window);
    window.fetch = (input, init) => {
      const u = new URL(input?.url || String(input), location.href);
      if (u.pathname.startsWith('/api/celestrak-satcat/'))
        return Promise.resolve(
          new Response(
            'OBJECT_NAME,OBJECT_ID,NORAD_CAT_ID,OBJECT_TYPE,OPS_STATUS_CODE,LAUNCH_DATE\n',
          ),
        );
      if (u.pathname.startsWith('/api/celestrak/')) {
        const group = u.pathname.split('/').at(-1),
          n =
            group === 'visual'
              ? 2000
              : group === 'starlink'
                ? 5000
                : group === 'stations'
                  ? 1
                  : 0,
          start =
            group === 'starlink' ? 70000 : group === 'stations' ? 25544 : 60000;
        const date = new Date(),
          year = date.getUTCFullYear(),
          day =
            (Date.UTC(year, date.getUTCMonth(), date.getUTCDate()) -
              Date.UTC(year, 0, 0)) /
            86400000;
        const epoch =
          String(year % 100).padStart(2, '0') +
          day.toFixed(8).padStart(12, '0');
        const text = Array.from({ length: n }, (_, i) => {
          const id = String(start + i),
            raan = ((i * 0.7) % 360).toFixed(4).padStart(8, '0');
          return `${group === 'stations' ? 'ISS' : group === 'starlink' ? 'STARLINK' : 'AUDIT'}-${id}\n1 ${id}U 98067A   ${epoch}  .00016717  00000-0  10270-3 0  9004\n2 ${id}  51.6416 ${raan} 0006703 130.5360 325.0288 15.49814310 12345`;
        }).join('\n');
        return Promise.resolve(new Response(text + '\n'));
      }
      return fetch(input, init);
    };
  });

  await page.goto(`${base}/?welcome=0&trafficRoads=osm`, {
    waitUntil: 'domcontentloaded',
  });
  await page.waitForFunction(
    () =>
      window.__godsEyeView?.styleManager &&
      document.getElementById('loading-screen')?.classList.contains('hidden'),
    { timeout: 90000 },
  );
  await page.evaluate(async () => {
    const a = window.__godsEyeView;
    await a.styleManager.initialRestorePromise;
    await a.performance?.ready;
    for (const [id, e] of a.dataManager.layers)
      if (e.enabled)
        await a.dataManager.setEnabled(id, false, { source: 'qa' });
    await a.styleManager.setMapStack('osm');
    a.viewer.camera.cancelFlight();
    a.viewer.scene.screenSpaceCameraController.enableCollisionDetection = false;
    window.__pairErrors = [];
    a.viewer.scene.renderError.addEventListener((_, e) =>
      window.__pairErrors.push(String(e)),
    );
    a.viewer.useDefaultRenderLoop = false;
  });
  const cdp = await page.createCDPSession();
  await cdp.send('Performance.enable');
  return { page, cdp };
}
const metrics = async (cdp) =>
  Object.fromEntries(
    (await cdp.send('Performance.getMetrics')).metrics.map((m) => [
      m.name,
      m.value,
    ]),
  );
async function prepare(tab, phase) {
  await tab.page.bringToFront();
  await tab.page.evaluate(async (phase) => {
    const a = window.__godsEyeView,
      c = a.viewer.camera,
      C = c.positionCartographic.constructor;
    a.viewer.useDefaultRenderLoop = true;
    c.cancelFlight();
    if (phase === 'traffic') {
      c.setView({
        destination: C.toCartesian(C.fromDegrees(-97.7431, 30.2672, 1500)),
        orientation: { heading: 0, pitch: -Math.PI / 2, roll: 0 },
      });
      a.dataManager.layers
        .get('traffic')
        .module.setParams({ roadMode: 'osm', densityScale: 2.5 });
      await a.dataManager.setEnabled('traffic', true, { source: 'qa' });
    } else if (phase === 'satellites-tracked') {
      await a.dataManager.setEnabled('traffic', false, { source: 'qa' });
      await a.dataManager.setEnabled('satellites', true, { source: 'qa' });
      a.dataManager.layers
        .get('satellites')
        .module.setParams({ catalog: 'dense' });
    } else {
      const s = a.dataManager.layers.get('satellites').module;
      s.setParams({ selectedSatTrackingId: null });
      c.setView({
        destination: C.toCartesian(C.fromDegrees(-97.7431, 30.2672, 1500)),
        orientation: { heading: 0, pitch: -Math.PI / 2, roll: 0 },
      });
      await a.dataManager.setEnabled('traffic', true, { source: 'qa' });
    }
  }, phase);
  await tab.page.waitForFunction(
    (phase) => {
      const a = window.__godsEyeView,
        t = a.dataManager.layers.get('traffic').module.getStats(),
        s = a.dataManager.layers.get('satellites').module.getStats();
      return phase === 'traffic'
        ? t.count > 1000 && !t.loading
        : phase === 'satellites-tracked'
          ? s.count === 7001
          : t.count > 1000 && !t.loading && s.count === 7001;
    },
    { timeout: 90000 },
    phase,
  );
  if (phase === 'satellites-tracked')
    await tab.page.evaluate(() =>
      window.__godsEyeView.dataManager.layers
        .get('satellites')
        .module.trackById(60000),
    );
  await wait(2000);
  await tab.page.evaluate(
    () => (window.__godsEyeView.viewer.useDefaultRenderLoop = false),
  );
}
async function sample(tab, label, build) {
  await tab.page.bringToFront();
  await tab.page.evaluate(
    () => (window.__godsEyeView.viewer.useDefaultRenderLoop = true),
  );
  await wait(1000);
  await tab.page.evaluate(() => {
    window.__pairFrames = [];
    let prev = 0;
    window.__pairStop =
      window.__godsEyeView.viewer.scene.postRender.addEventListener(() => {
        const now = performance.now();
        if (prev) window.__pairFrames.push(now - prev);
        prev = now;
      });
  });
  const a = await metrics(tab.cdp);
  await wait(4000);
  const b = await metrics(tab.cdp);
  const r = await tab.page.evaluate(() => {
    window.__pairStop();
    const a = window.__godsEyeView,
      f = window.__pairFrames;
    a.viewer.useDefaultRenderLoop = false;
    return {
      fps: (f.length * 1000) / f.reduce((a, b) => a + b, 0),
      traffic: a.dataManager.layers.get('traffic').module.getStats().count,
      satellites: a.dataManager.layers.get('satellites').module.getStats()
        .count,
      tracked: a.dataManager.layers.get('satellites').module.getTrackedInfo()
        ?.noradId,
      errors: window.__pairErrors,
    };
  });
  report.samples.push({
    label,
    build,
    ...r,
    cpuPercent:
      ((b.TaskDuration - a.TaskDuration) / (b.Timestamp - a.Timestamp)) * 100,
  });
}
try {
  tabs.push(await boot(before));
  tabs.push(await boot(after));
  for (const phase of ['traffic', 'satellites-tracked', 'combined']) {
    for (const tab of tabs) await prepare(tab, phase);
    for (const index of [0, 1, 1, 0, 0, 1])
      await sample(tabs[index], phase, index ? 'after' : 'before');
    console.log(
      phase,
      JSON.stringify(report.samples.filter((s) => s.label === phase)),
    );
  }
  for (const label of ['traffic', 'satellites-tracked', 'combined']) {
    const s = report.samples.filter((s) => s.label === label);
    check(
      `${label}: populations match`,
      s.every(
        (p) => p.traffic === s[0].traffic && p.satellites === s[0].satellites,
      ),
    );
  }
  check(
    'all scenes rendered without errors',
    report.samples.every((s) => s.errors.length === 0),
  );
  check('no JS errors', !report.errors.length);
} catch (e) {
  report.errors.push(e.stack);
  process.exitCode = 1;
} finally {
  await browser.close();
  await fs.writeFile(
    path.join(out, 'report.json'),
    JSON.stringify(report, null, 2) + '\n',
  );
  console.log(JSON.stringify({ checks: report.checks, errors: report.errors }));
}
