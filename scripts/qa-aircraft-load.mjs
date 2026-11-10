#!/usr/bin/env node
/** Dense flat-map workload: retained heap, renderer/GPU-process CPU, frame cadence and layer counts. */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createHash } from 'node:crypto';
import puppeteer from 'puppeteer';
import sharp from 'sharp';
import { processMemory } from './qa-process-memory.mjs';
import { installGpuMemoryProbe } from './qa-gpu-memory.mjs';
import {
  hookRenderErrors,
  readRenderErrors,
  watchPage,
} from './qa-browserEvidence.mjs';

const args = process.argv.slice(2);
const option = (flag, fallback) =>
  args.includes(flag) ? args[args.indexOf(flag) + 1] : fallback;
const out = path.resolve(option('--out', 'qa-artifacts/aircraft-load/latest'));
const url = new URL(option('--url', 'http://127.0.0.1:4173'));
url.searchParams.set('welcome', '0');
const performanceMode = option(
  '--performance',
  url.searchParams.get('performance') || 'standard',
);
url.searchParams.set('performance', performanceMode);
const dpr = Number(option('--dpr', '1'));
assert.ok(dpr >= 1 && dpr <= 3);
const durationMs = Number(option('--duration-ms', '10000'));
const counts = option('--counts', '1000,5000,10000').split(',').map(Number);
assert.ok(durationMs >= 3000 && Number.isFinite(durationMs));
assert.ok(
  counts.length > 0 &&
    counts.every((n) => Number.isInteger(n) && n > 0 && n <= 20000),
);
const baselinePath = option('--baseline', null);
assert.notEqual(
  baselinePath && path.resolve(baselinePath),
  path.join(out, 'report.json'),
);
const baseline = baselinePath
  ? JSON.parse(await fs.readFile(baselinePath, 'utf8'))
  : null;
await fs.mkdir(out, { recursive: true });
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const browser = await puppeteer.launch({
  headless: true,
  executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || undefined,
  protocolTimeout: 180000,
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
  harnessSha256: createHash('sha256')
    .update(await fs.readFile(new URL(import.meta.url)))
    .digest('hex'),
  host: {
    platform: os.platform(),
    arch: os.arch(),
    cpuModel: os.cpus()[0]?.model,
    logicalCpus: os.cpus().length,
    totalMemoryBytes: os.totalmem(),
  },
  browser: await browser.version(),
  durationMs,
  counts,
  performanceMode,
  viewport: { width: 1440, height: 860, deviceScaleFactor: dpr },
  phases: [],
  checks: [],
  errors: [],
};
try {
  const page = await browser.newPage();
  await page.setViewport(report.viewport);
  const evidence = watchPage(page, {
    name: 'aircraft-load',
    errors: report.errors,
  });
  await hookRenderErrors(page);
  if (args.includes('--heavy-features')) {
    const frame = await sharp({
      create: { width: 1920, height: 1080, channels: 4, background: '#325a81' },
    })
      .png()
      .toBuffer();
    await page.setRequestInterception(true);
    page.on('request', (request) => {
      if (new URL(request.url()).pathname.startsWith('/api/cctv/frame/'))
        void request.respond({
          status: 200,
          contentType: 'image/png',
          body: frame,
        });
      else void request.continue();
    });
  }
  if (args.includes('--gpu-memory'))
    await page.evaluateOnNewDocument(installGpuMemoryProbe);
  await page.evaluateOnNewDocument(
    (enabled) => {
      window.__resourceCostFixtures = enabled;
    },
    args.includes('--feature-costs') || args.includes('--heavy-features'),
  );
  await page.evaluateOnNewDocument(
    (enabled) => {
      window.__heavyFeatureFixtures = enabled;
      if (!enabled) return;
      const create = Document.prototype.createElement;
      const canvases = [];
      Document.prototype.createElement = function (...args) {
        const element = create.apply(this, args);
        if (String(args[0]).toLowerCase() === 'canvas')
          canvases.push(new WeakRef(element));
        return element;
      };
      window.__qaCanvasPixels = () =>
        canvases.reduce((sum, ref) => {
          const canvas = ref.deref();
          return sum + (canvas ? canvas.width * canvas.height * 4 : 0);
        }, 0);
    },
    args.includes('--heavy-features') || args.includes('--native-models'),
  );
  await page.evaluateOnNewDocument(() => {
    window.__aircraftLoadCount = 0;
    const realFetch = window.fetch.bind(window);
    window.fetch = (input, init) => {
      const url = new URL(
        typeof input === 'string' || input instanceof URL
          ? String(input)
          : input.url,
        location.href,
      );
      if (url.origin !== location.origin) return realFetch(input, init);
      const json = (value) =>
        Promise.resolve(
          new Response(JSON.stringify(value), {
            headers: { 'Content-Type': 'application/json' },
          }),
        );
      if (window.__resourceCostFixtures) {
        if (
          window.__heavyFeatureFixtures &&
          url.pathname === '/api/weather/manifest'
        ) {
          const end = Math.floor(Date.now() / 300000) * 300000;
          const times = Array.from({ length: 13 }, (_, i) =>
            new Date(end - (12 - i) * 300000).toISOString(),
          );
          return json({
            schemaVersion: 1,
            product: url.searchParams.get('product'),
            times,
            latest: times.at(-1),
            bounds: { west: -180, south: -90, east: 180, north: 90 },
            tileSize: 256,
            maxLevel: 6,
            tilingScheme: 'geographic',
          });
        }
        if (
          window.__heavyFeatureFixtures &&
          url.pathname === '/api/weather/image'
        ) {
          const canvas = document.createElement('canvas');
          canvas.width = 2048;
          canvas.height = 1024;
          const context = canvas.getContext('2d');
          context.fillStyle = '#dddddd';
          context.fillRect(0, 0, 2048, 1024);
          return new Promise((resolve) =>
            canvas.toBlob((blob) => {
              canvas.width = canvas.height = 0;
              resolve(
                new Response(blob, {
                  headers: { 'Content-Type': 'image/png' },
                }),
              );
            }),
          );
        }
        if (url.pathname.startsWith('/api/celestrak-satcat/'))
          return Promise.resolve(
            new Response(
              'OBJECT_NAME,OBJECT_ID,NORAD_CAT_ID,OBJECT_TYPE,OPS_STATUS_CODE,LAUNCH_DATE\n',
            ),
          );
        if (url.pathname.startsWith('/api/celestrak/')) {
          const group = url.pathname.split('/').at(-1),
            count = group === 'visual' ? 2000 : group === 'starlink' ? 5000 : 0;
          const start = group === 'starlink' ? 70000 : 60000;
          const now = new Date(),
            year = now.getUTCFullYear(),
            day = (now - Date.UTC(year, 0, 0)) / 86400000;
          const epoch =
            String(year % 100).padStart(2, '0') +
            day.toFixed(8).padStart(12, '0');
          const lines = Array.from({ length: count }, (_, i) => {
            const id = String(start + i);
            return [
              `${group === 'starlink' ? 'STARLINK' : 'AUDIT'}-${id}`,
              `1 ${id}U 98067A   ${epoch}  .00016717  00000-0  10270-3 0  9004`,
              `2 ${id}  51.6416 ${String((i * 0.7) % 360)
                .padStart(8, '0')
                .slice(0, 8)} 0006703 130.5360 325.0288 15.49814310 12345`,
            ].join('\n');
          });
          return Promise.resolve(new Response(lines.join('\n') + '\n'));
        }
        if (url.pathname === '/api/cctv/sources')
          return json({
            sources: Array.from(
              { length: window.__heavyFeatureFixtures ? 24 : 5000 },
              (_, i) => ({
                id: `audit-camera-${i}`,
                name: `Audit camera ${i}`,
                city: 'Audit fixture',
                lat: window.__heavyFeatureFixtures
                  ? 38 + i * 0.001
                  : 25 + Math.floor(i / 100) * 0.25,
                lon: window.__heavyFeatureFixtures
                  ? -98 + i * 0.001
                  : -125 + (i % 100) * 0.6,
                headingDeg: 90,
                fovDeg: 70,
                rangeM: 700,
                mountHeightM: 20,
                feedType: 'image',
                feedConfigured: true,
                provider: 'QA fixture',
                sourceKind: 'upstream-image',
              }),
            ),
          });
        if (url.pathname === '/api/cctv/health') return json({ cameras: [] });
        if (url.pathname.startsWith('/api/cctv/frame/'))
          return Promise.resolve(
            new Response(
              Uint8Array.from(
                atob(
                  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==',
                ),
                (c) => c.charCodeAt(0),
              ),
              {
                headers: {
                  'Content-Type': 'image/png',
                  'x-cctv-source': 'synthetic',
                },
              },
            ),
          );
      }
      if (url.pathname === '/api/flights') {
        const now = Date.now() / 1000;
        const states = Array.from(
          { length: window.__aircraftLoadCount },
          (_, i) => [
            (0xc00000 + i).toString(16),
            `LOAD${String(i).padStart(5, '0')}`,
            'Load fixture',
            Math.floor(now),
            Math.floor(now),
            window.__heavyFeatureFixtures
              ? -98 + ((i % 20) - 10) * 0.01
              : -125 + (i % 200) * 0.3,
            window.__heavyFeatureFixtures
              ? 38 + (Math.floor(i / 20) - 7) * 0.01
              : 25 + Math.floor(i / 200) * 0.25,
            10000 + (i % 20) * 100,
            false,
            200,
            i % 360,
            0,
            null,
            10000 + (i % 20) * 100,
            null,
            false,
            0,
          ],
        );
        return json({ time: Math.floor(now), states });
      }
      if (url.pathname === '/api/military') return json({ ac: [] });
      if (/^\/api\/adsbdb\//.test(url.pathname)) return json({});
      if (url.pathname === '/api/flights/track') return json({ path: [] });
      if (url.pathname === '/api/openai/hud-summary')
        return json({ summary: 'Aircraft load fixture ready' });
      return realFetch(input, init);
    };
  });
  const cdp = await page.createCDPSession();
  const browserCdp = await browser.target().createCDPSession();
  await cdp.send('Performance.enable');
  await page.goto(url.href, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(
    () =>
      window.__godsEyeView?.styleManager &&
      document.getElementById('loading-screen')?.classList.contains('hidden'),
    { timeout: 90000 },
  );
  await page.evaluate(async () => {
    const app = window.__godsEyeView;
    await app.styleManager.initialRestorePromise;
    await app.performance?.ready;
    app.viewer.camera.cancelFlight();
    for (const [id, entry] of app.dataManager.layers)
      if (entry.enabled)
        await app.dataManager.setEnabled(id, false, { origin: 'user' });
    await app.styleManager.setMapStack('osm');
    app.viewer.camera.setView({
      destination: app.viewer.scene.globe.ellipsoid.cartographicToCartesian({
        longitude: (-98 * Math.PI) / 180,
        latitude: (38 * Math.PI) / 180,
        height: 6500000,
      }),
      orientation: { heading: 0, pitch: -Math.PI / 2, roll: 0 },
    });
  });
  report.renderer = await page.evaluate(() => {
    const gl = window.__godsEyeView.viewer.scene.context._gl;
    const ext = gl.getExtension('WEBGL_debug_renderer_info');
    return gl.getParameter(ext ? ext.UNMASKED_RENDERER_WEBGL : gl.RENDERER);
  });
  report.environment = await page.evaluate(() =>
    [...document.scripts].some((script) =>
      new URL(script.src, location.href).pathname.endsWith('/src/main.js'),
    )
      ? 'development'
      : 'production',
  );
  const check = (name, pass) => {
    report.checks.push({ name, pass: Boolean(pass) });
    if (!pass) process.exitCode = 1;
  };
  const processCpu = async () =>
    (await browserCdp.send('SystemInfo.getProcessInfo')).processInfo;
  const metrics = async () =>
    Object.fromEntries(
      (await cdp.send('Performance.getMetrics')).metrics.map(
        ({ name, value }) => [name, value],
      ),
    );
  const sample = async (label, warmupMs = 3000) => {
    await pause(warmupMs);
    await cdp.send('HeapProfiler.collectGarbage');
    await page.evaluate(() => {
      const scene = window.__godsEyeView.viewer.scene;
      window.__loadFrames = { count: 0, intervals: [], previous: 0, first: 0 };
      window.__stopLoadFrames = scene.postRender.addEventListener(() => {
        const now = performance.now(),
          data = window.__loadFrames;
        if (data.previous) data.intervals.push(now - data.previous);
        else data.first = now;
        data.previous = now;
        data.count++;
      });
    });
    const profileCpu =
      args.includes('--cpu-profile') &&
      label === `${Math.max(...counts)}-planes`;
    if (profileCpu) {
      await cdp.send('Profiler.enable');
      await cdp.send('Profiler.start');
    }
    const startMetrics = await metrics(),
      startCpu = await processCpu(),
      started = performance.now();
    await pause(durationMs);
    const elapsedSec = (performance.now() - started) / 1000;
    const endCpu = await processCpu(),
      endMetrics = await metrics();
    if (profileCpu) {
      const { profile } = await cdp.send('Profiler.stop');
      await fs.writeFile(
        path.join(out, 'aircraft.cpuprofile'),
        JSON.stringify(profile),
      );
      const hits = new Map();
      for (const id of profile.samples || [])
        hits.set(id, (hits.get(id) || 0) + 1);
      report.cpuHotspots = profile.nodes
        .map((node) => ({
          function: node.callFrame.functionName,
          url: node.callFrame.url,
          line: node.callFrame.lineNumber + 1,
          samples: hits.get(node.id) || 0,
        }))
        .sort((a, b) => b.samples - a.samples)
        .slice(0, 30);
    }
    const state = await page.evaluate((argsNativeResolution) => {
      window.__stopLoadFrames();
      const app = window.__godsEyeView;
      const frames = window.__loadFrames;
      frames.intervals.sort((a, b) => a - b);
      let billboards = 0,
        models = 0;
      const iconRasters = {};
      const modelMinimumCssPixels = new Set();
      const renderRatio =
        app.viewer.scene.drawingBufferWidth /
        app.viewer.scene.canvas.clientWidth;
      const visit = (collection) => {
        for (let i = 0; i < collection.length; i++) {
          const primitive = collection.get(i);
          if (Number.isFinite(primitive.renderedCount)) {
            billboards += primitive.renderedCount;
            if (argsNativeResolution)
              for (let j = 0; j < primitive.length; j++) {
                const sprite = primitive.get(j);
                if (sprite.viewportVisible && sprite.show) {
                  const px =
                    sprite._gevIconPx || (sprite._gevIconLarge ? 192 : 64);
                  iconRasters[px] = (iconRasters[px] || 0) + 1;
                }
              }
            continue;
          }
          if (primitive.constructor.name === 'BillboardCollection')
            billboards += primitive.length;
          else if (
            typeof primitive.ready === 'boolean' &&
            primitive.modelMatrix &&
            primitive.activeAnimations
          ) {
            models++;
            modelMinimumCssPixels.add(primitive.minimumPixelSize / renderRatio);
          }
          if (
            typeof primitive.get === 'function' &&
            Number.isInteger(primitive.length)
          )
            visit(primitive);
        }
      };
      visit(app.viewer.scene.primitives);
      const flight = app.dataManager.layers.get('flights');
      return {
        frames: frames.count,
        fps:
          frames.count > 1
            ? ((frames.count - 1) * 1000) / (frames.previous - frames.first)
            : 0,
        frameP95Ms:
          frames.intervals[Math.floor(frames.intervals.length * 0.95)] ?? null,
        frameP99Ms:
          frames.intervals[Math.floor(frames.intervals.length * 0.99)] ?? null,
        frameMaxMs: frames.intervals.at(-1) ?? null,
        flight: flight.module.getStats(),
        enabled: flight.enabled,
        billboards,
        models,
        nativeQuality: {
          renderRatio,
          iconRasters,
          modelMinimumCssPixels: [...modelMinimumCssPixels],
        },
        governor: app.getRenderGovernorDiagnostics(),
        detection: app.styleManager.getDetectionState(),
        detectionDiagnostics: app.styleManager.getDetectionDiagnostics?.(),
        map: app.styleManager.mapStackController.getActiveId(),
        performance: app.performance?.getState(),
        aircraftSurface: app.viewer.gevAircraftSurfaceDiagnostics?.() || null,
        drawingBuffer: {
          width: app.viewer.scene.drawingBufferWidth,
          height: app.viewer.scene.drawingBufferHeight,
        },
        gpuStorage: window.__gevGpuMemory?.(),
        canvasPixelBytes: window.__qaCanvasPixels?.(),
        weather: app.dataManager.layers
          .get('weather-satellite')
          ?.module.getDiagnostics?.(),
        cctv: app.dataManager.layers.get('cctv')?.module.getStats?.(),
        cctvPlanes: window.__heavyFeatureFixtures
          ? app.viewer.entities.values
              .filter(
                (entity) =>
                  String(entity.id).startsWith('cctv-') &&
                  String(entity.id).endsWith('-plane'),
              )
              .map((entity) => {
                const image = entity.plane?.material?.image?.getValue();
                let pixel = null;
                if (entity.show && image?.width > 0 && image?.getContext)
                  pixel = [
                    ...image.getContext('2d').getImageData(900, 500, 1, 1).data,
                  ];
                return {
                  id: entity.id,
                  show: entity.show,
                  width: image?.width,
                  height: image?.height,
                  pixel,
                };
              })
          : undefined,
        googleAvailable: app.mapStackController.isStackAvailable('photoreal'),
        layers: [...app.dataManager.layers]
          .filter(([, entry]) => entry.enabled)
          .map(([id, entry]) => ({ id, ...entry.module.getStats?.() })),
      };
    }, args.includes('--native-resolution'));
    const heapBeforeGc = await cdp.send('Runtime.getHeapUsage');
    await cdp.send('HeapProfiler.collectGarbage');
    const heap = await cdp.send('Runtime.getHeapUsage');
    const cpu = endCpu.map((p) => ({
      type: p.type,
      cpuPercent:
        ((p.cpuTime -
          (startCpu.find((before) => before.id === p.id)?.cpuTime ??
            p.cpuTime)) /
          elapsedSec) *
        100,
    }));
    const memory = processMemory(browser.process().pid);
    let physical = {};
    if (
      process.platform === 'darwin' &&
      args.includes('--footprint') &&
      memory.processes?.length
    ) {
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
        const data = JSON.parse(await fs.readFile(file, 'utf8'));
        physical = {
          physicalFootprintBytes: data['total footprint'],
          physicalProcesses: data.processes,
          footprintErrors: data.errors,
        };
      } catch (error) {
        physical = { footprintUnavailable: error.code || error.message };
      }
    }
    const phase = {
      label,
      systemLoad: os.loadavg(),
      elapsedSec,
      heapBytes: heap.usedSize,
      heapBackingBytes: heap.backingStorageSize ?? null,
      heapBeforeGcBytes: heapBeforeGc.usedSize,
      taskCpuPercent:
        ((endMetrics.TaskDuration - startMetrics.TaskDuration) / elapsedSec) *
        100,
      scriptCpuPercent:
        ((endMetrics.ScriptDuration - startMetrics.ScriptDuration) /
          elapsedSec) *
        100,
      processCpu: cpu,
      ...memory,
      ...physical,
      state,
    };
    report.phases.push(phase);
    check(`${label}: flat map active`, state.map === 'osm');
    if (state.enabled)
      check(
        `${label}: exact synthetic aircraft population`,
        state.flight.count ===
          (label.startsWith('feature-')
            ? Math.max(...counts)
            : counts.find((n) => label.startsWith(`${n}-`))),
      );
    console.log(
      JSON.stringify({
        label,
        heapMiB: heap.usedSize / 1048576,
        fps: state.fps,
        taskCpuPercent: phase.taskCpuPercent,
        processCpu: cpu,
        aircraft: state.flight.count,
        billboards: state.billboards,
        models: state.models,
      }),
    );
    await page.screenshot({ path: path.join(out, `${label}.png`) });
    await fs.writeFile(
      path.join(out, 'report.json'),
      JSON.stringify(report, null, 2),
    );
  };
  await sample('idle');
  for (const count of counts) {
    await page.evaluate(async (count) => {
      window.__aircraftLoadCount = count;
      const app = window.__godsEyeView;
      const entry = app.dataManager.layers.get('flights');
      if (!entry.enabled)
        await app.dataManager.setEnabled('flights', true, { origin: 'user' });
      else await entry.module.update(app.viewer);
    }, count);
    await sample(`${count}-planes`);
  }
  if (args.includes('--native-resolution')) {
    const models = args.includes('--native-models');
    await page.evaluate(
      ({ models, wide }) => {
        const app = window.__godsEyeView;
        app.dataManager.layers
          .get('flights')
          .module.setParams({ models3d: models, models3dMode: 'all' });
        app.viewer.camera.setView({
          destination: app.viewer.scene.globe.ellipsoid.cartographicToCartesian(
            {
              longitude: (-98 * Math.PI) / 180,
              latitude: ((models ? 38 : 37) * Math.PI) / 180,
              height: models ? 65000 : wide ? 6500000 : 200000,
            },
          ),
          orientation: { heading: 0, pitch: -Math.PI / 2, roll: 0 },
        });
      },
      { models, wide: args.includes('--native-wide') },
    );
    await pause(10000);
    for (const ratio of option('--native-resolution', '1,1.25,1.5,2')
      .split(',')
      .map(Number)) {
      assert.ok(ratio >= 1 && ratio <= 2);
      const msaa = Number(option('--native-msaa', '0'));
      await page.evaluate(
        ({ ratio, msaa }) => {
          const viewer = window.__godsEyeView.viewer;
          const previousRatio =
            viewer.scene.drawingBufferWidth / viewer.scene.canvas.clientWidth;
          viewer.useBrowserRecommendedResolution = true;
          viewer.resolutionScale = ratio;
          if (msaa) viewer.scene.msaaSamples = msaa;
          viewer.resize();
          const visit = (collection) => {
            for (let i = 0; i < collection.length; i++) {
              const primitive = collection.get(i);
              if (primitive.activeAnimations && primitive.modelMatrix) {
                primitive._qaCssMinimum ??=
                  primitive.minimumPixelSize / previousRatio;
                primitive.minimumPixelSize = primitive._qaCssMinimum * ratio;
              }
              if (
                typeof primitive.get === 'function' &&
                typeof primitive.destroyPrimitives === 'boolean'
              )
                visit(primitive);
            }
          };
          visit(viewer.scene.primitives);
          viewer.scene.requestRender();
        },
        { ratio, msaa },
      );
      await sample(`feature-native-${models ? 'models' : 'sprites'}-${ratio}`);
      if (models)
        check(
          'native resolution retains warmed model fleet',
          report.phases.at(-1).state.models ===
            Math.min(350, Math.max(...counts)),
        );
    }
  }
  if (
    args.includes('--heavy-features') &&
    !args.includes('--native-resolution')
  ) {
    await page.evaluate(() => {
      const app = window.__godsEyeView;
      app.viewer.camera.setView({
        destination: app.viewer.scene.globe.ellipsoid.cartographicToCartesian({
          longitude: (-98 * Math.PI) / 180,
          latitude: (38 * Math.PI) / 180,
          height: 65000,
        }),
        orientation: { heading: 0, pitch: -Math.PI / 2, roll: 0 },
      });
      app.dataManager.layers
        .get('flights')
        .module.setParams({ models3d: true, models3dMode: 'all' });
    });
    await sample('feature-models-cold', 0);
    await pause(10000);
    await sample('feature-models-warm');
    check(
      '3D aircraft actually loaded',
      report.phases.at(-1).state.models >= Math.min(100, Math.max(...counts)),
    );
    await page.evaluate(async () => {
      const app = window.__godsEyeView;
      app.dataManager.layers
        .get('flights')
        .module.setParams({ models3d: false });
      await app.dataManager.setEnabled('cctv', true, { origin: 'user' });
      app.dataManager.layers
        .get('cctv')
        .module.setParams({ showProjection: true });
    });
    for (let i = 0; i < 24; i++) {
      await page.evaluate(
        (i) =>
          window.__godsEyeView.dataManager.layers
            .get('cctv')
            .module.setActiveCamera(`audit-camera-${i}`),
        i,
      );
      await pause(1250);
    }
    await sample('feature-cctv-visited-24');
    await page.evaluate(() =>
      window.__godsEyeView.dataManager.layers
        .get('cctv')
        .module.setActiveCamera('audit-camera-0'),
    );
    await sample('feature-cctv-return');
    const returnedPlane = report.phases
      .at(-1)
      .state.cctvPlanes.find(
        (plane) => plane.id === 'cctv-audit-camera-0-plane',
      );
    check(
      'returned CCTV camera displays its full-HD source frame',
      returnedPlane?.show &&
        returnedPlane.width === 1920 &&
        returnedPlane.height === 1080 &&
        returnedPlane.pixel?.slice(0, 3).join(',') === '50,90,129',
    );
    await page.evaluate(() =>
      window.__godsEyeView.dataManager.setEnabled('cctv', false, {
        origin: 'user',
      }),
    );
    await sample('feature-cctv-disabled');
    await page.evaluate(() =>
      window.__godsEyeView.dataManager.setEnabled('cctv', true, {
        origin: 'user',
      }),
    );
    await sample('feature-cctv-reenabled');
    check(
      'CCTV retains all camera records after re-enable',
      report.phases.at(-1).state.cctv.count === 24,
    );
    check(
      'CCTV recreates its full-HD plane after re-enable',
      report.phases
        .at(-1)
        .state.cctvPlanes.some(
          (plane) =>
            plane.show && plane.width === 1920 && plane.height === 1080,
        ),
    );
    await page.evaluate(async () => {
      const app = window.__godsEyeView;
      await app.dataManager.setEnabled('cctv', false, { origin: 'user' });
      app.dataManager.layers
        .get('weather-satellite')
        .module.setParams({ product: 'clouds' });
      await app.dataManager.setEnabled('weather-satellite', true, {
        origin: 'user',
      });
    });
    for (const infrared of [0, 20, 40, 60, 80, 100]) {
      await page.evaluate(
        (infrared) =>
          window.__godsEyeView.dataManager.layers
            .get('weather-satellite')
            .module.setParams({ infrared }),
        infrared,
      );
      await page.waitForFunction(
        (infrared) => {
          const d = window.__godsEyeView.dataManager.layers
            .get('weather-satellite')
            .module.getDiagnostics();
          return d.time && !d.loading && d.infrared === infrared;
        },
        { timeout: 30000 },
        infrared,
      );
    }
    await sample('feature-weather-six-modes');
    check(
      'weather frame visible at requested infrared setting',
      report.phases.at(-1).state.weather.infrared === 100,
    );
    await page.evaluate(() =>
      window.__godsEyeView.dataManager.layers
        .get('weather-satellite')
        .module.setParams({ play: true }),
    );
    await sample('feature-weather-playback');
    check(
      'weather playback remains available',
      report.phases.at(-1).state.weather.playing === true,
    );
    await page.evaluate(() =>
      window.__godsEyeView.dataManager.layers
        .get('weather-satellite')
        .module.setParams({ play: true }),
    );
    await sample('feature-weather-paused');
    check(
      'weather pause retains the displayed frame',
      report.phases.at(-1).state.weather.playing === false &&
        Boolean(report.phases.at(-1).state.weather.time),
    );
    await page.evaluate(() =>
      window.__godsEyeView.dataManager.setEnabled('weather-satellite', false, {
        origin: 'user',
      }),
    );
    await sample('feature-weather-disabled');
  }
  if (
    !args.includes('--heavy-features') &&
    !args.includes('--native-resolution') &&
    !args.includes('--wide-only')
  ) {
    if (args.includes('--raster-ab')) {
      // Only the raster cache reads this Canvas API in the application. Returning
      // no transform selects its tested vector fallback without changing pixels.
      await pause(10000);
      for (const [label, enabled] of [
        ['vector', false],
        ['cached', true],
        ['vector-repeat', false],
        ['cached-repeat', true],
      ]) {
        await page.evaluate((enabled) => {
          window.__qaCanvasTransform ??=
            CanvasRenderingContext2D.prototype.getTransform;
          CanvasRenderingContext2D.prototype.getTransform = enabled
            ? window.__qaCanvasTransform
            : function () {
                return null;
              };
        }, enabled);
        await sample(`feature-raster-${label}`);
      }
    }
    if (args.includes('--cables-steady')) {
      for (const enabled of [true, false]) {
        await page.evaluate(
          (enabled) =>
            window.__godsEyeView.dataManager.setEnabled(
              'telegeography-submarine-cables',
              enabled,
              { origin: 'user' },
            ),
          enabled,
        );
        await pause(15000);
        await sample(`feature-cables-steady-${enabled ? 'on' : 'off'}`);
      }
    }
    if (args.includes('--feature-costs')) {
      for (const [label, apply] of [
        [
          'sharpen-off',
          () => window.__godsEyeView.styleManager._setSharpenEnabled(false),
        ],
        [
          'sharpen-on',
          () => window.__godsEyeView.styleManager._setSharpenEnabled(true),
        ],
        [
          'bloom-on',
          () => window.__godsEyeView.styleManager._setBloomEnabled(true),
        ],
        [
          'bloom-off',
          () => window.__godsEyeView.styleManager._setBloomEnabled(false),
        ],
        [
          'thermal-on',
          () =>
            window.__godsEyeView.styleManager.setStyle('thermal', {
              applyPreset: false,
              restore: true,
            }),
        ],
        [
          'normal-restored',
          () =>
            window.__godsEyeView.styleManager.setStyle('normal', {
              applyPreset: false,
              restore: true,
            }),
        ],
      ]) {
        await page.evaluate(apply);
        await sample(`feature-${label}`);
      }
      for (const id of [
        'telegeography-submarine-cables',
        'satellites',
        'cctv',
      ]) {
        await page.evaluate(
          (id) =>
            window.__godsEyeView.dataManager.setEnabled(id, true, {
              origin: 'user',
            }),
          id,
        );
        await sample(`feature-${id}-on`);
        if (id === 'satellites') {
          await page.evaluate(() =>
            window.__godsEyeView.dataManager.layers
              .get('satellites')
              .module.setParams({ catalog: 'dense' }),
          );
          await page.waitForFunction(
            () =>
              window.__godsEyeView.dataManager.layers
                .get('satellites')
                .module.getStats().count >= 7000,
            { timeout: 60000 },
          );
          await sample('feature-satellites-dense');
        }
        await page.evaluate(
          (id) =>
            window.__godsEyeView.dataManager.setEnabled(id, false, {
              origin: 'user',
            }),
          id,
        );
        await sample(`feature-${id}-off`);
      }
    }
    const highest = Math.max(...counts);
    await page.evaluate(() => {
      const viewer = window.__godsEyeView.viewer;
      viewer.camera.setView({
        destination: viewer.scene.globe.ellipsoid.cartographicToCartesian({
          longitude: (-98 * Math.PI) / 180,
          latitude: (38 * Math.PI) / 180,
          height: 1000000,
        }),
        orientation: { heading: 0, pitch: -Math.PI / 2, roll: 0 },
      });
    });
    await sample(`${highest}-regional`);
    await page.evaluate(() => {
      const viewer = window.__godsEyeView.viewer;
      viewer.camera.setView({
        destination: viewer.scene.globe.ellipsoid.cartographicToCartesian({
          longitude: (-98 * Math.PI) / 180,
          latitude: (38 * Math.PI) / 180,
          height: 6500000,
        }),
        orientation: { heading: 0, pitch: -Math.PI / 2, roll: 0 },
      });
    });
    await page.evaluate(() =>
      window.__godsEyeView.styleManager._setDetectionMode('OFF'),
    );
    await sample(`${highest}-detection-off`);
    await page.evaluate(async () => {
      const app = window.__godsEyeView;
      app.styleManager._setDetectionMode('DENSE');
      for (const id of ['local-datacenters', 'local-dams'])
        await app.dataManager.setEnabled(id, true, { origin: 'user' });
    });
    await sample(`${highest}-combined`);
    await page.evaluate(async () => {
      const app = window.__godsEyeView;
      for (const id of ['flights', 'local-datacenters', 'local-dams'])
        await app.dataManager.setEnabled(id, false, { origin: 'user' });
    });
    await sample('disabled');
  }
  report.errors.push(...(await readRenderErrors(page)));
  check('no browser/render errors', report.errors.length === 0);
  report.networkFailures = evidence.failed;
  if (args.includes('--verify-viewport')) {
    const viewport = await page.evaluate(async (highest) => {
      const app = window.__godsEyeView,
        layer = app.dataManager.layers.get('flights').module,
        viewer = app.viewer;
      window.__aircraftLoadCount = highest;
      await app.dataManager.setEnabled('flights', true, { origin: 'user' });
      viewer.camera.cancelFlight();
      viewer.camera.setView({
        destination: viewer.scene.globe.ellipsoid.cartographicToCartesian({
          longitude: (-98 * Math.PI) / 180,
          latitude: (38 * Math.PI) / 180,
          height: 1000000,
        }),
        orientation: { heading: 0, pitch: -Math.PI / 2, roll: 0 },
      });
      await new Promise((resolve) => setTimeout(resolve, 1500));
      const counts = [];
      for (let i = 0; i < viewer.scene.primitives.length; i++) {
        const p = viewer.scene.primitives.get(i);
        if (Number.isFinite(p.renderedCount))
          counts.push({ contacts: p.length, residents: p.renderedCount });
      }
      const found = layer.findByQuery('LOAD00000');
      const tracked = layer.trackById('c00000');
      await new Promise((resolve) => setTimeout(resolve, 500));
      return {
        counts,
        found: found?.icao24,
        tracked,
        trackedId: layer.getTrackedInfo()?.icao24,
        cameraOwned: Boolean(viewer.trackedEntity),
        sourceCount: layer.getStats().count,
      };
    }, highest);
    report.viewportCheck = viewport;
    check(
      'viewport: only a subset of markers materialize',
      viewport.counts.some(
        (c) =>
          c.contacts === highest && c.residents > 0 && c.residents < highest,
      ),
    );
    check(
      'viewport: worldwide contact remains searchable',
      viewport.found === 'c00000',
    );
    check(
      'viewport: offscreen contact can be followed',
      viewport.tracked &&
        viewport.trackedId === 'c00000' &&
        viewport.cameraOwned,
    );
    check(
      'viewport: feed population stays intact',
      viewport.sourceCount === highest,
    );
  }
  if (args.includes('--verify-performance')) {
    await page.evaluate(async () => {
      const app = window.__godsEyeView;
      app.dataManager.layers.get('flights').module.stopTracking();
      app.viewer.camera.cancelFlight();
      app.viewer.camera.setView({
        destination: app.viewer.scene.globe.ellipsoid.cartographicToCartesian({
          longitude: (-98 * Math.PI) / 180,
          latitude: (38 * Math.PI) / 180,
          height: 6500000,
        }),
        orientation: { heading: 0, pitch: -Math.PI / 2, roll: 0 },
      });
      for (const id of ['local-datacenters', 'local-dams'])
        await app.dataManager.setEnabled(id, true, { origin: 'user' });
    });
    const snapshot = () =>
      page.evaluate(() => {
        const app = window.__godsEyeView;
        return {
          mode: app.performance.getState().mode,
          fps: app.viewer.targetFrameRate,
          resolution: app.viewer.resolutionScale,
          msaa: app.viewer.scene.msaaSamples,
          selected: app.viewer.selectedEntity?.__gevContextId,
          preservedCanvas:
            app.viewer.scene.context._gl.getContextAttributes()
              .preserveDrawingBuffer,
          records: ['local-datacenters', 'local-dams'].map((id) => {
            const layer = app.dataManager.layers.get(id).module;
            return {
              id,
              count: layer.getStats().count,
              records: layer.getAnalystRecords(100000),
            };
          }),
          sources: Array.from(
            { length: app.viewer.dataSources.length },
            (_, i) => {
              const source = app.viewer.dataSources.get(i);
              return {
                mode: source.resourceMode,
                count: source.entities.values.length,
              };
            },
          ).filter((source) => source.mode),
        };
      });
    await page.select('#performance-mode', 'standard');
    await page.evaluate(() => window.__godsEyeView.performance.whenSettled());
    await pause(1500);
    await page.evaluate(() => {
      const app = window.__godsEyeView;
      for (let i = 0; i < app.viewer.dataSources.length; i++) {
        const entity = app.viewer.dataSources
          .get(i)
          .entities.values.find(
            (entity) => entity.show && entity.__gevContextId,
          );
        if (entity) {
          app.viewer.selectedEntity = entity;
          break;
        }
      }
    });
    const standard = await snapshot();
    await page.select('#performance-mode', 'low');
    await page.evaluate(() => window.__godsEyeView.performance.whenSettled());
    await pause(1500);
    const low = await snapshot();
    await page.select('#performance-mode', 'standard');
    await page.evaluate(() => window.__godsEyeView.performance.whenSettled());
    await pause(1500);
    const restored = await snapshot();
    check(
      'resources: UI applies 30 FPS budget',
      low.mode === 'low' && low.fps === 30,
    );
    check(
      'resources: normal rendering preferences restore',
      restored.mode === 'standard' &&
        restored.fps === standard.fps &&
        restored.resolution === standard.resolution &&
        restored.msaa === standard.msaa,
    );
    check(
      'resources: viewport capture remains supported',
      standard.preservedCanvas &&
        low.preservedCanvas &&
        restored.preservedCanvas,
    );
    assert.deepEqual(
      low.records,
      standard.records,
      'Resource switching must preserve every analyst row',
    );
    assert.deepEqual(
      restored.records,
      standard.records,
      'Returning to standard must preserve every analyst row',
    );
    check('resources: all infrastructure metadata survives switching', true);
    check(
      'resources: selected infrastructure survives rebuilding',
      Boolean(standard.selected) &&
        low.selected === standard.selected &&
        restored.selected === standard.selected,
    );
    check(
      'resources: normal infrastructure stays sparse',
      restored.sources.length === 2 &&
        restored.sources.every(
          (source) => source.mode === 'standard' && source.count < 500,
        ),
    );
    check(
      'resources: preference persists',
      await page.evaluate(
        () => localStorage.getItem('gev:performance-mode:v1') === 'standard',
      ),
    );
    report.performanceCheck = {
      standard: {
        ...standard,
        records: standard.records.map(({ id, count, records }) => ({
          id,
          count,
          analystCount: records.length,
        })),
      },
      low: { ...low, records: undefined },
      restored: { ...restored, records: undefined },
    };
    report.errors.push(...(await readRenderErrors(page)));
    check(
      'resources: no render errors after switching',
      report.errors.length === 0,
    );
  }
  if (baseline) {
    if (baseline.harnessSha256)
      assert.equal(
        report.harnessSha256,
        baseline.harnessSha256,
        'Use the same harness for before and after',
      );
    if (baseline.host) assert.deepEqual(report.host, baseline.host);
    assert.equal(report.browser, baseline.browser);
    assert.equal(report.renderer, baseline.renderer);
    assert.equal(
      report.environment,
      baseline.environment ?? 'development',
      'Application build type must match the baseline',
    );
    assert.deepEqual(counts, baseline.counts);
    assert.equal(durationMs, baseline.durationMs);
    if (baseline.viewport) assert.deepEqual(report.viewport, baseline.viewport);
    else assert.equal(dpr, 1, 'Earlier baseline used DPR 1');
    report.comparison = report.phases.map((p) => {
      const before = baseline.phases.find((b) => b.label === p.label);
      assert.ok(before);
      check(
        `${p.label}: same aircraft population`,
        before.state.flight.count === p.state.flight.count,
      );
      return {
        label: p.label,
        heapDeltaMiB: (p.heapBytes - before.heapBytes) / 1048576,
        taskCpuDeltaPercent: p.taskCpuPercent - before.taskCpuPercent,
        taskCpuReductionPercent:
          before.taskCpuPercent > 0
            ? (1 - p.taskCpuPercent / before.taskCpuPercent) * 100
            : null,
        physicalFootprintDeltaMiB:
          Number.isFinite(p.physicalFootprintBytes) &&
          Number.isFinite(before.physicalFootprintBytes)
            ? (p.physicalFootprintBytes - before.physicalFootprintBytes) /
              1048576
            : null,
        physicalFootprintReductionPercent:
          before.physicalFootprintBytes > 0 &&
          Number.isFinite(p.physicalFootprintBytes)
            ? (1 - p.physicalFootprintBytes / before.physicalFootprintBytes) *
              100
            : null,
        fpsBefore: before.state.frames / before.elapsedSec,
        fpsAfter: p.state.frames / p.elapsedSec,
      };
    });
  }
} catch (error) {
  report.errors.push(String(error.stack || error));
  process.exitCode = 1;
} finally {
  await fs.writeFile(
    path.join(out, 'report.json'),
    JSON.stringify(report, null, 2),
  );
  await browser.close();
  console.log(`Report: ${path.join(out, 'report.json')}`);
  if (report.errors.length) console.error(report.errors.join('\n'));
}
