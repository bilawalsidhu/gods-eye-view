#!/usr/bin/env node
/**
 * Repeatable memory journey. Run against a running dev or preview server:
 *   npm run qa:memory -- --out qa-artifacts/memory/before --cycles 3
 *   npm run qa:memory -- --out qa-artifacts/memory/after --baseline qa-artifacts/memory/before/report.json
 *
 * CDP heap collection is diagnostic only: production never forces GC. RSS is
 * sampled for this browser's process tree, not unrelated Chrome windows. RSS
 * sums can double-count shared pages; Cesium tile bytes are estimates, not
 * total GPU memory. Compare runs with the same browser, viewport and workload.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import puppeteer from 'puppeteer';
import { processMemory } from './qa-process-memory.mjs';
import {
  redact,
  hookRenderErrors,
  readRenderErrors,
  watchPage,
} from './qa-browserEvidence.mjs';

const args = process.argv.slice(2);
if (args.includes('--help')) {
  console.log(`Usage: npm run qa:memory -- [options]
  --url URL             Running app (default http://127.0.0.1:4173)
  --out DIRECTORY       Reports/screenshots (default qa-artifacts/memory/latest)
  --baseline FILE       Compare matching checkpoints and data with report.json
  --cycles N            Toggle/map journeys, 1–20 (default 3)
  --settle-ms N         Settling before each measurement, >=1000 (default 3000)
  --layers IDS          Comma-separated bundled layers (default local-datacenters,local-dams)
  --server-pid PID      Also sample the local Node server's RSS
  --headful             Show the benchmark browser`);
  process.exit(0);
}
const option = (name, fallback) => {
  const index = args.indexOf(name);
  return index < 0 ? fallback : args[index + 1];
};
const cycles = Number(option('--cycles', '3'));
const settleMs = Number(option('--settle-ms', '3000'));
assert.ok(
  Number.isInteger(cycles) && cycles > 0 && cycles <= 20,
  '--cycles must be 1–20',
);
assert.ok(
  Number.isFinite(settleMs) && settleMs >= 1000,
  '--settle-ms must be at least 1000',
);
const out = path.resolve(option('--out', 'qa-artifacts/memory/latest'));
const url = new URL(option('--url', 'http://127.0.0.1:4173'));
url.searchParams.set('welcome', '0');
const layerIds = option('--layers', 'local-datacenters,local-dams')
  .split(',')
  .filter(Boolean);
const baselinePath = option('--baseline', null);
assert.notEqual(
  baselinePath && path.resolve(baselinePath),
  path.join(out, 'report.json'),
  '--out must not overwrite the baseline report',
);
const baseline = baselinePath
  ? JSON.parse(await fs.readFile(baselinePath, 'utf8'))
  : null;
const serverPid = Number(option('--server-pid', '0'));
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const mib = (bytes) => Math.round((bytes / 1024 / 1024) * 10) / 10;
await fs.mkdir(out, { recursive: true });

const browser = await puppeteer.launch({
  headless: !args.includes('--headful'),
  executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || undefined,
  protocolTimeout: 180_000,
  args: [
    '--no-sandbox',
    ...(process.platform === 'darwin'
      ? ['--use-angle=metal', '--enable-gpu']
      : ['--use-gl=angle', '--use-angle=swiftshader']),
    '--disable-backgrounding-occluded-windows',
    '--disable-renderer-backgrounding',
    '--disable-background-timer-throttling',
  ],
});
const report = {
  version: 1,
  startedAt: new Date().toISOString(),
  browser: await browser.version(),
  platform: process.platform,
  url: redact(url.href),
  viewport: { width: 1440, height: 860, deviceScaleFactor: 1 },
  cycles,
  settleMs,
  serverPid: serverPid || null,
  layerIds,
  samples: [],
  errors: [],
  checks: [],
  timings: [],
};
try {
  const page = await browser.newPage();
  await page.setViewport(report.viewport);
  const evidence = watchPage(page, { name: 'memory', errors: report.errors });
  await hookRenderErrors(page);
  const cdp = await page.createCDPSession();
  await cdp.send('Performance.enable');
  await page.goto(url.href, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(
    () =>
      window.__godsEyeView?.styleManager &&
      document.getElementById('loading-screen')?.classList.contains('hidden'),
    { timeout: 90_000 },
  );
  await page.evaluate(async () => {
    const app = window.__godsEyeView;
    await app.styleManager.initialRestorePromise;
    app.viewer.camera.cancelFlight();
    for (const [id, entry] of app.dataManager.layers) {
      if (entry.enabled)
        await app.dataManager.setEnabled(id, false, { origin: 'user' });
    }
  });
  report.environment = await page.evaluate(() => {
    const app = window.__godsEyeView;
    const gl = app.viewer.scene.context._gl;
    const debug = gl.getExtension('WEBGL_debug_renderer_info');
    return {
      renderer: gl.getParameter(
        debug ? debug.UNMASKED_RENDERER_WEBGL : gl.RENDERER,
      ),
      stacks: app.styleManager.mapStackController
        .getStacks()
        .map(({ id, available }) => ({ id, available })),
    };
  });

  const park = (height, lon = 0, lat = 15) =>
    page.evaluate(
      (height, lon, lat) => {
        const viewer = window.__godsEyeView.viewer;
        viewer.camera.cancelFlight();
        viewer.camera.setView({
          destination: viewer.scene.globe.ellipsoid.cartographicToCartesian({
            longitude: (lon * Math.PI) / 180,
            latitude: (lat * Math.PI) / 180,
            height,
          }),
          orientation: { heading: 0, pitch: -Math.PI / 2, roll: 0 },
        });
        viewer.scene.requestRender();
      },
      height,
      lon,
      lat,
    );

  const sample = async (label, screenshot = false) => {
    await pause(settleMs);
    const beforeGc = await cdp.send('Runtime.getHeapUsage');
    await cdp.send('HeapProfiler.collectGarbage');
    const heap = await cdp.send('Runtime.getHeapUsage');
    const dom = await cdp.send('Memory.getDOMCounters');
    const scene = await page.evaluate((ids) => {
      const app = window.__godsEyeView;
      const viewer = app.viewer;
      const tileset =
        app.styleManager.mapStackController.getImageryHostTileset();
      // Include hidden tilesets: sampling only the active map would conceal
      // precisely the resources a map-switch cleanup needs to reclaim.
      const tilesets = [];
      const visit = (collection) => {
        for (let i = 0; i < collection.length; i++) {
          const primitive = collection.get(i);
          if (Number.isFinite(primitive.totalMemoryUsageInBytes))
            tilesets.push({
              visible: primitive.show,
              bytes: primitive.totalMemoryUsageInBytes,
              cacheBytes: primitive.cacheBytes,
              overflowBytes: primitive.maximumCacheOverflowBytes,
            });
          else if (
            typeof primitive.get === 'function' &&
            Number.isInteger(primitive.length)
          )
            visit(primitive);
        }
      };
      visit(viewer.scene.primitives);
      let entities = 0;
      for (let i = 0; i < viewer.dataSources.length; i++)
        entities += viewer.dataSources.get(i).entities?.values.length || 0;
      const layers = Object.fromEntries(
        ids.map((id) => {
          const entry = app.dataManager.layers.get(id);
          const stats = entry?.module.getStats?.();
          // Stable data/position signature; avoid copying the full dataset out of the page.
          const records = entry?.module.getAnalystRecords?.(100_000) || [];
          let signature = 2166136261;
          const text = JSON.stringify(records);
          for (let i = 0; i < text.length; i++)
            signature =
              Math.imul(signature ^ text.charCodeAt(i), 16777619) >>> 0;
          return [
            id,
            {
              enabled: entry?.enabled,
              count: stats?.count,
              error: stats?.error || null,
              lod: entry?.module.getLodDiagnostics?.() || null,
              records: records.length,
              signature,
            },
          ];
        }),
      );
      return {
        activeMap: app.styleManager.mapStackController.getActiveId(),
        tileBytes: tileset?.totalMemoryUsageInBytes ?? null,
        tileCacheBytes: tileset?.cacheBytes ?? null,
        tileOverflowBytes: tileset?.maximumCacheOverflowBytes ?? null,
        tilesets,
        allTileBytes: tilesets.reduce((sum, tileset) => sum + tileset.bytes, 0),
        dataSources: viewer.dataSources.length,
        entities,
        primitives: viewer.scene.primitives.length,
        layers,
        governor: app.getRenderGovernorDiagnostics?.(),
        drawingBuffer: {
          width: viewer.scene.drawingBufferWidth,
          height: viewer.scene.drawingBufferHeight,
        },
      };
    }, layerIds);
    const entry = {
      label,
      measuredAt: new Date().toISOString(),
      heapBeforeGcBytes: beforeGc.usedSize,
      heapBytes: heap.usedSize,
      heapBackingBytes: heap.backingStorageSize ?? null,
      dom,
      ...processMemory(browser.process().pid, serverPid),
      scene,
    };
    report.samples.push(entry);
    console.log(
      JSON.stringify({
        phase: label,
        retainedHeapMiB: mib(entry.heapBytes),
        browserRssMiB: mib(entry.browserRssBytes),
        entities: scene.entities,
        tileMiB: scene.tileBytes === null ? null : mib(scene.tileBytes),
      }),
    );
    if (screenshot)
      await page.screenshot({ path: path.join(out, `${label}.png`) });
    await fs.writeFile(
      path.join(out, 'report.json'),
      JSON.stringify(report, null, 2),
    );
    return entry;
  };
  const check = (name, pass) => {
    report.checks.push({ name, pass: Boolean(pass) });
    console.log(`${pass ? 'PASS' : 'FAIL'} ${name}`);
  };
  const switchMap = async (id) => {
    const started = performance.now();
    const result = await page.evaluate(
      (id) => window.__godsEyeView.styleManager.setMapStack(id),
      id,
    );
    report.timings.push({ action: 'map', id, ms: performance.now() - started });
    return result;
  };
  const setLayers = async (enabled) => {
    const result = await page.evaluate(
      async (ids, enabled) => {
        const app = window.__godsEyeView;
        const result = {};
        for (const id of ids) {
          if (!app.dataManager.layers.has(id))
            throw new Error(`Unknown layer ${id}`);
          const started = performance.now();
          const ok = await app.dataManager.setEnabled(id, enabled, {
            origin: 'user',
          });
          result[id] = { ok, ms: performance.now() - started };
        }
        return result;
      },
      layerIds,
      enabled,
    );
    for (const id of layerIds) {
      report.timings.push({
        action: enabled ? 'enable' : 'disable',
        id,
        ms: result[id].ms,
      });
      check(
        `${id} ${enabled ? 'enables' : 'disables'}`,
        result[id].ok === true,
      );
    }
  };

  await switchMap('osm');
  await park(24_000_000);
  const initial = await sample('idle-initial', true);
  let firstActive;
  for (let cycle = 1; cycle <= cycles; cycle++) {
    await setLayers(true);
    await park(24_000_000);
    const active = await sample(`cycle-${cycle}-global`, true);
    for (const id of layerIds) {
      const layer = active.scene.layers[id];
      check(`${id} has data without errors`, layer.count > 0 && !layer.error);
      if (firstActive)
        check(
          `${id} data survives re-enable`,
          layer.count === firstActive.scene.layers[id].count &&
            layer.signature === firstActive.scene.layers[id].signature,
        );
    }
    firstActive ??= active;
    await park(60_000, -97.74, 30.27);
    await sample(`cycle-${cycle}-city`, true);
    for (const id of ['esri-imagery', 'photoreal', 'osm']) {
      if (
        !report.environment.stacks.find((stack) => stack.id === id)?.available
      )
        continue;
      await switchMap(id);
      await sample(`cycle-${cycle}-map-${id}`);
    }
    await setLayers(false);
    await park(24_000_000);
    const idle = await sample(`cycle-${cycle}-idle`, true);
    check(
      'disabled layers release their entities',
      idle.scene.entities === initial.scene.entities,
    );
    check(
      'disabled layers release their data sources',
      idle.scene.dataSources === initial.scene.dataSources,
    );
    check(
      'disabled layers release continuous rendering',
      idle.scene.governor?.mode === 'idle',
    );
  }
  await pause(15_000); // drain the HUD summary tick and deferred chrome work
  await sample('idle-final', true);
  report.errors.push(...(await readRenderErrors(page)));
  check('no browser or render-loop errors', report.errors.length === 0);
  report.networkFailures = evidence.failed;
  report.console = evidence.console;
  if (baseline) {
    assert.deepEqual(
      {
        browser: report.browser,
        viewport: report.viewport,
        layerIds,
        cycles,
        settleMs,
        environment: report.environment,
      },
      {
        browser: baseline.browser,
        viewport: baseline.viewport,
        layerIds: baseline.layerIds,
        cycles: baseline.cycles,
        settleMs: baseline.settleMs,
        environment: baseline.environment,
      },
      'Baseline must use the same browser, viewport, layers, cycles, settling and renderer/map availability',
    );
    report.comparison = report.samples.map((entry) => {
      const before = baseline.samples.find(
        (sample) => sample.label === entry.label,
      );
      check(`${entry.label}: baseline checkpoint exists`, Boolean(before));
      if (!before) return { label: entry.label, missingBaseline: true };
      check(
        `${entry.label}: map matches baseline`,
        entry.scene.activeMap === before.scene.activeMap,
      );
      check(
        `${entry.label}: render resolution matches baseline`,
        entry.scene.drawingBuffer.width === before.scene.drawingBuffer.width &&
          entry.scene.drawingBuffer.height ===
            before.scene.drawingBuffer.height,
      );
      for (const id of layerIds) {
        const current = entry.scene.layers[id],
          original = before.scene.layers[id];
        check(
          `${entry.label}: ${id} matches baseline data`,
          current.count === original.count &&
            current.signature === original.signature,
        );
      }
      return {
        label: entry.label,
        heapDeltaMiB: mib(entry.heapBytes - before.heapBytes),
        browserRssDeltaMiB:
          entry.browserRssBytes == null || before.browserRssBytes == null
            ? null
            : mib(entry.browserRssBytes - before.browserRssBytes),
      };
    });
    console.log(JSON.stringify({ comparison: report.comparison }, null, 2));
  }
} catch (error) {
  report.errors.push(redact(error.stack || error.message));
  process.exitCode = 1;
} finally {
  if (report.checks.some((check) => !check.pass)) process.exitCode = 1;
  report.finishedAt = new Date().toISOString();
  await fs.writeFile(
    path.join(out, 'report.json'),
    JSON.stringify(report, null, 2),
  );
  await browser.close();
  console.log(`Memory report: ${path.join(out, 'report.json')}`);
  if (report.errors.length) console.error(report.errors.join('\n'));
}
