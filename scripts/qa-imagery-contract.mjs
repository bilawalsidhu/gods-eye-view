// Recent imagery on a keyless preview, starting on Navara: the NASA catalog
// and imagery tiles are fixtures, and the image, A/B, swap, divider, opacity,
// basemap, toggle, failure, box-drag and zoom-to-fit checks read the rendered
// pixels; both pinned dates survive a switch to Cesium and back. The report
// and its screenshots go next to the evidence file (or to the temp directory).
//
//   node scripts/qa-imagery-contract.mjs http://127.0.0.1:<PORT>
//     [--layers=recent-imagery] [--evidence=FILE]
import { closeBrowser } from './qa/browser.mjs';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import sharp from 'sharp';
import {
  createStrict,
  localPreview,
  strictArguments,
} from './qa-strict-harness.mjs';
import { isExpectedPreviewSetupError, redact } from './qa-browserEvidence.mjs';

const { origin } = localPreview(process.argv[2]);
const url = origin + '/?engine=navara';
const { evidence } = strictArguments();
const output = evidence
  ? path.join(path.dirname(evidence), 'imagery-report.json')
  : path.join(os.tmpdir(), 'gev-imagery.json');
const report = {
  url,
  checks: [],
  errors: [],
  expectedErrors: [],
  requests: [],
};
let failLandsat = false,
  failedTiles = 0;
// The engine the page runs, for the strict assertion manifest.
let engine = null;
const strict = createStrict({
  origin,
  layers: ['recent-imagery'],
  // The scenario answers the NASA catalog and imagery tiles itself.
  fixtures: ['*://*.earthdata.nasa.gov/*'],
});
const check = (name, value) => {
  report.checks.push({ name, pass: Boolean(value) });
  if (value && engine) strict.record('recent-imagery', engine, name);
  console.log(`${value ? 'PASS' : 'FAIL'} ${name}`);
};
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const colors = await Promise.all(
  ['#ed3838', '#35c969'].map((background) =>
    sharp({ create: { width: 256, height: 256, channels: 4, background } })
      .png()
      .toBuffer(),
  ),
);
const browser = await strict.launch({
  headless: true,
  args: [
    '--no-sandbox',
    '--disable-background-timer-throttling',
    '--disable-renderer-backgrounding',
  ],
});
try {
  const page = await browser.newPage();
  await page.setViewport({ width: 1280, height: 800, deviceScaleFactor: 1 });
  page.on('pageerror', (e) => report.errors.push(redact(e.message)));
  page.on('console', (message) => {
    if (message.type() !== 'error') return;
    const text = redact(message.text());
    const expected =
      isExpectedPreviewSetupError(message, {
        preview: true,
        baseUrl: url,
      }) ||
      (failedTiles > 0 &&
        ((/\b503\b/.test(text) &&
          String(message.location()?.url).includes('HLS_L30')) ||
          (failLandsat && /Failed to obtain image tile/.test(text))));
    const source = message.location()?.url;
    (expected ? report.expectedErrors : report.errors).push(
      source ? text + ' (' + new URL(source, url).hostname + ')' : text,
    );
  });
  const session = await page.createCDPSession();
  await session.send('Fetch.enable', {
    patterns: [{ urlPattern: '*://*.earthdata.nasa.gov/*' }],
  });
  session.on('Fetch.requestPaused', async (event) => {
    try {
      const request = new URL(event.request.url);
      const catalog = request.hostname === 'cmr.earthdata.nasa.gov';
      const green = request.href.includes('2026-10-27');
      const tileFailure =
        failLandsat &&
        request.pathname.includes('HLS_L30') &&
        request.hostname.startsWith('gibs');
      if (tileFailure) failedTiles++;
      report.requests.push({ host: request.hostname, path: request.pathname });
      const body = catalog
        ? Buffer.from(
            JSON.stringify({
              hits: 2,
              items: ['2026-10-28', '2026-10-27'].map((day) => ({
                umm: {
                  TemporalExtent: {
                    RangeDateTime: { BeginningDateTime: `${day}T12:00:00Z` },
                  },
                  AdditionalAttributes: [
                    { Name: 'CLOUD_COVERAGE', Values: ['0'] },
                  ],
                  SpatialExtent: {
                    HorizontalSpatialDomain: {
                      Geometry: {
                        BoundingRectangles: [
                          {
                            WestBoundingCoordinate: -98,
                            EastBoundingCoordinate: -97,
                            SouthBoundingCoordinate: 30,
                            NorthBoundingCoordinate: 31,
                          },
                        ],
                      },
                    },
                  },
                },
              })),
            }),
          )
        : colors[green ? 1 : 0];
      await session.send('Fetch.fulfillRequest', {
        requestId: event.requestId,
        responseCode: tileFailure ? 503 : 200,
        responseHeaders: [
          {
            name: 'Content-Type',
            value: catalog ? 'application/json' : 'image/png',
          },
          { name: 'Access-Control-Allow-Origin', value: '*' },
          { name: 'Access-Control-Expose-Headers', value: 'Data-Present' },
          { name: 'Data-Present', value: 'true' },
          { name: 'Cache-Control', value: 'no-store' },
        ],
        body: body.toString('base64'),
      });
    } catch (e) {
      if (
        String(e.message).includes(
          'Fetch.fulfillRequest): Invalid InterceptionId',
        )
      )
        report.expectedErrors.push(
          'Fixture response cancelled before fulfillment',
        );
      else if (!page.isClosed()) report.errors.push(redact(e.message));
    }
  });
  const target = new URL(url);
  target.searchParams.set('welcome', '0');
  target.hash = 'lat=30.27&lon=-97.74&alt=12000&heading=0&pitch=-90&map=osm';
  await page.goto(target.href, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(
    () => window.__gevRecentImagery && window.__godsEyeView,
    { timeout: 90000 },
  );
  engine = await page.evaluate(() => window.__godsEyeView.engine.kind);
  await page.evaluate(async () => {
    const app = window.__godsEyeView;
    await app.styleManager.initialRestorePromise;
    app.styleManager.orbitController.stop();
    for (const [id, entry] of app.dataManager.layers)
      if (entry.enabled) await app.dataManager.setEnabled(id, false);
    app.styleManager._setDetectionMode('OFF');
    await app.dataManager.setEnabled('recent-imagery', true);
    window.__gevRecentImagery.layer.setBox({
      west: -97.77,
      east: -97.71,
      south: 30.25,
      north: 30.29,
    });
  });
  await page.waitForFunction(
    () =>
      window.__gevRecentImagery.layer
        .getSnapshot()
        .candidates.filter(
          (c) => c.product === 'S30' && c.thumbnail?.status === 'present',
        ).length >= 2,
    { timeout: 30000 },
  );
  await page.evaluate(() => {
    const l = window.__gevRecentImagery.layer;
    const c = l
      .getSnapshot()
      .candidates.filter((c) => c.product === 'S30')
      .sort((a, b) => b.day.localeCompare(a.day));
    l.setAssignment('a', c[0].key);
    l.setAssignment('b', c[1].key);
    l.setMode('image');
  });
  await page.waitForFunction(
    () => window.__godsEyeView.engine.surface.tilesLoaded(),
    { timeout: 90000 },
  );
  await sleep(4000);
  const capture = async (name) => {
    await page.evaluate(() => window.__godsEyeView.requestRender('imagery-qa'));
    await sleep(350);
    const buffer = await page.screenshot();
    await fs.writeFile(output.replace(/\.json$/, `-${name}.png`), buffer);
    const pixels = await sharp(buffer)
      .raw()
      .toBuffer({ resolveWithObject: true });
    const sample = (x, y) =>
      Array.from(
        pixels.data.subarray(
          (y * pixels.info.width + x) * pixels.info.channels,
          (y * pixels.info.width + x) * pixels.info.channels + 3,
        ),
      );
    const result = {
      left: sample(565, 400),
      right: sample(715, 400),
      outside: sample(340, 400),
    };
    report[name] = result;
    return result;
  };
  const red = (p) => p[0] > p[1] * 1.6 && p[0] > 100;
  const green = (p) => p[1] > p[0] * 1.6 && p[1] > 100;
  let image = await capture('image');
  check(
    'image pixels inside selected box',
    red(image.left) && red(image.right),
  );
  check('geographic clip outside box', !red(image.outside));
  await page.evaluate(() => window.__gevRecentImagery.layer.setMode('ab'));
  await sleep(2500);
  image = await capture('ab');
  check('A/B dates on opposite sides', red(image.left) && green(image.right));
  const first = await page.evaluate(() => {
    window.qaImageryOwner = window.__gevRecentImagery.layer;
    return window.qaImageryOwner.diagnostics().pins;
  });
  const reads = () =>
    report.requests.filter((r) => r.host === 'cmr.earthdata.nasa.gov').length;
  const expectedReads = reads();
  const initial = await page.evaluate(() => window.__godsEyeView.engine.kind);
  for (const kind of [initial === 'navara' ? 'cesium' : 'navara', initial]) {
    await strict.switchTo(page, kind);
    engine = kind;
    const state = await page.evaluate(() => ({
      same: window.__gevRecentImagery.layer === window.qaImageryOwner,
      ...window.qaImageryOwner.diagnostics(),
    }));
    check(
      kind + ' holds both original pins',
      state.same &&
        state.mode === 'ab' &&
        state.pins.a === first.a &&
        state.pins.b === first.b,
    );
    await sleep(1800);
    const pixels = await capture('switch-' + kind);
    check(
      kind + ' renders both pinned dates',
      red(pixels.left) && green(pixels.right),
    );
    check(kind + ' reuses the STAC search', reads() === expectedReads);
  }
  await page.evaluate(() => window.__gevRecentImagery.layer.swapSides());
  image = await capture('swap');
  check('swap reverses dates', green(image.left) && red(image.right));
  await page.evaluate(() => window.__gevRecentImagery.layer.swapSides());
  await page.mouse.move(640, 400);
  await page.mouse.down();
  await page.mouse.move(780, 400, { steps: 10 });
  await page.mouse.up();
  image = await capture('divider');
  check(
    'physical divider drag changes rendered split',
    red(image.left) && red(image.right),
  );
  await page.focus('.recent-imagery-split-handle');
  await page.keyboard.press('Home');
  image = await capture('home');
  check('divider Home exposes B', green(image.left) && green(image.right));
  await page.keyboard.press('End');
  image = await capture('end');
  check('divider End exposes A', red(image.left) && red(image.right));
  await page.evaluate(() => {
    const l = window.__gevRecentImagery.layer;
    l.setMode('image');
    l.setAlpha(0);
  });
  const base = await capture('transparent');
  await page.evaluate(() => window.__gevRecentImagery.layer.setAlpha(0.5));
  const half = await capture('half');
  check(
    'half opacity blends source with basemap',
    half.left.every(
      (c, i) => Math.abs(c - (base.left[i] + report.image.left[i]) / 2) < 5,
    ),
  );
  await page.evaluate(() => {
    const l = window.__gevRecentImagery.layer;
    l.setAlpha(1);
    l.setMode('basemap');
  });
  image = await capture('basemap');
  check(
    'basemap comparison clips only A',
    red(image.left) && !red(image.right),
  );
  report.beforeToggle = await page.evaluate(() =>
    window.__gevRecentImagery.layer.diagnostics(),
  );
  for (let i = 0; i < 10; i++)
    await page.evaluate(async () => {
      const app = window.__godsEyeView;
      await app.dataManager.setEnabled('recent-imagery', false);
      await app.dataManager.setEnabled('recent-imagery', true);
    });
  await page.waitForFunction(
    () => window.__gevRecentImagery.layer.diagnostics().ownedCount === 1,
    { timeout: 30000 },
  );
  await sleep(2000);
  image = await capture('toggles');
  check('ten toggles restore visible image', red(image.left));
  report.afterToggle = await page.evaluate(() =>
    window.__gevRecentImagery.layer.diagnostics(),
  );
  if (report.afterToggle.renderer)
    check(
      'Navara tile admission stays bounded',
      report.afterToggle.renderer.peak <= 6 &&
        Object.values(report.afterToggle.renderer.slots).every(
          (s) => !s || s.tiles <= 64,
        ),
    );
  failLandsat = true;
  await page.evaluate(() => {
    const l = window.__gevRecentImagery.layer;
    l.setMode('image');
    l.setAssignment(
      'a',
      l
        .getSnapshot()
        .candidates.find((c) => c.product === 'L30' && c.day === '2026-10-28')
        .key,
    );
  });
  await sleep(2000);
  image = await capture('source-failure');
  check(
    'failed replacement does not leave stale image pixels',
    failedTiles > 0 && !red(image.left),
  );
  report.failedTiles = failedTiles;
  failLandsat = false;
  await page.evaluate(() => {
    const l = window.__gevRecentImagery.layer;
    const keys = l
      .getSnapshot()
      .candidates.filter((c) => c.product === 'S30')
      .sort((a, b) => b.day.localeCompare(a.day))
      .map((c) => c.key);
    for (let i = 0; i < 10; i++) l.setAssignment('a', keys[i % 2]);
  });
  await sleep(2000);
  image = await capture('replaced');
  check(
    'rapid replacement leaves final date only',
    green(image.left) && green(image.right),
  );
  await page.evaluate(() => window.__gevRecentImagery.layer.clear());
  await sleep(1000);
  check(
    'clear removes both slots',
    await page.evaluate(
      () => window.__gevRecentImagery.layer.diagnostics().ownedCount === 0,
    ),
  );
  const dragStart = await page.evaluate(() => {
    const app = window.__godsEyeView;
    return {
      pose: app.engine.camera.pose().position,
      started: window.__gevRecentImagery.tool.start(),
    };
  });
  await page.mouse.move(480, 300);
  await page.mouse.down();
  await page.mouse.move(780, 500, { steps: 12 });
  await capture('box-drag');
  await page.mouse.up();
  const dragged = await page.evaluate(() => ({
    box: window.__gevRecentImagery.layer.getSnapshot().box,
    active: window.__gevRecentImagery.tool.isActive(),
    pose: window.__godsEyeView.engine.camera.pose().position,
  }));
  check(
    'physical box drag selects geography without moving camera',
    dragStart.started &&
      dragged.box &&
      !dragged.active &&
      ['x', 'y', 'z'].every(
        (k) => Math.abs(dragged.pose[k] - dragStart.pose[k]) < 0.1,
      ),
  );
  const usedView = await page.evaluate(() =>
    window.__gevRecentImagery.layer.useCurrentView(),
  );
  check('USE VIEW works on real engine camera', usedView);
  await page.evaluate(() => {
    const e = window.__godsEyeView.engine,
      p = e.camera.pose();
    e.camera.setView({
      destination: {
        x: p.position.x * 1.2,
        y: p.position.y * 1.2,
        z: p.position.z * 1.2,
      },
      orientation: { heading: 0, pitch: -Math.PI / 2, roll: 0 },
    });
  });
  await page.waitForFunction(
    () =>
      window.__godsEyeView.engine.camera.pose().cartographic.height > 1000000,
    { timeout: 10000 },
  );
  await sleep(350);
  const fit = (report.fit = await page.evaluate(() => {
    const l = window.__gevRecentImagery.layer;
    const used = l.useCurrentView();
    return { used, offered: l.getSnapshot().zoomToFit, height: l.zoomToFit() };
  }));
  check(
    'oversized view refuses and offers bounded zoom',
    !fit.used && fit.offered && fit.height >= 5000 && fit.height <= 400000,
  );
  await sleep(2200);
  check(
    'ZOOM IN lands at requested height',
    await page.evaluate(
      (h) =>
        Math.abs(
          window.__godsEyeView.engine.camera.pose().cartographic.height - h,
        ) < 5,
      fit.height,
    ),
  );
  await page.evaluate(async () => {
    window.__gevRecentImagery.layer.clear();
    await window.__godsEyeView.dataManager.setEnabled('recent-imagery', false);
  });
  await sleep(1000);
  report.disabled = await page.evaluate(() =>
    window.__gevRecentImagery.layer.diagnostics(),
  );
  check(
    'disable leaves no imagery owners or queued requests',
    report.disabled.ownedCount === 0 &&
      (!report.disabled.renderer ||
        (report.disabled.renderer.active === 0 &&
          report.disabled.renderer.queued === 0)),
  );
  check('no browser exceptions', report.errors.length === 0);
} catch (e) {
  report.errors.push(e.stack);
  check('driver completes', false);
} finally {
  await closeBrowser(browser);
  await fs.writeFile(output, JSON.stringify(report, null, 2));
}
const failed = report.checks.some((c) => !c.pass);
await strict.finishAndExit({ failed: failed ? 'imagery checks failed' : null });
