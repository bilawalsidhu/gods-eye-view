import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import puppeteer from 'puppeteer';
import sharp from 'sharp';
import { watchW1Page } from './qa-browserEvidence.mjs';
import { earthquakeFixture, W2_EPOCH_MS } from './fixtures/w2/earthquakes.mjs';
const arg = (k) =>
  process.argv.find((v) => v.startsWith(`--${k}=`))?.slice(k.length + 3);
const base = arg('base-url');
if (
  !base ||
  [4173, 4185, 4186, 4187, 4188, 4189].includes(Number(new URL(base).port))
)
  throw new Error('Supply own unreserved dev URL');
const out = path.resolve(
  arg('out') ??
    'qa-artifacts/w2/earthquakes-navara/final/sector-equivalence.json',
);
await fs.mkdir(path.dirname(out), { recursive: true });
const sha = (b) => crypto.createHash('sha256').update(b).digest('hex');
const report = {
  checks: [],
  browserErrors: [],
  poses: {},
  driverSha256: sha(await fs.readFile(new URL(import.meta.url))),
  productSourceSha256: sha(
    await fs.readFile(
      new URL('../src/layers/earthquakes/render/navara.js', import.meta.url),
    ),
  ),
};
const check = (name, pass, detail) => {
  report.checks.push({ name, pass: !!pass, detail });
  console.log(`${pass ? 'PASS' : 'FAIL'} ${name}`);
};
const browser = await puppeteer.launch({
  headless: true,
  protocolTimeout: 180000,
  args: ['--use-angle=metal'],
});
try {
  const page = await browser.newPage();
  await page.setViewport({ width: 1280, height: 800 });
  watchW1Page(page, report, { name: 'main', baseUrl: base });
  await page.setRequestInterception(true);
  page.on('request', async (request) => {
    if (
      new URL(request.url()).pathname !=
      '/src/layers/earthquakes/render/navara.js'
    ) {
      await request.continue();
      return;
    }
    try {
      const response = await fetch(request.url());
      if (!response.ok) throw new Error('Source unavailable');
      let body = await response.text();
      for (const [from, to] of [
        [
          'uniform float uLogDepthFC;',
          'uniform float uLogDepthFC;\nuniform float uQaFast;',
        ],
        ['bool large=center.w>', 'bool large=uQaFast>0.5 && center.w>'],
        [
          '...groundSurfaceUniforms(),',
          "...groundSurfaceUniforms(), ['uQaFast', new Uniform(1)],",
        ],
        [
          'return new NavaraEffect(this.view.camera.raw, this.effect);',
          'globalThis.__w2SectorEffect=this.effect; return new NavaraEffect(this.view.camera.raw, this.effect);',
        ],
      ]) {
        if (body.split(from).length !== 2)
          throw new Error('Source anchor lost: ' + from);
        body = body.replace(from, to);
      }
      report.patchedModuleSha256 = sha(body);
      await request.respond({
        status: 200,
        contentType: 'text/javascript',
        body,
      });
    } catch (error) {
      report.browserErrors.push(error.message);
      await request.abort();
    }
  });
  await page.evaluateOnNewDocument((fixture) => {
    localStorage.setItem('gev:first-run-mission:v1', 'suppressed');
    const original = window.fetch.bind(window);
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
          new Response(
            JSON.stringify(
              globalThis.__w2Antipode
                ? {
                    ...fixture,
                    features: [...fixture.features, globalThis.__w2Antipode],
                  }
                : fixture,
            ),
            {
              status: 200,
              headers: { 'content-type': 'application/json' },
            },
          ),
        );
      return original(input, init);
    };
  }, earthquakeFixture());
  const url = new URL(base);
  url.searchParams.set('engine', 'navara');
  await page.goto(url.href, { waitUntil: 'domcontentloaded', timeout: 180000 });
  await page.waitForFunction(() => window.__godsEyeView?.layers, {
    timeout: 180000,
  });
  await page.evaluate(
    () => window.__godsEyeView.styleManager.initialRestorePromise,
  );
  await page.waitForFunction(
    () =>
      document.getElementById('loading-screen')?.classList.contains('hidden'),
    { timeout: 180000 },
  );
  await page.evaluate(async (epoch) => {
    const a = window.__godsEyeView;
    a.styleManager.orbitController.stop();
    a.engine.camera.cancelFlight();
    for (const [id] of a.dataManager.layers)
      if (a.dataManager.isEnabled(id)) await a.layers.disable(id);
    (await import('/src/time/clock.js')).appClock.freeze(epoch);
    (await import('/src/data/detection.js')).setMode('OFF');
    await a.layers.enable('earthquakes');
    const canvas = a.engine.host.canvas,
      style = document.createElement('style');
    style.textContent = '.w2-hidden{visibility:hidden!important}';
    document.head.append(style);
    for (const e of document.body.querySelectorAll('*'))
      if (e !== canvas && !e.contains(canvas)) e.classList.add('w2-hidden');
  }, W2_EPOCH_MS);
  await page.waitForFunction(() => window.__w2SectorEffect, { timeout: 30000 });
  for (const [name, pose] of Object.entries({
    global: [-100, 35, 15000000, -90],
    city: [-122.42, 37.77, 120000, -90],
    orbit: [-110, 35, 3000000, -90],
    terrain: [-122.42, 37.05, 80000, -45],
  })) {
    await page.evaluate(async (p) => {
      const a = window.__godsEyeView,
        g = await import('/src/geo/index.js');
      a.engine.camera.setView({
        destination: g.cartesian3.fromDegrees(p[0], p[1], p[2]),
        orientation: { heading: 0, pitch: g.math.toRadians(p[3]), roll: 0 },
      });
      let since = null;
      const start = performance.now();
      while (performance.now() - start < 90000) {
        if (a.engine.surface.tilesLoaded()) since ??= performance.now();
        else since = null;
        if (since !== null && performance.now() - since > 2000) return;
        a.engine.render.request('sector-settle');
        await new Promise((r) => setTimeout(r, 100));
      }
      throw new Error('Surface did not settle');
    }, pose);
    await new Promise((r) => setTimeout(r, 2500));
    const buffers = [];
    for (const fast of [1, 0, 1]) {
      await page.evaluate(async (fast) => {
        window.__w2SectorEffect.uniforms.get('uQaFast').value = fast;
        let frames = 0;
        const e = window.__godsEyeView.engine;
        const remove = e.frames.postRender.addEventListener(() => frames++);
        try {
          const start = performance.now();
          while (frames < 2 && performance.now() - start < 5000) {
            e.render.request('sector-switch');
            await new Promise((resolve) => setTimeout(resolve, 20));
          }
          if (frames < 2)
            throw new Error('Requested variant frames were not drawn');
        } finally {
          remove();
        }
      }, fast);
      const file = out.replace(/\.json$/, `-${name}-${buffers.length}.png`);
      const png = await page.screenshot({ path: file });
      buffers.push(await sharp(png).removeAlpha().raw().toBuffer());
    }
    let repeated = 0,
      different = 0,
      maxDelta = 0;
    for (let i = 0; i < buffers[0].length; i++) {
      if (buffers[0][i] !== buffers[2][i]) repeated++;
      const delta = Math.abs(buffers[0][i] - buffers[1][i]);
      if (delta) different++;
      maxDelta = Math.max(maxDelta, delta);
    }
    report.poses[name] = {
      repeatDifferentChannels: repeated,
      differentChannels: different,
      maxDelta,
    };
    check(
      `${name}: stable repeat and full 48-edge GPU equivalence`,
      repeated === 0 && different === 0,
      report.poses[name],
    );
  }
  await page.evaluate(async () => {
    const a = window.__godsEyeView,
      g = await import('/src/geo/index.js');
    a.engine.camera.setView({
      destination: g.cartesian3.fromDegrees(-122.42, 37.77, 15000000),
      orientation: { heading: 0, pitch: -Math.PI / 2, roll: 0 },
    });
    let since = null;
    const start = performance.now();
    while (performance.now() - start < 90000) {
      if (a.engine.surface.tilesLoaded()) since ??= performance.now();
      else since = null;
      if (since !== null && performance.now() - since > 2000) return;
      a.engine.render.request('horizon-settle');
      await new Promise((r) => setTimeout(r, 100));
    }
    throw new Error('Horizon surface did not settle');
  });
  await new Promise((r) => setTimeout(r, 2500));
  const before = await page.screenshot({
    path: out.replace(/\.json$/, '-horizon-before.png'),
  });
  const horizon = await page.evaluate(async (epoch) => {
    globalThis.__w2Antipode = {
      type: 'Feature',
      id: 'qa-antipode',
      geometry: { type: 'Point', coordinates: [57.58, -37.77, 8] },
      properties: {
        mag: 10,
        place: 'GPU horizon adversarial event',
        time: epoch,
      },
    };
    const a = window.__godsEyeView,
      g = await import('/src/geo/index.js');
    await a.dataManager.layers.get('earthquakes').module.update();
    return {
      count: a.dataManager.layers.get('earthquakes').module.getStats().count,
      retained: a.dataManager.layers
        .get('earthquakes')
        .module.getAnalystRecords()
        .some((r) => r.id === 'qa-antipode'),
      visible: a.engine.projector.horizonVisible(
        g.cartesian3.fromDegrees(57.58, -37.77),
      ),
    };
  }, W2_EPOCH_MS);
  await new Promise((r) => setTimeout(r, 1500));
  const after = await page.screenshot({
    path: out.replace(/\.json$/, '-horizon-after.png'),
  });
  const [beforePixels, afterPixels] = await Promise.all(
    [before, after].map((png) => sharp(png).removeAlpha().raw().toBuffer()),
  );
  let changed = 0;
  for (let i = 0; i < beforePixels.length; i++)
    if (beforePixels[i] !== afterPixels[i]) changed++;
  report.horizon = { ...horizon, differentChannels: changed };
  check(
    'antipodal M10 is present in source and truly behind the horizon',
    horizon.count === 16 && horizon.retained && horizon.visible === false,
    horizon,
  );
  check(
    'antipodal ground disc cannot paint the visible hemisphere',
    changed === 0,
    report.horizon,
  );
} catch (error) {
  check('scenario completes', false, error.message);
} finally {
  await browser.close();
}
check(
  'strict runtime observers',
  report.browserErrors.length === 0,
  report.browserErrors,
);
report.pass = report.checks.length === 7 && report.checks.every((c) => c.pass);
await fs.writeFile(out, JSON.stringify(report, null, 2) + '\n');
process.exitCode = report.pass ? 0 : 1;
