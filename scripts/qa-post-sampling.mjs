import fs from 'node:fs/promises';
import puppeteer from 'puppeteer';
import sharp from 'sharp';
import { installTileCache } from './qa/tileCache.mjs';
import { blockPaidQaMaps } from './qa-map-policy.mjs';
import { watchW1Page } from './qa-browserEvidence.mjs';
import { installCombinedFixture } from './fixtures/w2/combined.mjs';

const arg = (key) =>
  process.argv.find((s) => s.startsWith(`--${key}=`))?.slice(key.length + 3);
const base = arg('base-url'),
  out = arg('out');
if (
  !base ||
  !out ||
  ['4173', '4185', '4186', '4187', '4188', '4189', '4194'].includes(
    new URL(base).port,
  )
)
  throw new Error('Explicit unreserved base URL and output required');
const report = { checks: [], browserErrors: [] };
const check = (name, pass, detail) => {
  report.checks.push({ name, pass: !!pass, detail });
  console.log(pass ? 'PASS' : 'FAIL', name);
};
const browser = await puppeteer.launch({
  headless: true,
  args: ['--use-angle=metal', '--enable-gpu'],
});
try {
  const page = await browser.newPage();
  await blockPaidQaMaps(page);
  await installTileCache(page);
  await page.setViewport({ width: 1280, height: 800 });
  watchW1Page(page, report, { name: 'batch', baseUrl: base, preview: true });
  const fixture = await installCombinedFixture(page);
  await page.evaluateOnNewDocument(() => {
    localStorage.setItem('gev:first-run-mission:v1', 'suppressed');
    window.__gevW2NativeProbe = ({ view }) => {
      const register = view.registerEffect.bind(view);
      view.registerEffect = (key, Class) =>
        register(
          key,
          key === 'gevInstallationsDrape'
            ? class extends Class {
                constructor(...args) {
                  super(...args);
                  window.__batchOwner = this.owner;
                  window.__batchContext = args[1];
                }
              }
            : Class,
        );
    };
  });
  await page.goto(
    `${base}/?engine=navara&look=cinematic&welcome=0#lat=42.3554&lon=-71.0605&alt=6000&heading=0&pitch=-90&map=osm`,
    { waitUntil: 'domcontentloaded' },
  );
  await page.waitForFunction(
    () =>
      window.__godsEyeView?.engine &&
      document.getElementById('loading-screen')?.classList.contains('hidden'),
    { timeout: 90000 },
  );
  await page.evaluate(async () => {
    const a = window.__godsEyeView;
    if (window.__GOOGLE_MAPS_API_KEY__ || a.tileset)
      throw new Error('Keyless build required');
    await a.styleManager.initialRestorePromise;
    a.styleManager.orbitController.stop();
    a.engine.camera.cancelFlight();
    a.styleManager._setDetectionMode('OFF');
    for (const [id, row] of a.dataManager.layers)
      if (row.enabled) await a.dataManager.setEnabled(id, false);
    await a.dataManager.setEnabled('military-installations', true);
    await a.dataManager.setEnabled('cctv', true);
    a.dataManager.layers
      .get('cctv')
      .module.setParams({ coverageMode: 'viewshed' });
  });
  await page.waitForFunction(
    () =>
      window.__batchOwner?.scene &&
      window.__godsEyeView.dataManager.layers
        .get('military-installations')
        .module.getStats().count === 20 &&
      window.__godsEyeView.engine.surface.tilesLoaded(),
    { timeout: 90000 },
  );
  await new Promise((r) => setTimeout(r, 4000));
  const frames = () =>
    page.evaluate(async () => {
      const a = window.__godsEyeView;
      for (let i = 0; i < 3; i++)
        await new Promise((resolve) => {
          const off = a.engine.frames.postRender.addEventListener(() => {
            off();
            resolve();
          });
          a.engine.render.request('qa-batch');
        });
    });
  const shot = async (suffix) => {
    await frames();
    const png = await page.screenshot({
      path: out.replace(/\.json$/, `-${suffix}.png`),
    });
    return sharp(png).ensureAlpha().raw().toBuffer();
  };
  const optimized = await shot('optimized');
  report.buffers = await page.evaluate(() => {
    const ctx = window.__batchContext,
      pass = ctx.getPass('gevPostSampling');
    if (!pass) throw new Error('Sampling policy absent');
    return {
      post: ctx.getInputBuffer().samples,
      geometry: ctx.getRenderTarget().samples,
      forward: pass.target.samples,
    };
  });
  check(
    'post buffers single-sampled, geometry and overlays retain four samples',
    JSON.stringify(report.buffers) ===
      JSON.stringify({ post: 0, geometry: 4, forward: 4 }),
    report.buffers,
  );
  await page.evaluate(() => {
    const pass = window.__batchContext.getPass('gevPostSampling');
    pass.enabled = false;
    pass.dispose();
  });
  const baseline = await shot('baseline');
  const delta = (a, b) => {
    let changed = 0,
      max = 0,
      sum = 0;
    for (let y = 190; y < 650; y++)
      for (let x = 400; x < 900; x++) {
        const i = (y * 1280 + x) * 4;
        let d = 0;
        for (let c = 0; c < 3; c++) {
          const v = Math.abs(a[i + c] - b[i + c]);
          d = Math.max(d, v);
          sum += v;
        }
        if (d) changed++;
        max = Math.max(max, d);
      }
    return { changed, max, sum };
  };
  report.delta = delta(optimized, baseline);
  check(
    'frozen map, contours, viewsheds and points keep exact pixels',
    report.delta.changed === 0,
    report.delta,
  );
  await page.evaluate(() => {
    for (const mesh of window.__batchOwner.meshes) mesh.visible = false;
  });
  const missing = await shot('missing-contours');
  const negative = delta(baseline, missing);
  check(
    'removing contours fails the pixel oracle',
    negative.changed > 100,
    negative,
  );
  check(
    'no unexpected browser errors',
    report.browserErrors.length === 0,
    report.browserErrors,
  );
  await fixture.dispose();
} finally {
  await browser.close();
  await fs.writeFile(out, JSON.stringify(report, null, 2));
}
if (report.checks.some((c) => !c.pass)) process.exitCode = 1;
