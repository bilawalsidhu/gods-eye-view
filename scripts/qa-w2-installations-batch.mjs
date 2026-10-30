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
    `${base}/?engine=navara&look=minimal&welcome=0#lat=42.3554&lon=-71.0605&alt=6000&heading=0&pitch=-90&map=osm`,
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
  const batches = await page.evaluate(() =>
    [...window.__batchOwner.meshes]
      .filter((m) => m.userData.installationOutline)
      .map((m) => m.userData.installationIds),
  );
  check(
    'twenty contours retain all identities in fewer stencil batches',
    batches.flat().length === 20 && batches.length < 20,
    batches,
  );
  const combined = await shot('batched');
  await page.evaluate(() => {
    const owner = window.__batchOwner;
    window.__unbatched = [];
    for (const mesh of owner.meshes) {
      if (!mesh.userData.installationOutline) continue;
      const ids = mesh.userData.installationIds,
        total =
          mesh.geometry.index?.count ?? mesh.geometry.attributes.position.count;
      if (total % ids.length)
        throw new Error('Fixture contours must have identical topology');
      mesh.visible = false;
      for (let i = 0; i < ids.length; i++) {
        const geometry = mesh.geometry.clone();
        geometry.setDrawRange((i * total) / ids.length, total / ids.length);
        const single = new mesh.constructor(geometry, mesh.material);
        single.matrix.copy(mesh.matrix);
        single.matrixAutoUpdate = false;
        owner.scene.add(single);
        window.__unbatched.push(single);
      }
    }
  });
  const separate = await shot('separate');
  await page.evaluate(() => {
    window.__unbatched[0].visible = false;
  });
  const missing = await shot('missing-contour');
  await page.evaluate(() => {
    window.__unbatched[0].visible = true;
  });
  const differences = (a, b) => {
    let pixels = 0,
      max = 0;
    for (let y = 190; y < 650; y++)
      for (let x = 400; x < 900; x++) {
        const i = (y * 1280 + x) * 4;
        const d = Math.max(
          ...[0, 1, 2].map((c) => Math.abs(a[i + c] - b[i + c])),
        );
        if (d) pixels++;
        max = Math.max(max, d);
      }
    return { pixels, max };
  };
  const delta = differences(combined, separate);
  report.exactPixelDifference = delta;
  await page.evaluate(() => {
    for (const mesh of window.__unbatched) {
      mesh.removeFromParent();
      mesh.geometry.dispose();
    }
    window.__unbatched = [];
    for (const mesh of window.__batchOwner.meshes) mesh.visible = true;
  });
  const restored = await shot('restored'),
    restoreDelta = differences(combined, restored);
  check(
    'restoring the batch preserves pixels',
    restoreDelta.pixels === 0,
    restoreDelta,
  );
  await page.evaluate(() => {
    for (const mesh of window.__batchOwner.meshes)
      if (mesh.userData.installationOutline) mesh.visible = false;
  });
  const hidden = await shot('hidden'),
    positive = differences(restored, hidden);
  check(
    'the compared contours have real visible pixels',
    positive.pixels > 100,
    positive,
  );
  // Keep the exact RGB difference above: batching is not bit-identical.
  // Require identical painted coverage and bound the translucent colour error.
  const coverage = (candidate) => {
    let error = 0,
      signal = 0,
      coverageChanges = 0;
    for (let y = 190; y < 650; y++)
      for (let x = 400; x < 900; x++) {
        const i = (y * 1280 + x) * 4;
        for (const c of [0, 1, 2]) {
          error += Math.abs(candidate[i + c] - separate[i + c]);
          signal += Math.abs(separate[i + c] - hidden[i + c]);
        }
        const painted = (image) =>
          [0, 1, 2].some((c) => Math.abs(image[i + c] - hidden[i + c]) > 5);
        if (painted(candidate) !== painted(separate)) coverageChanges++;
      }
    return {
      coverageChanges,
      relativeColourError: signal ? error / signal : Infinity,
    };
  };
  const acceptable = (m) =>
    m.coverageChanges === 0 && m.relativeColourError < 0.01;
  const edgeDelta = coverage(combined),
    missingDelta = coverage(missing);
  check(
    'batch preserves every painted contour pixel with less than one percent colour error',
    acceptable(edgeDelta),
    edgeDelta,
  );
  check(
    'the same pixel gate rejects a missing contour',
    !acceptable(missingDelta),
    missingDelta,
  );
  await page.evaluate(() => {
    for (const mesh of window.__batchOwner.meshes) mesh.visible = true;
  });
  // Observe the real public passes, not a second implementation of SDK ordering.
  await page.evaluate(async () => {
    const a = window.__godsEyeView;
    await a.dataManager.setEnabled('earthquakes', true);
    await a.dataManager.setEnabled('local-firms', true);
    await a.dataManager.setEnabled('recent-imagery', true);
    window.__gevRecentImagery.layer.setBox({
      west: -71.08,
      east: -71.04,
      south: 42.34,
      north: 42.37,
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
    const layer = window.__gevRecentImagery.layer;
    const candidates = layer
      .getSnapshot()
      .candidates.filter((c) => c.product === 'S30');
    layer.setAssignment('a', candidates[0].key);
    layer.setAssignment('b', candidates[1].key);
    layer.setMode('ab');
  });
  await page.waitForFunction(
    () =>
      window.__batchContext.getPass('gevEarthquakeGround') &&
      window.__batchContext.getPass('gevRecentImagery') &&
      window.__batchContext.getPass('gevPreSharpenOverlay'),
    { timeout: 60000 },
  );
  const order = await page.evaluate(async () => {
    const keys = [
        'gevRecentImagery',
        'gevEarthquakeGround',
        'gevPreSharpenOverlay',
      ],
      seen = [],
      originals = [];
    for (const key of keys) {
      const pass = window.__batchContext.getPass(key),
        render = pass.render;
      originals.push(() => {
        pass.render = render;
      });
      pass.render = function (...args) {
        seen.push(key);
        return render.apply(this, args);
      };
    }
    try {
      await new Promise((resolve) => {
        const off =
          window.__godsEyeView.engine.frames.postRender.addEventListener(() => {
            off();
            resolve();
          });
        window.__godsEyeView.engine.render.request('qa-ground-order');
      });
      return seen;
    } finally {
      for (const restore of originals) restore();
    }
  });
  check(
    'imagery activated last remains below ground classification and glyphs',
    order.indexOf('gevRecentImagery') >= 0 &&
      order.indexOf('gevRecentImagery') < order.indexOf('gevEarthquakeGround'),
    order,
  );
  check(
    'ground colour renders before FIRMS glyphs',
    order.indexOf('gevEarthquakeGround') >= 0 &&
      order.indexOf('gevEarthquakeGround') <
        order.indexOf('gevPreSharpenOverlay'),
    order,
  );
  await fixture.dispose();
} catch (error) {
  report.failure = error.stack;
} finally {
  await browser.close();
  report.pass =
    !report.failure &&
    !report.browserErrors.length &&
    report.checks.length >= 5 &&
    report.checks.every((c) => c.pass);
  await fs.writeFile(out, JSON.stringify(report, null, 2));
  if (!report.pass) process.exitCode = 1;
}
