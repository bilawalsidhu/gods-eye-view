#!/usr/bin/env node
import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import puppeteer from 'puppeteer';
import { installTrafficRoutes } from './traffic-fixtures.mjs';
import { processMemory } from './qa-process-memory.mjs';
const [
  base = 'http://127.0.0.1:4180',
  target = 'qa-artifacts/traffic-satellites/before',
] = process.argv.slice(2);
const out = path.resolve(target);
await fs.mkdir(out, { recursive: true });
const report = {
  harnessSha256: createHash('sha256')
    .update(await fs.readFile(new URL(import.meta.url)))
    .digest('hex'),
  viewport: { width: 1440, height: 860, deviceScaleFactor: 2 },
  samples: [],
  checks: [],
  errors: [],
};
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const check = (name, pass) => {
  report.checks.push({ name, pass: !!pass });
  if (!pass) process.exitCode = 1;
};
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
try {
  const page = await browser.newPage();
  await page.setViewport(report.viewport);
  page.on('pageerror', (e) => report.errors.push(e.message));
  await installTrafficRoutes(page, {
    origin: new URL(base).origin,
    fixtures: true,
    roadSpacing: 16,
    keyless: true,
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
    window.__qaErrors = [];
    a.viewer.scene.renderError.addEventListener((_, e) =>
      window.__qaErrors.push(String(e)),
    );
  });
  report.renderer = await page.evaluate(() => {
    const gl = window.__godsEyeView.viewer.scene.context._gl;
    return gl.getParameter(
      gl.getExtension('WEBGL_debug_renderer_info').UNMASKED_RENDERER_WEBGL,
    );
  });
  check('hardware GPU', !/swiftshader|llvmpipe/i.test(report.renderer));
  const cdp = await page.createCDPSession();
  await cdp.send('Performance.enable');
  const metrics = async () =>
    Object.fromEntries(
      (await cdp.send('Performance.getMetrics')).metrics.map((x) => [
        x.name,
        x.value,
      ]),
    );
  const view = async (lon, lat, alt) => {
    await page.evaluate(
      ({ lon, lat, alt }) => {
        const a = window.__godsEyeView,
          c = a.viewer.camera,
          C = c.positionCartographic.constructor;
        c.cancelFlight();
        c.setView({
          destination: C.toCartesian(C.fromDegrees(lon, lat, alt)),
          orientation: { heading: 0, pitch: -Math.PI / 2, roll: 0 },
        });
      },
      { lon, lat, alt },
    );
  };
  const snapshot = () =>
    page.evaluate(() => {
      const a = window.__godsEyeView,
        t = a.dataManager.layers.get('traffic').module,
        s = a.dataManager.layers.get('satellites').module;
      return {
        traffic: t.getStats(),
        satellites: s.getStats(),
        satTracked: s.getTrackedInfo()?.noradId,
        sceneErrors: window.__qaErrors,
        canvas: {
          width: a.viewer.scene.drawingBufferWidth,
          height: a.viewer.scene.drawingBufferHeight,
        },
        detection: a.styleManager.getDetectionDiagnostics?.(),
      };
    });
  const sample = async (label) => {
    await wait(2000);
    await cdp.send('HeapProfiler.collectGarbage');
    for (let repeat = 0; repeat < 3; repeat++) {
      await page.evaluate(() => {
        const a = window.__godsEyeView;
        window.__frames = [];
        let previous = 0;
        window.__stopFrames = a.viewer.scene.postRender.addEventListener(() => {
          const now = performance.now();
          if (previous) window.__frames.push(now - previous);
          previous = now;
        });
      });
      const start = await metrics();
      await wait(5000);
      const end = await metrics();
      const frames = await page.evaluate(() => {
        window.__stopFrames();
        const f = window.__frames;
        return {
          fps: f.length ? (f.length * 1000) / f.reduce((a, b) => a + b, 0) : 0,
          p95: f.slice().sort((a, b) => a - b)[Math.floor(f.length * 0.95)],
        };
      });
      report.samples.push({
        label,
        repeat,
        ...frames,
        cpuPercent:
          ((end.TaskDuration - start.TaskDuration) /
            (end.Timestamp - start.Timestamp)) *
          100,
        ...(await snapshot()),
      });
    }
    await cdp.send('HeapProfiler.collectGarbage');
    const e = report.samples.at(-1);
    e.heap = await cdp.send('Runtime.getHeapUsage');
    const memory = processMemory(browser.process().pid);
    e.rssBytes = memory.browserRssBytes;
    try {
      const file = path.join(out, `${label}-footprint.json`);
      execFileSync(
        'footprint',
        [
          '--json',
          file,
          '--format',
          'bytes',
          '--noCategories',
          ...memory.processes.flatMap((p) => ['-p', String(p.pid)]),
        ],
        { stdio: 'ignore', timeout: 15000 },
      );
      e.physicalFootprintBytes = JSON.parse(await fs.readFile(file))[
        'total footprint'
      ];
    } catch (err) {
      e.footprintError = String(err);
    }
    await page.screenshot({ path: path.join(out, `${label}.png`) });
    console.log(
      label,
      JSON.stringify(
        report.samples
          .filter((s) => s.label === label)
          .map((s) => ({
            fps: s.fps,
            cpu: s.cpuPercent,
            traffic: s.traffic.count,
            satellites: s.satellites.count,
          })),
      ),
    );
  };
  await view(-97.7431, 30.2672, 1500);
  await page.evaluate(async () => {
    const a = window.__godsEyeView;
    a.dataManager.layers
      .get('traffic')
      .module.setParams({ roadMode: 'osm', densityScale: 2.5 });
    await a.dataManager.setEnabled('traffic', true, { source: 'qa' });
  });
  await page.waitForFunction(
    () => {
      const t = window.__godsEyeView.dataManager.layers
        .get('traffic')
        .module.getStats();
      return t.count > 1000 && !t.loading;
    },
    { timeout: 90000 },
  );
  await sample('traffic-detection');
  const identity = await page.evaluate(() => {
    const l = window.__godsEyeView.dataManager.layers.get('traffic').module,
      a = l.getDetectableObjects({ maxCount: 100 }),
      b = l.getDetectableObjects({ maxCount: 100 });
    return {
      count: l.getStats().count,
      objects: a.length,
      stable: a.filter((x, i) => x === b[i]).length,
    };
  });
  report.trafficIdentity = identity;
  check('traffic populated', identity.count > 1000);
  await page.evaluate(() =>
    window.__godsEyeView.styleManager._setDetectionMode('OFF'),
  );
  await sample('traffic-without-detection');
  await page.evaluate(async () => {
    const a = window.__godsEyeView;
    await a.dataManager.setEnabled('traffic', false, { source: 'qa' });
    a.styleManager._setDetectionMode('DENSE');
  });
  check('traffic disable clears dots', (await snapshot()).traffic.count === 0);
  await view(-98, 38, 22000000);
  await page.evaluate(async () => {
    const a = window.__godsEyeView;
    await a.dataManager.setEnabled('satellites', true, { source: 'qa' });
    a.dataManager.layers
      .get('satellites')
      .module.setParams({ catalog: 'dense' });
  });
  await page.waitForFunction(
    () =>
      window.__godsEyeView.dataManager.layers
        .get('satellites')
        .module.getStats().count === 7001,
    { timeout: 90000 },
  );
  await sample('satellites-global');
  const find = await page.evaluate(() => {
    const s = window.__godsEyeView.dataManager.layers.get('satellites').module;
    const f = s.findByQuery('AUDIT-60000');
    return {
      found: !!f,
      records: s.getAnalystRecords(10000).length,
      tracked: s.trackById(60000),
    };
  });
  report.satelliteSearch = find;
  check('all 7001 satellites queryable', find.records === 7001);
  check('satellite name search works', find.found);
  check('satellite tracking starts', find.tracked);
  await wait(3000);
  await sample('satellites-tracked');
  report.tracked = await page.evaluate(() => {
    const a = window.__godsEyeView,
      s = a.dataManager.layers.get('satellites').module;
    return { info: s.getTrackedInfo(), owned: !!a.viewer.trackedEntity };
  });
  check('satellite owns follow camera', report.tracked.owned);
  await page.evaluate(() =>
    window.__godsEyeView.dataManager.setEnabled('satellites', false, {
      source: 'qa',
    }),
  );
  await sample('satellites-disabled');
  await page.evaluate(() =>
    window.__godsEyeView.dataManager.setEnabled('satellites', true, {
      source: 'qa',
    }),
  );
  await page.waitForFunction(
    () =>
      window.__godsEyeView.dataManager.layers
        .get('satellites')
        .module.getStats().count === 7001,
    { timeout: 90000 },
  );
  check(
    'satellite reenable preserves catalog',
    (await snapshot()).satellites.count === 7001,
  );
  check(
    'no render errors',
    report.samples.every((s) => !s.sceneErrors.length),
  );
  check('no JavaScript errors', !report.errors.length);
} catch (e) {
  report.errors.push(e.stack);
  process.exitCode = 1;
} finally {
  await browser.close();
  await fs.writeFile(
    path.join(out, 'report.json'),
    JSON.stringify(report, null, 2) + '\n',
  );
  console.log(
    JSON.stringify({ checks: report.checks, errors: report.errors }, null, 2),
  );
}
