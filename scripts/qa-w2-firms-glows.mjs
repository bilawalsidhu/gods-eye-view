#!/usr/bin/env node
// Actual FIRMS source/layer pixels over an independently verified unlit GLB field.
import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import puppeteer from 'puppeteer';
import { blockPaidQaMaps } from './qa-map-policy.mjs';
import sharp from 'sharp';
import { watchW1Page } from './qa-browserEvidence.mjs';
import { FIRMS_EPOCH_MS } from './fixtures/w2/firms.mjs';
import { analyzeFirmsGlow } from './qa-firms-glow-metrics.mjs';
const arg = (k) =>
  process.argv.find((v) => v.startsWith(`--${k}=`))?.slice(k.length + 3);
const base = arg('base-url'),
  preview = process.argv.includes('--preview');
if (
  !base ||
  [4173, 4185, 4186, 4187, 4188, 4189].includes(Number(new URL(base).port))
)
  throw new Error('Supply unreserved --base-url');
const late = process.argv.includes('--diagnostic-after-sharpen');
if (preview && late) throw new Error('Source mutation is dev-only');
const out = path.resolve(arg('out') ?? 'qa-artifacts/w2/firms/glows.json');
await fs.mkdir(path.dirname(out), { recursive: true });
const sha = (value) => crypto.createHash('sha256').update(value).digest('hex');
function fieldGlb() {
  const vertices = new Float32Array([
    -1, -1, -1, 1, -1, -1, 1, 1, -1, -1, 1, -1, -1, -1, 1, 1, -1, 1, 1, 1, 1,
    -1, 1, 1,
  ]);
  const indices = new Uint16Array([
    0, 2, 1, 0, 3, 2, 4, 5, 6, 4, 6, 7, 0, 1, 5, 0, 5, 4, 2, 3, 7, 2, 7, 6, 0,
    4, 7, 0, 7, 3, 1, 2, 6, 1, 6, 5,
  ]);
  const bin = Buffer.concat([
    Buffer.from(vertices.buffer),
    Buffer.from(indices.buffer),
  ]);
  const json = {
    asset: { version: '2.0' },
    extensionsUsed: ['KHR_materials_unlit'],
    scene: 0,
    scenes: [{ nodes: [0] }],
    nodes: [{ mesh: 0 }],
    meshes: [
      {
        primitives: [{ attributes: { POSITION: 0 }, indices: 1, material: 0 }],
      },
    ],
    materials: [
      {
        doubleSided: true,
        pbrMetallicRoughness: { baseColorFactor: [1, 1, 1, 1] },
        extensions: { KHR_materials_unlit: {} },
      },
    ],
    buffers: [{ byteLength: bin.length }],
    bufferViews: [
      {
        buffer: 0,
        byteOffset: 0,
        byteLength: vertices.byteLength,
        target: 34962,
      },
      {
        buffer: 0,
        byteOffset: vertices.byteLength,
        byteLength: indices.byteLength,
        target: 34963,
      },
    ],
    accessors: [
      {
        bufferView: 0,
        componentType: 5126,
        count: 8,
        type: 'VEC3',
        min: [-1, -1, -1],
        max: [1, 1, 1],
      },
      { bufferView: 1, componentType: 5123, count: 36, type: 'SCALAR' },
    ],
  };
  const bytes = Buffer.from(JSON.stringify(json)),
    padding = (4 - (bytes.length % 4)) % 4,
    j = Buffer.concat([bytes, Buffer.alloc(padding, 32)]),
    header = Buffer.alloc(12),
    jh = Buffer.alloc(8),
    bh = Buffer.alloc(8);
  header.writeUInt32LE(0x46546c67, 0);
  header.writeUInt32LE(2, 4);
  header.writeUInt32LE(12 + 8 + j.length + 8 + bin.length, 8);
  jh.writeUInt32LE(j.length, 0);
  jh.writeUInt32LE(0x4e4f534a, 4);
  bh.writeUInt32LE(bin.length, 0);
  bh.writeUInt32LE(0x004e4942, 4);
  return Buffer.concat([header, jh, j, bh, bin]);
}
const glb = fieldGlb(),
  requested = [16, 32, 48],
  cases = [
    { name: 'yellow', frp: 0, confidence: 'low' },
    { name: 'orange', frp: 25, confidence: 'nominal' },
    { name: 'red', frp: 999, confidence: 'high' },
  ];
const report = {
  stage: 'actual FIRMS source and layer on controlled visible model background',
  late,
  checks: [],
  browserErrors: [],
  captures: {},
  driverSha256: sha(await fs.readFile(new URL(import.meta.url))),
  fieldGlbSha256: sha(glb),
};
const check = (name, pass, detail) => {
  report.checks.push({ name, pass: Boolean(pass), detail });
  console.log(`${pass ? 'PASS' : 'FAIL'} ${name}`);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const browser = await puppeteer.launch({
  headless: true,
  protocolTimeout: 180000,
  args: ['--use-angle=metal'],
});
const pixels = new Map();
try {
  for (const engine of ['cesium', 'navara']) {
    const context = await browser.createBrowserContext();
    try {
      const page = await context.newPage();
      await blockPaidQaMaps(page);
      await page.setViewport({ width: 1280, height: 800 });
      watchW1Page(page, report, { name: engine, baseUrl: base, preview });
      if (late && engine === 'navara') {
        await page.setRequestInterception(true);
        page.on('request', async (request) => {
          if (
            new URL(request.url()).pathname !== '/src/globe/navara/overlay.js'
          ) {
            await request.continue();
            return;
          }
          try {
            const response = await fetch(request.url());
            let body = await response.text();
            const marker =
              'class GevPreSharpenOverlayEffectDesc extends GevOverlayEffectDesc {';
            const start = body.indexOf(marker);
            if (start < 0) throw new Error('Early overlay anchor lost');
            const tail = body.slice(start),
              anchor = "static insertAfter = ['toneMapping'];";
            if (tail.split(anchor).length !== 2)
              throw new Error('Early stage anchor lost');
            body =
              body.slice(0, start) +
              tail.replace(
                anchor,
                "static insertAfter = ['fxaa', 'smaa', 'gevSharpen', 'toneMapping'];",
              );
            report.mutations = (report.mutations ?? 0) + 1;
            await request.respond({
              status: 200,
              contentType: 'text/javascript',
              body,
            });
          } catch (error) {
            report.browserErrors.push({
              page: 'mutation',
              message: error.message,
            });
            await request.abort();
          }
        });
      }
      await page.evaluateOnNewDocument((epoch) => {
        localStorage.setItem('gev:first-run-mission:v1', 'suppressed');
        window.__firmsGlow = { frp: 0, confidence: 'low' };
        const original = window.fetch.bind(window),
          json = (value) =>
            new Response(JSON.stringify(value), {
              status: 200,
              headers: { 'content-type': 'application/json' },
            });
        window.fetch = (input, init) => {
          const url = new URL(
            typeof input === 'string' ? input : (input.url ?? input),
            location.href,
          );
          if (url.origin === location.origin && url.pathname === '/api/firms')
            return Promise.resolve(
              json({
                fires: [
                  {
                    lat: 37.77,
                    lon: -123,
                    frp: window.__firmsGlow.frp,
                    confidence: window.__firmsGlow.confidence,
                    brightness: 320,
                    daynight: 'D',
                    acqDate: '2026-10-16',
                    acqTime: '930',
                    instrument: 'VIIRS',
                    satellite: 'NOAA-20',
                  },
                ],
                fetchedAt: epoch - 120000,
                stale: false,
              }),
            );
          if (
            url.origin === location.origin &&
            url.pathname === '/api/openai/hud-summary'
          )
            return Promise.resolve(json({ summary: 'FIRMS glow fixture' }));
          if (
            url.origin === location.origin &&
            url.pathname === '/api/terrain/heights'
          )
            return Promise.resolve(
              json({
                results: (url.searchParams.get('points') ?? '')
                  .split(';')
                  .filter(Boolean)
                  .map((p) => {
                    const [lon, lat] = p.split(',').map(Number);
                    return {
                      lon,
                      lat,
                      elevation: 100,
                      geoid: 0,
                      ellipsoid: 100,
                    };
                  }),
              }),
            );
          return original(input, init);
        };
      }, FIRMS_EPOCH_MS);
      const url = new URL(base);
      url.searchParams.set('engine', engine);
      url.searchParams.set('look', 'minimal');
      await page.goto(url.href, {
        waitUntil: 'domcontentloaded',
        timeout: 180000,
      });
      await page.waitForFunction(
        () =>
          window.__godsEyeView?.layers &&
          document
            .getElementById('loading-screen')
            ?.classList.contains('hidden'),
        { timeout: 180000 },
      );
      await page.evaluate(
        () => window.__godsEyeView.styleManager.initialRestorePromise,
      );
      const setup = await page.evaluate(
        async ({ epoch, modelUrl, color }) => {
          const a = window.__godsEyeView,
            g = await import('/src/geo/index.js');
          a.styleManager.orbitController.stop();
          a.engine.camera.cancelFlight();
          for (const [id] of a.dataManager.layers)
            if (a.dataManager.isEnabled(id)) await a.layers.disable(id);
          (await import('/src/data/detection.js')).setMode('OFF');
          (await import('/src/time/clock.js')).appClock.freeze(epoch);
          if (a.viewer)
            a.viewer.clock.currentTime =
              a.viewer.clock.currentTime.constructor.fromDate(new Date(epoch));
          const defaultSharpen = a.styleManager.getControlState().sharpen;
          a.styleManager._setBloomEnabled(false);
          a.styleManager._setSharpenEnabled(false);
          a.engine.camera.setView({
            destination: g.cartesian3.fromDegrees(-123, 37.77, 100000),
            orientation: { heading: 0, pitch: -Math.PI / 2, roll: 0 },
          });
          const field = a.engine.movers.createSet({
            id: 'qa-firms-field',
            kind: 'model',
            capacity: 1,
            pickable: false,
            model: {
              url: modelUrl,
              minimumPixelSize: 1024,
              unlit: true,
              colorBlend: { mode: 'replace', amount: 1 },
            },
          });
          field.set(0, {
            position: g.cartesian3.fromDegrees(-123, 37.77, 10000),
            color: [...color.map((v) => v / 255), 1],
            show: true,
          });
          field.setCount(1);
          field.commit();
          window.__firmsField = field;
          const canvas = a.engine.host.canvas,
            style = document.createElement('style');
          style.textContent = '.glow-hidden{visibility:hidden!important}';
          document.head.append(style);
          for (const e of document.body.querySelectorAll('*'))
            if (e !== canvas && !e.contains(canvas))
              e.classList.add('glow-hidden');
          const start = performance.now();
          let since = null;
          while (performance.now() - start < 90000) {
            if (a.engine.surface.tilesLoaded() && field.ready())
              since ??= performance.now();
            else since = null;
            if (since !== null && performance.now() - since > 1500) break;
            a.engine.render.request('firms-glow-ready');
            await new Promise((r) => setTimeout(r, 100));
          }
          return {
            ready: field.ready(),
            tiles: a.engine.surface.tilesLoaded(),
            kind: a.engine.kind,
            bloom: a.styleManager.bloomEnabled,
            defaultSharpen,
          };
        },
        {
          epoch: FIRMS_EPOCH_MS,
          modelUrl: 'data:model/gltf-binary;base64,' + glb.toString('base64'),
          color: requested,
        },
      );
      check(
        engine + ': real background model loads on the expected engine',
        setup.ready &&
          setup.tiles &&
          setup.kind === engine &&
          setup.bloom === false,
        setup,
      );
      check(
        engine + ': existing engine sharpen default is preserved',
        setup.defaultSharpen.intensityPct === (engine === 'cesium' ? 49 : 80),
        setup.defaultSharpen,
      );
      // Warm every real source image before comparing fixed raster inputs.
      // Native UV packing changes when its atlas grows; do not compare cold
      // raw inputs with a later warmed sharpen pass.
      for (const item of cases) {
        await page.evaluate(async (item) => {
          window.__firmsGlow = { ...item };
          const a = window.__godsEyeView;
          await a.layers.enable('local-firms');
          await a.dataManager.layers.get('local-firms').module.update();
          a.engine.render.request('firms-glow-atlas-warm');
        }, item);
        await sleep(800);
        const warm = await sharp(await page.screenshot())
          .extract({ left: 636, top: 396, width: 8, height: 8 })
          .removeAlpha()
          .raw()
          .toBuffer();
        let signal = 0;
        for (let i = 0; i < warm.length; i++)
          signal = Math.max(signal, Math.abs(warm[i] - requested[i % 3]));
        check(
          engine + '/' + item.name + ': actual warmup glow paints',
          signal > 16,
          { signal },
        );
        await page.evaluate(() =>
          window.__godsEyeView.layers.disable('local-firms'),
        );
        await sleep(300);
      }
      for (const mode of ['raw', 'matched-sharpen', 'default-sharpen']) {
        const controls = await page.evaluate(
          ({ mode, defaultIntensity }) => {
            const a = window.__godsEyeView;
            a.styleManager.setSharpen({
              enabled: mode !== 'raw',
              intensityPct: mode === 'default-sharpen' ? defaultIntensity : 49,
            });
            return a.styleManager.getControlState().sharpen;
          },
          { mode, defaultIntensity: setup.defaultSharpen.intensityPct },
        );
        check(
          engine + '/' + mode + ': explicit effect settings applied',
          controls.enabled === (mode !== 'raw') &&
            controls.intensityPct ===
              (mode === 'default-sharpen'
                ? setup.defaultSharpen.intensityPct
                : 49),
          controls,
        );
        await sleep(800);
        const bgFile = out.replace(
            /\.json$/,
            `-${engine}-${mode}-background.png`,
          ),
          bg = await page.screenshot({ path: bgFile });
        const bgData = await sharp(bg).removeAlpha().raw().toBuffer();
        let maxFieldError = 0;
        for (let y = 360; y < 440; y++)
          for (let x = 600; x < 680; x++)
            for (let c = 0; c < 3; c++)
              maxFieldError = Math.max(
                maxFieldError,
                Math.abs(bgData[(y * 1280 + x) * 3 + c] - requested[c]),
              );
        check(
          engine +
            '/' +
            mode +
            ': background is the requested uniform RGB field',
          maxFieldError <= 1,
          { maxFieldError, requested },
        );
        for (const item of cases) {
          const proof = await page.evaluate(async (item) => {
            window.__firmsGlow = { ...item };
            const a = window.__godsEyeView,
              m = a.dataManager.layers.get('local-firms').module;
            await a.layers.enable('local-firms');
            await m.update();
            a.engine.render.request('firms-glow-case');
            return { records: m.getAnalystRecords(10), stats: m.getStats() };
          }, item);
          await sleep(1600);
          const position = await page.evaluate(() => {
            const a = window.__godsEyeView,
              m = a.dataManager.layers.get('local-firms').module,
              p = m.getDetectableObjects({ maxCount: 10 })[0]?.position;
            const s = p && a.engine.projector.worldToWindow(p);
            return s ? { x: s.x, y: s.y } : null;
          });
          const name = engine + '/' + mode + '/' + item.name,
            file = out.replace(
              /\.json$/,
              `-${engine}-${mode}-${item.name}.png`,
            ),
            image = await page.screenshot({ path: file }),
            data = await sharp(image).removeAlpha().raw().toBuffer();
          const cx = Math.round(position?.x ?? -100),
            cy = Math.round(position?.y ?? -100);
          let signal = 0;
          const values = [];
          if (cx > 31 && cx < 1249 && cy > 31 && cy < 769)
            for (let y = cy - 30; y <= cy + 30; y++)
              for (let x = cx - 30; x <= cx + 30; x++)
                for (let c = 0; c < 3; c++) {
                  const i = (y * 1280 + x) * 3 + c;
                  signal = Math.max(signal, Math.abs(data[i] - bgData[i]));
                  values.push(data[i]);
                }
          const detail = {
            position,
            signal,
            records: proof.records.length,
            frp: proof.records[0]?.frp,
            cells: proof.stats.cells,
            lod: proof.stats.lod,
            sha256: sha(image),
          };
          check(
            name + ': one real source detection paints a nonempty glow',
            proof.records.length === 1 &&
              proof.records[0].frp === item.frp &&
              proof.stats.cells === 1 &&
              values.length === 11163 &&
              signal > 16,
            detail,
          );
          pixels.set(name, values);
          report.captures[name] = detail;
          await page.evaluate(() =>
            window.__godsEyeView.layers.disable('local-firms'),
          );
          await sleep(800);
        }
      }
      await page.evaluate(() => {
        window.__firmsField.destroy();
        window.__godsEyeView.engine.render.request('firms-field-disposed');
      });
    } finally {
      await context.close();
    }
  }
  report.profiles = {};
  for (const item of cases) {
    const frames = Object.fromEntries(
      ['cesium', 'navara'].map((engine) => [
        engine,
        Object.fromEntries(
          ['raw', 'matched-sharpen', 'default-sharpen'].map((mode) => [
            mode,
            pixels.get(engine + '/' + mode + '/' + item.name),
          ]),
        ),
      ]),
    );
    const result = analyzeFirmsGlow(frames);
    report.profiles[item.name] = result;
    check(
      item.name + ': alpha-derived geometry within2px and5%',
      result.checks.geometry,
      result.geometry,
    );
    check(
      item.name + ': unaligned full alpha profile within3 RGB levels',
      result.checks.unalignedAlpha,
      result.raw,
    );
    check(
      item.name + ': full source-aligned raw colors within3 RGB levels',
      result.checks.rawColor,
      result.raw,
    );
    check(
      item.name + ': full source-aligned sharpen colors within3 RGB levels',
      result.checks.sharpenColor,
      result.sharpen,
    );
    check(
      item.name +
        ': native sharpen matches its own encoded box kernel within1 RGB',
      result.checks.nativeKernel,
      result.kernels.cesium,
    );
    check(
      item.name +
        ': Navara sharpen matches its own encoded box kernel within1 RGB',
      result.checks.navaraKernel,
      result.kernels.navara,
    );
  }
} catch (error) {
  check('glow scenario completes', false, error.message);
} finally {
  await browser.close();
}
check(
  'all observed pages have no runtime errors',
  report.browserErrors.length === 0,
  report.browserErrors,
);
if (late) {
  check(
    'late-stage mutation was injected once',
    report.mutations === 1,
    report.mutations,
  );
  check('diagnostic mutation is not acceptance', false);
}
report.pass = report.checks.every((c) => c.pass);
await fs.writeFile(out, JSON.stringify(report, null, 2) + '\n');
process.exitCode = report.pass ? 0 : 1;
