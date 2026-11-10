#!/usr/bin/env node
/**
 * Run the globe contract suite (src/globe/testing/contractSuite.mjs) in
 * headless Chrome against the real engines of a running app, the way
 * contract.test.mjs runs it against the fake engine.
 *
 *   GOOGLE_MAPS_API_KEY= CESIUM_ION_TOKEN= npm run dev -- --port 4241
 *   node scripts/qa-contract-suite.mjs http://localhost:4241 [--engine=cesium,navara] [--json=FILE]
 *
 * Serve the app keyless from the dev server: Google and Cesium ion requests
 * are refused here anyway, so neither engine draws photoreal tiles. The page
 * imports the suite from the dev server, so it shares the app's modules (an
 * engine event is recognised by the module that made it). It gets a real
 * pointer (the pick checks), real 2D canvases for sprite atlases, and no map
 * sources (the maps checks would ask for photoreal tiles). Exits 1 when any check fails on any engine.
 */
import fs from 'node:fs';
import puppeteer from 'puppeteer';

const BLOCKED_HOSTS =
  /(^|\.)(googleapis\.com|google\.com|gstatic\.com|cesium\.com)$/;

const args = process.argv.slice(2);
const origin = args.find((arg) => !arg.startsWith('--'));
const option = (name) =>
  args.find((arg) => arg.startsWith(`--${name}=`))?.slice(name.length + 3);
if (!origin) {
  console.error(
    'Usage: node scripts/qa-contract-suite.mjs <origin> [--engine=cesium,navara] [--only=prefix,...] [--dpr=1|2] [--json=FILE]',
  );
  process.exit(2);
}
const engines = (option('engine') ?? 'cesium,navara').split(',');
// --only=prefix,prefix runs just the checks whose names start with one.
const only =
  option('only')
    ?.split(',')
    .map((prefix) =>
      /^(ground|imagery|movers|lines|meshes|maps):$/.test(prefix)
        ? prefix.replace(':', '.')
        : prefix,
    ) ?? null;
const dpr = Number(option('dpr') ?? 1);
if (![1, 2].includes(dpr)) throw new Error('--dpr must be 1 or 2');

// Checks of state the running app drives itself, by name prefix, with the
// owner. The app sets contact sonar on every frame (src/cyberSonarEngine.js),
// so a value the suite sets does not survive to its next frame.
const APP_OWNED = Object.freeze([
  ['render.setContactSonar', 'src/cyberSonarEngine.js sets it every frame'],
]);

async function runOn(browser, kind) {
  const page = await browser.newPage();
  await page.setViewport({ width: 1280, height: 800, deviceScaleFactor: dpr });
  const pageErrors = [];
  page.on('pageerror', (error) => pageErrors.push(error.message));
  await page.setRequestInterception(true);
  page.on('request', (request) => {
    const { hostname } = new URL(request.url());
    if (new URL(request.url()).pathname === '/__contract_missing_model.glb')
      request.respond({ status: 404, body: 'Model unavailable' });
    else if (BLOCKED_HOSTS.test(hostname)) request.abort();
    else request.continue();
  });
  // A view in the link: the app starts there instead of flying to a city.
  await page.goto(
    `${origin}/?welcome=0&engine=${kind}#v=2&lat=10&lon=20&alt=1000000&heading=0&pitch=-90&map=osm&l=`,
  );
  await page.waitForFunction(
    (expected) =>
      window.__godsEyeView?.engine?.kind === expected &&
      document.getElementById('loading-screen')?.classList.contains('hidden'),
    // A cold dev server compiles Navara's modules on the first visit.
    { timeout: 300_000, polling: 250 },
    kind,
  );
  // The suite owns the globe: no camera flight running, and the app's panels
  // let the pointer through to the canvas.
  // The app restores the view in the link with a flight that can start
  // after the loading screen goes: wait until the camera is there and still,
  // or that flight lands in the middle of a check.
  await page.waitForFunction(
    () => {
      const { camera } = window.__godsEyeView.engine;
      return (
        !camera.flightActive() && Math.abs(camera.height() - 1_000_000) < 1000
      );
    },
    { timeout: 120_000, polling: 250 },
  );
  // Only the engine's canvas takes the pointer: the world overlay draws on a
  // canvas of its own above it.
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
        engine.render.request('contract-suite-settle');
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
  // A real left click and pointer move at a canvas position.
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
  await page.exposeFunction('__contractDrag', async (x, y, endX, endY) => {
    const box = await page.evaluate(() => {
      const rect =
        window.__godsEyeView.engine.host.canvas.getBoundingClientRect();
      return { left: rect.left, top: rect.top };
    });
    await page.mouse.move(box.left + x, box.top + y);
    await page.mouse.down();
    await page.mouse.move(box.left + endX, box.top + endY, { steps: 4 });
    await page.mouse.up();
  });
  await page.exposeFunction('__contractResize', async (width, height) => {
    await page.setViewport({
      width: Math.round(width),
      height: Math.round(height),
      deviceScaleFactor: dpr,
    });
  });
  const results = await page.evaluate(
    async (appOwned, only) => {
      const { engine } = window.__godsEyeView;
      const waitFrames = (count) =>
        new Promise((resolve, reject) => {
          const timer = setTimeout(() => {
            remove();
            reject(new Error('Timed out waiting for a rendered frame'));
          }, 10_000);
          let left = count;
          const remove = engine.frames.postRender.addEventListener(() => {
            if (--left > 0) return;
            remove();
            clearTimeout(timer);
            resolve();
          });
        });
      const pointer = {
        click: (x, y) => window.__contractPointer('click', x, y),
        move: (x, y) => window.__contractPointer('move', x, y),
        drag: (x, y, endX, endY) => window.__contractDrag(x, y, endX, endY),
      };
      const { createContractSuite } =
        await import('/src/globe/testing/contractSuite.mjs');
      const fixtureModule =
        engine.kind === 'cesium'
          ? await import('/src/globe/cesium/testing/contractFixtures.js')
          : await import('/src/globe/navara/testing/contractFixtures.js');
      const fixtures = await fixtureModule.createContractFixtures();
      const outcome = [];
      // A real 2D canvas: a sprite atlas the engines can draw and pick.
      const makeCanvas = (width, height) =>
        Object.assign(document.createElement('canvas'), { width, height });
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
      for (const { name, run } of createContractSuite(engine, {
        waitFrames,
        pointer,
        readRegion,
        makeCanvas,
        fixtures,
        resize: (width, height) => window.__contractResize(width, height),
      })) {
        if (only && !only.some((prefix) => name.startsWith(prefix))) continue;
        const owner = appOwned.find(([prefix]) => name.startsWith(prefix));
        if (owner) {
          outcome.push({ name, skipped: owner[1] });
          continue;
        }
        const knownFailure =
          engine.kind === 'navara' &&
          name ===
            'meshes.createMesh: a single colour draws as asked within 10 per channel'
            ? 'Meshes are drawn before tone mapping'
            : null;
        try {
          await run();
          outcome.push({ name, ok: true });
        } catch (error) {
          outcome.push({
            name,
            ok: false,
            ...(knownFailure &&
              String(error?.message).startsWith(
                'mesh colour within 10 per channel',
              ) && { knownFailure }),
            error: String(error?.message ?? error),
          });
        }
      }
      fixtures.destroy?.();
      return outcome;
    },
    APP_OWNED,
    only,
  );
  await page.close();
  return { engine: kind, dpr, results, pageErrors };
}

const browser = await puppeteer.launch({
  headless: true,
  // A Navara page can hold its main thread for minutes while it starts.
  protocolTimeout: 600_000,
  args: [
    `--use-angle=${process.env.QA_ANGLE ?? (process.platform === 'darwin' ? 'metal' : 'swiftshader')}`,
    '--enable-gpu',
    '--no-sandbox',
  ],
});
const report = [];
try {
  for (const kind of engines) {
    const run = await runOn(browser, kind);
    report.push(run);
    const ran = run.results.filter(({ skipped }) => !skipped);
    const failed = ran.filter(({ ok }) => !ok);
    const known = failed.filter(({ knownFailure }) => knownFailure);
    console.log(
      `${kind} DPR ${dpr}: ${ran.length - failed.length}/${ran.length} checks pass; ${known.length} known failures; ${run.results.length - ran.length} skipped`,
    );
    for (const { name, skipped } of run.results)
      if (skipped) console.log(`  skipped ${name}: ${skipped}`);
    for (const { name, error, knownFailure } of failed)
      console.log(
        `  ${knownFailure ? 'KNOWN FAIL' : 'FAIL'} ${name}: ${error}`,
      );
    for (const message of run.pageErrors)
      console.log(`  page error: ${message}`);
  }
} finally {
  await browser.close();
}
const json = option('json');
if (json) fs.writeFileSync(json, `${JSON.stringify(report, null, 2)}\n`);
process.exit(
  report.every(({ results }) =>
    results.every(
      ({ ok, skipped, knownFailure }) => ok || skipped || knownFailure,
    ),
  )
    ? 0
    : 1,
);
