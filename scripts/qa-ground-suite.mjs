#!/usr/bin/env node
/**
 * Run the contract suite's engine.ground checks in headless Chrome on both
 * real engines, with what qa-contract-suite.mjs does not give the suite: a
 * readRegion of the engine canvas (the pixel check) besides the real
 * pointer (the click pick). Serve the app keyless:
 *
 *   GOOGLE_MAPS_API_KEY= CESIUM_ION_TOKEN= npm run dev -- --port 4271
 *   node scripts/qa-ground-suite.mjs http://localhost:4271 [--engine=cesium,navara] [--only=ground:]
 *
 * Exits 1 when a check fails on any engine.
 */
import puppeteer from 'puppeteer';

const BLOCKED_HOSTS =
  /(^|\.)(googleapis\.com|google\.com|gstatic\.com|cesium\.com)$/;
const args = process.argv.slice(2);
const origin = args.find((arg) => !arg.startsWith('--'));
const option = (name) =>
  args.find((arg) => arg.startsWith(`--${name}=`))?.slice(name.length + 3);
if (!origin) {
  console.error(
    'Usage: node scripts/qa-ground-suite.mjs <origin> [--engine=cesium,navara] [--only=prefix]',
  );
  process.exit(2);
}
const engines = (option('engine') ?? 'cesium,navara').split(',');
const only = (option('only') ?? 'ground:').split(',');

async function runOn(browser, kind) {
  const page = await browser.newPage();
  await page.setViewport({ width: 1280, height: 800 });
  const pageErrors = [];
  page.on('pageerror', (error) => pageErrors.push(error.message));
  await page.setRequestInterception(true);
  page.on('request', (request) => {
    if (BLOCKED_HOSTS.test(new URL(request.url()).hostname)) request.abort();
    else request.continue();
  });
  await page.goto(
    `${origin}/?welcome=0&engine=${kind}#v=2&lat=10&lon=20&alt=1000000&heading=0&pitch=-90&map=osm&l=`,
  );
  await page.waitForFunction(
    (expected) =>
      window.__godsEyeView?.engine?.kind === expected &&
      document.getElementById('loading-screen')?.classList.contains('hidden'),
    { timeout: 300_000, polling: 250 },
    kind,
  );
  await page.waitForFunction(
    () => !window.__godsEyeView.engine.camera.flightActive(),
    { timeout: 60_000, polling: 250 },
  );
  // The globe drawn and its tiles loaded: a restored view hides the globe
  // for a moment after the loading screen goes.
  await page.evaluate(async () => {
    const { engine } = window.__godsEyeView;
    const canvas = engine.host.canvas;
    const probe = document.createElement('canvas');
    probe.width = 1;
    probe.height = 1;
    const context = probe.getContext('2d', { willReadFrequently: true });
    const started = performance.now();
    let settled = 0;
    while (performance.now() - started < 120_000 && settled < 20) {
      await new Promise((resolve) => {
        const remove = engine.frames.postRender.addEventListener(() => {
          remove();
          resolve();
        });
        engine.render.request('ground-suite-settle');
      });
      context.drawImage(
        canvas,
        canvas.width / 2,
        canvas.height / 2,
        1,
        1,
        0,
        0,
        1,
        1,
      );
      const [r, g, b] = context.getImageData(0, 0, 1, 1).data;
      settled =
        r + g + b > 60 && engine.surface.tilesLoaded() ? settled + 1 : 0;
    }
  });
  await page.evaluate(() =>
    window.__godsEyeView.engine.host.canvas.setAttribute(
      'data-contract-target',
      '',
    ),
  );
  await page.addStyleTag({
    content:
      '* { pointer-events: none !important; } [data-contract-target] { pointer-events: auto !important; }',
  });
  await page.exposeFunction('__contractPointer', async (type, x, y) => {
    const box = await page.evaluate(() => {
      const rect =
        window.__godsEyeView.engine.host.canvas.getBoundingClientRect();
      return { left: rect.left, top: rect.top };
    });
    const at = [box.left + x, box.top + y];
    if (type === 'click') await page.mouse.click(...at);
    else {
      await page.mouse.move(at[0] - 1, at[1]);
      await page.mouse.move(...at);
    }
  });
  const results = await page.evaluate(async (only) => {
    const { engine } = window.__godsEyeView;
    const waitFrames = (count) =>
      new Promise((resolve) => {
        let left = count;
        const remove = engine.frames.postRender.addEventListener(() => {
          if (--left > 0) return;
          remove();
          resolve();
        });
        engine.render.request('ground-suite');
      });
    const pointer = {
      click: (x, y) => window.__contractPointer('click', x, y),
      move: (x, y) => window.__contractPointer('move', x, y),
    };
    // RGBA of the last drawn frame (both engines keep their drawing buffer).
    const scratch = document.createElement('canvas');
    const context = scratch.getContext('2d', { willReadFrequently: true });
    const readRegion = (x, y, width, height) => {
      const canvas = engine.host.canvas;
      const scale = canvas.width / canvas.clientWidth;
      scratch.width = width;
      scratch.height = height;
      context.clearRect(0, 0, width, height);
      context.drawImage(
        canvas,
        x * scale,
        y * scale,
        width * scale,
        height * scale,
        0,
        0,
        width,
        height,
      );
      return context.getImageData(0, 0, width, height).data;
    };
    const makeCanvas = (width, height) =>
      Object.assign(document.createElement('canvas'), { width, height });
    const { createContractSuite } =
      await import('/src/globe/testing/contractSuite.mjs');
    const outcome = [];
    for (const { name, run } of createContractSuite(engine, {
      waitFrames,
      pointer,
      readRegion,
      makeCanvas,
    })) {
      if (!only.some((prefix) => name.startsWith(prefix))) continue;
      try {
        await run();
        outcome.push({ name, ok: true });
      } catch (error) {
        outcome.push({
          name,
          ok: false,
          error: String(error?.message ?? error),
        });
      }
    }
    return outcome;
  }, only);
  await page.close();
  return { engine: kind, results, pageErrors };
}

const browser = await puppeteer.launch({ headless: true });
let failed = false;
try {
  for (const kind of engines) {
    const { results, pageErrors } = await runOn(browser, kind);
    const passed = results.filter((result) => result.ok).length;
    console.log(`${kind}: ${passed}/${results.length} checks pass`);
    for (const result of results)
      if (!result.ok) {
        failed = true;
        console.log(`  FAIL ${result.name}: ${result.error}`);
      } else console.log(`  ok   ${result.name}`);
    for (const message of pageErrors) console.log(`  page error: ${message}`);
  }
} finally {
  await browser.close();
}
process.exit(failed ? 1 : 0);
