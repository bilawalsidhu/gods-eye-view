#!/usr/bin/env node
import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import puppeteer from 'puppeteer';
import { blockPaidQaMaps } from './qa-map-policy.mjs';
import sharp from 'sharp';
import { watchW1Page } from './qa-browserEvidence.mjs';
import { earthquakeFixture, W2_EPOCH_MS } from './fixtures/w2/earthquakes.mjs';
const arg = (name) =>
  process.argv.find((v) => v.startsWith(`--${name}=`))?.slice(name.length + 3);
const base = arg('base-url');
if (
  !base ||
  [4173, 4185, 4186, 4187, 4188, 4189].includes(Number(new URL(base).port))
)
  throw new Error('Supply unreserved --base-url');
const preview = process.argv.includes('--preview'),
  keyless = !process.argv.includes('--photoreal'),
  negative = process.argv.includes('--diagnostic-disable-mask'),
  negativeMesh = process.argv.includes('--diagnostic-disable-mesh');
const layer = arg('layer') ?? 'earthquakes';
if (!['earthquakes', 'local-firms'].includes(layer))
  throw new Error('Unsupported ground probe layer');
if (preview && negative) throw new Error('Negative shader probe is dev-only');
const out = path.resolve(
  arg('out') ?? 'qa-artifacts/w2/earthquakes-navara/forward-mesh.json',
);
await fs.mkdir(path.dirname(out), { recursive: true });
const report = {
  checks: [],
  browserErrors: [],
  negative,
  negativeMesh,
  keyless,
  layer,
  driverSha256: crypto
    .createHash('sha256')
    .update(await fs.readFile(new URL(import.meta.url)))
    .digest('hex'),
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
try {
  const page = await browser.newPage();
  if (keyless) await blockPaidQaMaps(page);
  await page.setViewport({ width: 1280, height: 800 });
  watchW1Page(page, report, { name: 'main', baseUrl: base, preview });
  if (!preview) {
    await page.setRequestInterception(true);
    page.on('request', async (request) => {
      const pathname = new URL(request.url()).pathname;
      const globe = pathname === '/src/globe/navara/index.js';
      const shader =
        negative &&
        pathname ===
          (layer === 'local-firms'
            ? '/src/layers/firms/render/navara.js'
            : '/src/layers/earthquakes/render/navara.js');
      if (!globe && !shader) {
        await request.continue();
        return;
      }
      try {
        const response = await fetch(request.url());
        if (!response.ok) throw new Error('Probe module request failed');
        let body = await response.text();
        const marker = globe
          ? 'await view.init();'
          : 'if(depth<surface-2e-7) return;';
        if (body.split(marker).length !== 2)
          throw new Error('Probe source anchor lost');
        body = body.replace(
          marker,
          globe
            ? marker +
                ' globalThis.__gevW2NativeProbe?.({view,EffectDesc,NavaraEffect});'
            : '/* diagnostic: forward mask removed */',
        );
        await request.respond({
          status: 200,
          contentType: 'text/javascript',
          body,
        });
      } catch (error) {
        report.browserErrors.push({ page: 'probe', message: error.message });
        await request.abort();
      }
    });
  }
  await page.evaluateOnNewDocument((fixture) => {
    window.__gevW2NativeProbe = (capabilities) => {
      window.__w2Native = capabilities;
    };
    localStorage.setItem('gev:first-run-mission:v1', 'suppressed');
    const fetch = window.fetch.bind(window);
    window.fetch = (input, init) => {
      const url = new URL(
        typeof input === 'string' ? input : (input.url ?? input),
        location.href,
      );
      if (
        url.hostname === 'earthquake.usgs.gov' &&
        url.pathname.endsWith('/all_day.geojson')
      )
        return Promise.resolve(
          new Response(JSON.stringify(fixture), {
            status: 200,
            headers: { 'content-type': 'application/json' },
          }),
        );
      return fetch(input, init);
    };
  }, earthquakeFixture());
  const url = new URL(base);
  url.searchParams.set('engine', 'navara');
  await page.goto(url.href, { waitUntil: 'domcontentloaded', timeout: 180000 });
  await page.waitForFunction(
    () => window.__godsEyeView?.layers && window.__w2Native,
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
  const probeState = { epoch: W2_EPOCH_MS, layer, keyless };
  const scene = await page.evaluate(async ({ epoch, layer, keyless }) => {
    const a = window.__godsEyeView,
      geo = await import('/src/geo/index.js');
    a.styleManager.orbitController.stop();
    a.engine.camera.cancelFlight();
    for (const [id] of a.dataManager.layers)
      if (a.dataManager.isEnabled(id)) await a.layers.disable(id);
    (await import('/src/time/clock.js')).appClock.freeze(epoch);
    (await import('/src/data/detection.js')).setMode('OFF');
    if (layer === 'local-firms') {
      const { loadFirmsRenderer } =
        await import('/scripts/qa-w2-firms-renderer-entry.mjs');
      const { createFirmsNavaraRenderer } = await loadFirmsRenderer();
      window.__w2GroundFirms = createFirmsNavaraRenderer(a.engine, {
        ...window.__w2Native,
        id: 'qa-firms-ground',
      });
      window.__w2GroundFirms.setVisible(true);
      window.__w2GroundFirms.addCell({
        west: -123,
        south: 37,
        east: -122,
        north: 38,
        color: { red: 1, green: 0, blue: 0, alpha: 0.66 },
      });
    } else await a.layers.enable(layer);
    if (keyless && (window.__GOOGLE_MAPS_API_KEY__ || a.tileset))
      throw new Error('Keyless ground QA requires a keyless build');
    await a.mapStackController.setStack(keyless ? 'osm' : 'photoreal');
    a.engine.camera.setView({
      destination: geo.cartesian3.fromDegrees(-122.4028, 37.7952, 1800),
      orientation: { heading: 0, pitch: -Math.PI / 2, roll: 0 },
    });
    const canvas = a.engine.host.canvas;
    const style = document.createElement('style');
    style.textContent = '.w2-hidden{visibility:hidden!important}';
    document.head.append(style);
    for (const element of document.body.querySelectorAll('*'))
      if (element !== canvas && !element.contains(canvas))
        element.classList.add('w2-hidden');
    let since = null;
    const started = performance.now();
    while (performance.now() - started < 90000) {
      if (a.engine.surface.tilesLoaded()) since ??= performance.now();
      else since = null;
      if (since !== null && performance.now() - since > 2000) break;
      a.engine.render.request('w2-forward-settle');
      await new Promise((r) => setTimeout(r, 100));
    }
    return {
      records:
        layer === 'local-firms'
          ? 1
          : a.dataManager.layers.get(layer).module.getAnalystRecords().length,
      mode:
        layer === 'local-firms'
          ? 'isolated-renderer-classification'
          : 'source-fed-earthquakes',
      photoreal: a.engine.maps.photorealActive(),
      settled: a.engine.surface.tilesLoaded(),
    };
  }, probeState);
  check(
    keyless
      ? 'nonempty real keyless ground scene'
      : 'nonempty real photoreal ground scene',
    scene.records === (layer === 'local-firms' ? 1 : 15) &&
      (keyless ? !scene.photoreal : scene.photoreal) &&
      scene.settled,
    scene,
  );
  await sleep(4000);
  const before = await page.screenshot();
  const setGroundVisible = async (show) => {
    await page.evaluate(
      async ({ layer, show }) => {
        if (layer === 'local-firms') window.__w2GroundFirms.setVisible(show);
        else
          await window.__godsEyeView.layers[show ? 'enable' : 'disable'](layer);
        window.__godsEyeView.engine.render.request('w2-ground-probe-toggle');
      },
      { layer, show },
    );
    await sleep(1200);
  };
  await setGroundVisible(false);
  const unclassified = await page.screenshot({
    path: out.replace(/\.json$/, '-bare.png'),
  });
  await setGroundVisible(true);

  await page.evaluate(async (skip) => {
    if (skip) return;
    const { createW2ForwardMeshProbe } =
      await import('/src/bench/w2GroundProbe.js');
    window.__w2Forward = await createW2ForwardMeshProbe(window.__w2Native);
    window.__godsEyeView.engine.render.request('w2-forward-box');
  }, negativeMesh);
  await sleep(2500);
  const on = await page.screenshot({ path: out.replace(/\.json$/, '-on.png') });
  await setGroundVisible(false);
  await sleep(1500);
  const off = await page.screenshot({
    path: out.replace(/\.json$/, '-off.png'),
  });
  const [a, b, c, d] = await Promise.all(
    [on, off, unclassified, before].map((x) =>
      sharp(x).removeAlpha().raw().toBuffer(),
    ),
  );
  let maxDelta = 0,
    contrast = 0,
    groundContrast = 0;
  for (let y = 384; y < 416; y++)
    for (let x = 624; x < 656; x++)
      for (let channel = 0; channel < 3; channel++) {
        const i = (y * 1280 + x) * 3 + channel;
        maxDelta = Math.max(maxDelta, Math.abs(a[i] - b[i]));
        contrast = Math.max(contrast, Math.abs(b[i] - c[i]));
        groundContrast = Math.max(groundContrast, Math.abs(d[i] - c[i]));
      }
  report.forward = { maxDelta, contrast, groundContrast };
  check(
    keyless
      ? 'classification actually paints unobstructed terrain'
      : 'classification actually paints the unobstructed photoreal roof',
    groundContrast > 16,
    report.forward,
  );
  check(
    'a real opaque box covers the classified surface',
    contrast > 16,
    report.forward,
  );
  check(
    'forward mesh pixels remain unclassified',
    maxDelta <= 1,
    report.forward,
  );
  await page.evaluate(async () => {
    const engine = window.__godsEyeView.engine;
    const geo = await import('/src/geo/index.js');
    const position = geo.cartesian3.fromDegrees(-122.4028, 37.7952, 1000);
    window.__qaDepthMovers = ['always', 'normal'].map((depthTest) => {
      const set = engine.movers.createSet({
        id: `qa-ground-depth-${depthTest}`,
        kind: 'point',
        capacity: 1,
        depthTest,
        point: { sizePx: 24 },
      });
      set.setCount(depthTest === 'always' ? 1 : 0);
      set.set(0, { position, color: [0, 1, 0, 1] });
      set.commit();
      return set;
    });
  });
  await sleep(1000);
  const always = await page.screenshot();
  await page.evaluate(() => {
    const [always, normal] = window.__qaDepthMovers;
    always.setCount(0);
    always.commit();
    normal.setCount(1);
    normal.commit();
  });
  await sleep(1000);
  const normal = await page.screenshot();
  const [alwaysPixels, normalPixels] = await Promise.all(
    [always, normal].map((image) =>
      sharp(image).removeAlpha().raw().toBuffer(),
    ),
  );
  let alwaysContrast = 0,
    normalContrast = 0;
  for (let y = 392; y < 408; y++)
    for (let x = 632; x < 648; x++)
      for (let channel = 0; channel < 3; channel++) {
        const i = (y * 1280 + x) * 3 + channel;
        alwaysContrast = Math.max(
          alwaysContrast,
          Math.abs(alwaysPixels[i] - b[i]),
        );
        normalContrast = Math.max(
          normalContrast,
          Math.abs(normalPixels[i] - b[i]),
        );
      }
  report.moverDepth = { alwaysContrast, normalContrast };
  check(
    'always-visible point paints through the opaque box',
    alwaysContrast > 32,
    report.moverDepth,
  );
  check(
    'normal point stays hidden after an always-visible shader was compiled',
    normalContrast <= 1,
    report.moverDepth,
  );
  await page.evaluate(() => {
    for (const set of window.__qaDepthMovers) set.destroy();
    window.__qaDepthMovers = [];
  });
  await page.evaluate(() => {
    window.__w2Forward?.dispose();
    window.__w2GroundFirms?.destroy();
    window.__godsEyeView.engine.render.request('w2-probe-dispose');
  });
  await sleep(3000);
  const idle = await page.evaluate(async () => {
    let frames = 0;
    const stop = window.__godsEyeView.engine.frames.postRender.addEventListener(
      () => frames++,
    );
    await new Promise((r) => setTimeout(r, 2000));
    stop();
    return frames;
  });
  check(
    'probe disposal and disabled layer settle to zero frames',
    idle === 0,
    idle,
  );
} catch (error) {
  check('probe scenario completes', false, error.message);
} finally {
  await browser.close();
}
check(
  'all observed pages have no runtime errors',
  report.browserErrors.length === 0,
  report.browserErrors,
);
if (negative || negativeMesh)
  check('diagnostic mutation is not acceptance', false);
report.pass = report.checks.every((c) => c.pass);
await fs.writeFile(out, JSON.stringify(report, null, 2) + '\n');
process.exitCode = report.pass ? 0 : 1;
