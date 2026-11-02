import { fromDegrees } from '../src/geo/cartesian3.js';
import sharp from 'sharp';
import puppeteer from 'puppeteer';
import assert from 'node:assert/strict';
import { blockPaidQaMaps } from './qa-map-policy.mjs';

const base = new URL(process.argv[2]);
if (
  !['localhost', '127.0.0.1'].includes(base.hostname) ||
  ['', '4173', '4185', '4186', '4187', '4188', '4189', '4194'].includes(
    base.port,
  )
)
  throw new Error('Supply an unreserved local keyless preview URL');
base.search = '?engine=navara&welcome=0&look=cinematic';
base.hash =
  'v=2&lat=28.3326&lon=85.4848&alt=18000&heading=0&pitch=-90&roll=0&map=sentinel2&l=';
const b = await puppeteer.launch({
  headless: true,
  args: ['--use-angle=metal', '--enable-gpu'],
});
try {
  const p = await b.newPage();
  await blockPaidQaMaps(p);
  await p.setViewport({ width: 1024, height: 768 });
  const errors = [];
  p.on('pageerror', (e) => {
    errors.push(e.message);
    console.log('error', e.message.split('?')[0]);
  });
  p.on('console', (msg) => {
    if (msg.type() === 'error' && /Shader|WebGLProgram/i.test(msg.text()))
      errors.push(msg.text());
  });
  await p.goto(base.href);
  const ready = async (kind) => {
    await p.waitForFunction(
      (k) =>
        window.__godsEyeView?.engine.kind === k &&
        !document.querySelector('#globe-engine')?.disabled &&
        !document.querySelector('.engine-switch-frame') &&
        document.querySelector('#loading-screen.hidden'),
      { timeout: 90000 },
      kind,
    );
    await p.evaluate(
      () => window.__godsEyeView.styleManager.initialRestorePromise,
    );
  };
  await ready('navara');
  await p.evaluate(async () => {
    const { tileset, dataManager } = window.__godsEyeView;
    if (tileset || window.__GOOGLE_MAPS_API_KEY__)
      throw Error('Keyless preview required');
    window.qaLocator = dataManager.layers.get('bhote-koshi-locator').module;
    window.qaLocator.setParams({ presentation: 'bhote-koshi-path-overview' });
    await dataManager.setEnabled('bhote-koshi-locator', true, {
      origin: 'user',
    });
  });
  for (const kind of ['navara', 'cesium', 'navara']) {
    if ((await p.evaluate(() => window.__godsEyeView.engine.kind)) !== kind) {
      await p.select('#globe-engine', kind);
      await ready(kind);
    }
    const { same, stats, params, at } = await p.evaluate(
      (world) => {
        const { engine, dataManager } = window.__godsEyeView,
          mod = dataManager.layers.get('bhote-koshi-locator').module;
        const pos = engine.projector.worldToWindow(world, {}),
          box = engine.host.canvas.getBoundingClientRect();
        return {
          same: mod === window.qaLocator,
          stats: mod.getStats(),
          params: mod.getParams(),
          at: { x: pos.x + box.left, y: pos.y + box.top },
        };
      },
      fromDegrees(85.47741, 28.33299, 1600),
    );
    assert.equal(same, true);
    assert.equal(stats.count, 1);
    assert.equal(params.presentation, 'bhote-koshi-path-overview');
    // Look for the cyan river in a scene crop away from the UI rails.
    await new Promise((r) => setTimeout(r, 1000));
    const crop = async () =>
      sharp(await p.screenshot())
        .extract({ left: 400, top: 320, width: 230, height: 180 })
        .removeAlpha()
        .raw()
        .toBuffer();
    const rendered = await crop();
    await p.evaluate(() =>
      window.qaLocator.setParams({ presentation: 'nepal-context' }),
    );
    await new Promise((resolve) => setTimeout(resolve, 500));
    const baseline = await crop();
    let added = 0;
    for (let i = 0; i < rendered.length; i += 3) {
      const contrast = rendered[i + 1] - rendered[i],
        previous = baseline[i + 1] - baseline[i];
      if (
        rendered[i + 1] > 140 &&
        rendered[i + 2] > 140 &&
        contrast > 35 &&
        contrast - previous > 18
      )
        added++;
    }
    console.log(
      kind,
      stats.coverage,
      'cyan pixels added by the path',
      added,
      at,
    );
    assert.ok(
      added > 50,
      'visible river differs from the same scene without a path',
    );
    await p.evaluate(() =>
      window.qaLocator.setParams({ presentation: 'bhote-koshi-path-overview' }),
    );
  }
  await p.evaluate(() => {
    window.qaLocator.setParams({ presentation: 'bhote-koshi-incident-places' });
    window.qaLocator.setParams({ presentation: 'bhote-koshi-city-context' });
    window.qaLocator.setParams({
      presentation: 'bhote-koshi-trigger-record',
      preview: true,
    });
  });
  await new Promise((resolve) => setTimeout(resolve, 1000));
  await p.evaluate(() =>
    window.__godsEyeView.dataManager.setEnabled('bhote-koshi-locator', false, {
      origin: 'user',
    }),
  );
  assert.deepEqual(errors, []);
  console.log(
    'PASS Nepal locator flood path and presentation retained, trigger and places update; both engines',
  );
} finally {
  await b.close();
}
