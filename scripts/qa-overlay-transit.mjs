#!/usr/bin/env node
import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import puppeteer from 'puppeteer';
import { processMemory } from './qa-process-memory.mjs';
import { execFileSync } from 'node:child_process';
const [
  base = 'http://127.0.0.1:4180',
  destination = 'qa-artifacts/overlay-transit/transit-before',
] = process.argv.slice(2);
const out = path.resolve(destination);
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
try {
  const page = await browser.newPage();
  await page.setViewport({ width: 1440, height: 860, deviceScaleFactor: 2 });
  page.on('pageerror', (e) => report.errors.push(e.message));
  await page.evaluateOnNewDocument(() => {
    localStorage.clear();
    window.fetch = new Proxy(window.fetch, {
      apply(target, receiver, args) {
        const u = String(args[0]?.url || args[0]);
        if (u.includes('/api/transit'))
          return Promise.resolve(
            new Response(
              JSON.stringify({ vehicles: [], fetchedAt: Date.now() }),
              { headers: { 'content-type': 'application/json' } },
            ),
          );
        return Reflect.apply(target, receiver, args);
      },
    });
  });
  await page.goto(`${base}/?welcome=0`);
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
    a.viewer.scene.renderError.addEventListener((_, e) => {
      window.__qaRenderErrors ||= [];
      window.__qaRenderErrors.push(String(e));
    });
    await a.dataManager.setEnabled('transit', true, { source: 'qa' });
  });
  const cdp = await page.createCDPSession();
  await cdp.send('Performance.enable');
  report.renderer = await page.evaluate(() => {
    const gl = window.__godsEyeView.viewer.scene.context._gl;
    return gl.getParameter(
      gl.getExtension('WEBGL_debug_renderer_info').UNMASKED_RENDERER_WEBGL,
    );
  });
  check('hardware renderer', !/swiftshader|llvmpipe/i.test(report.renderer));
  const metrics = async () =>
    Object.fromEntries(
      (await cdp.send('Performance.getMetrics')).metrics.map((m) => [
        m.name,
        m.value,
      ]),
    );
  const snapshot = () =>
    page.evaluate(() => {
      const l = window.__godsEyeView.dataManager.layers.get('transit').module,
        s = l._transitStateForTest();
      return {
        count: s._vehicles.size,
        residents: s._markers.length + s._animatedMarkers.length,
        visible: s._visible.size,
        moving: s._moving.size,
        analyst: l.getAnalystRecords().length,
        fixBytes: s._historyBudget.allocatedBytes,
        renderErrors: window.__qaRenderErrors || [],
      };
    });
  for (const [label, alt] of [
    ['city', 30000],
    ['street', 600],
  ]) {
    await page.evaluate((alt) => {
      const a = window.__godsEyeView,
        c = a.viewer.camera,
        C = c.positionCartographic.constructor;
      c.cancelFlight();
      c.setView({
        destination: C.toCartesian(C.fromDegrees(-71.0605, 42.3554, alt)),
        orientation: { heading: 0, pitch: -Math.PI / 2, roll: 0 },
      });
    }, alt);
    await wait(1500);
    await page.evaluate(() =>
      window.__godsEyeView.dataManager.layers
        .get('transit')
        .module._loadTransitFleetForTest(
          3000,
          { lat: 42.3554, lon: -71.0605 },
          120,
        ),
    );
    await wait(2000);
    await cdp.send('HeapProfiler.collectGarbage');
    for (let repeat = 0; repeat < 3; repeat++) {
      await page.evaluate(() =>
        window.__godsEyeView.dataManager.layers
          .get('transit')
          .module._resetTransitFixtureClockForTest(),
      );
      await wait(500);
      await page.evaluate(() => {
        const s = window.__godsEyeView.viewer.scene;
        window.__qaFrames = [];
        let previous = 0;
        window.__qaStop = s.postRender.addEventListener(() => {
          const t = performance.now();
          if (previous) window.__qaFrames.push(t - previous);
          previous = t;
        });
      });
      const start = await metrics();
      await wait(5000);
      const end = await metrics();
      const frame = await page.evaluate(() => {
        window.__qaStop();
        const f = window.__qaFrames;
        return {
          fps: (f.length * 1000) / f.reduce((a, b) => a + b, 0),
          p95: f.slice().sort((a, b) => a - b)[Math.floor(f.length * 0.95)],
        };
      });
      const heap = await cdp.send('Runtime.getHeapUsage');
      report.samples.push({
        label,
        repeat,
        ...frame,
        cpuPercent:
          ((end.TaskDuration - start.TaskDuration) /
            (end.Timestamp - start.Timestamp)) *
          100,
        heapBytes: heap.usedSize,
        ...(await snapshot()),
      });
    }
    await cdp.send('HeapProfiler.collectGarbage');
    report.samples.at(-1).retainedHeapBytes = (
      await cdp.send('Runtime.getHeapUsage')
    ).usedSize;
    const memory = processMemory(browser.process().pid);
    report.samples.at(-1).rssBytes = memory.browserRssBytes;
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
      report.samples.at(-1).physicalFootprintBytes = JSON.parse(
        await fs.readFile(file),
      )['total footprint'];
    } catch (e) {
      report.footprintError = e.message;
    }
    await page.screenshot({ path: path.join(out, `${label}.png`) });
    check(
      `${label}: full records retained`,
      (await snapshot()).analyst === 3000,
    );
  }
  const validation = await page.evaluate(async () => {
    const a = window.__godsEyeView,
      l = a.dataManager.layers.get('transit').module,
      s = l._transitStateForTest(),
      p = l._transitPartsForTest();
    const hidden = [...s._vehicles.values()].find((e) => !s._visible.has(e));
    const key = hidden?.key;
    p.selection.selectVehicle(key);
    const selected = s._selectedKey === key;
    const records = l.getAnalystRecords().length;
    const entry = s._vehicles.get(key);
    const c = a.viewer.camera,
      C = c.positionCartographic.constructor;
    c.setView({
      destination: C.toCartesian(
        C.fromDegrees(entry.record.lon, entry.record.lat, 600),
      ),
      orientation: { heading: 0, pitch: -Math.PI / 2, roll: 0 },
    });
    s._visibilityAt = 0;
    p.rendering.refreshVisibility();
    const recovered = !!entry.marker;
    await a.dataManager.setEnabled('transit', false, { source: 'qa' });
    return {
      selected,
      records,
      recovered,
      disabled: {
        vehicles: s._vehicles.size,
        markers: s._markers.length + s._animatedMarkers.length,
        moving: s._moving.size,
        held: s._renderHeld,
      },
    };
  });
  report.validation = validation;
  check('offscreen selected contact retained', validation.selected);
  check('offscreen records queryable', validation.records === 3000);
  check('camera reentry restores marker', validation.recovered);
  check(
    'disable releases vehicles, markers and render hold',
    validation.disabled.vehicles === 0 &&
      validation.disabled.markers === 0 &&
      !validation.disabled.held,
  );
  check(
    'no render errors',
    report.samples.every((s) => !s.renderErrors.length),
  );
  check('no JS errors', !report.errors.length);
} catch (e) {
  report.errors.push(e.stack);
  process.exitCode = 1;
} finally {
  await browser.close();
  await fs.writeFile(
    path.join(out, 'report.json'),
    JSON.stringify(report, null, 2),
  );
  console.log(JSON.stringify(report, null, 2));
}
