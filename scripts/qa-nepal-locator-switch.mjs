import { whenSettled } from './qa/ready.mjs';
import { fromDegrees } from '../src/geo/cartesian3.js';
import sharp from 'sharp';
import assert from 'node:assert/strict';
import {
  createStrict,
  localPreview,
  openPage,
  waitForEngine,
} from './qa-strict-harness.mjs';

const base = localPreview(process.argv[2]);
base.search = '?engine=navara&welcome=0&look=cinematic';
base.hash =
  'v=2&lat=28.3326&lon=85.4848&alt=18000&heading=0&pitch=-90&roll=0&map=sentinel2&l=';
const strict = createStrict({
  origin: base.origin,
  layers: ['bhote-koshi-locator'],
});
await strict.run({}, async (b) => {
  const { page: p, errors } = await openPage(b, { shaderErrors: true });
  await p.goto(base.href);
  await waitForEngine(p, 'navara');
  await p.evaluate(async () => {
    const { dataManager } = window.__godsEyeView;

    window.qaLocator = dataManager.layers.get('bhote-koshi-locator').module;
    window.qaLocator.setParams({ presentation: 'bhote-koshi-path-overview' });
    await dataManager.setEnabled('bhote-koshi-locator', true, {
      origin: 'user',
    });
  });
  for (const kind of ['navara', 'cesium', 'navara']) {
    if ((await p.evaluate(() => window.__godsEyeView.engine.kind)) !== kind) {
      await strict.switchTo(p, kind);
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
    await whenSettled(p);
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
    await whenSettled(p);
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
    await strict.check(
      p,
      'bhote-koshi-locator',
      'same model; the flood path adds more than 50 cyan pixels to the same scene without it',
      added > 50,
      { added },
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
  await whenSettled(p);
  // The last of three quick presentation changes is the one that stays.
  const last = await p.evaluate(() => ({
    params: window.qaLocator.getParams(),
    stats: window.qaLocator.getStats(),
  }));
  await strict.check(
    p,
    'bhote-koshi-locator',
    'the last of three quick presentation changes is the one applied',
    last.params.presentation === 'bhote-koshi-trigger-record' &&
      last.stats.count === 1 &&
      !last.stats.error,
    { presentation: last.params.presentation, count: last.stats.count },
  );
  await p.evaluate(() =>
    window.__godsEyeView.dataManager.setEnabled('bhote-koshi-locator', false, {
      origin: 'user',
    }),
  );
  assert.deepEqual(errors, []);
  console.log(
    'PASS Nepal locator flood path and presentation retained, trigger and places update; both engines',
  );
});
