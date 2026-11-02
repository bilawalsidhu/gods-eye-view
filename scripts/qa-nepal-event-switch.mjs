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
  'v=2&lat=28.2110&lon=85.3380&alt=9000&heading=0&pitch=-90&roll=0&map=sentinel2&l=';
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
  const assets = [];
  p.on('request', (req) => {
    const path = new URL(req.url()).pathname;
    if (
      /\/events\/bhote-koshi-2026\/(event\.json|pre\.webp|post\.webp)$/.test(
        path,
      )
    )
      assets.push(path);
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
    const { tileset, dataManager, sceneDirector } = window.__godsEyeView;
    if (!sceneDirector?.listScenes().length) throw Error('No scenes available on Navara');
    if (tileset || window.__GOOGLE_MAPS_API_KEY__)
      throw Error('Keyless preview required');
    const mod = dataManager.layers.get('bhote-koshi-2026').module;
    window.qaEvent = mod;
    await dataManager.setEnabled(mod.id, true, { origin: 'user' });
    mod.setParams({
      presentation: 'standalone',
      progress: 0.52,
      split: 0.27,
      autoPlay: false,
    });
  });
  const sample = async () => {
    await new Promise((r) => setTimeout(r, 500));
    return sharp(await p.screenshot())
      .extract({ left: 490, top: 370, width: 25, height: 25 })
      .removeAlpha()
      .raw()
      .toBuffer();
  };
  for (const kind of ['navara', 'cesium', 'navara']) {
    if ((await p.evaluate(() => window.__godsEyeView.engine.kind)) !== kind) {
      await p.select('#globe-engine', kind);
      await ready(kind);
    }
    const state = await p.evaluate(() => {
      const { dataManager } = window.__godsEyeView;
      return {
        same:
          window.qaEvent === dataManager.layers.get('bhote-koshi-2026').module,
        state: window.qaEvent.getPlaybackState(),
        player:
          document.querySelector('#bhote-koshi-embedded-media-root') ===
          window.qaPlayer,
      };
    });
    assert.equal(state.same, true);
    assert.equal(state.state.enabled, true);
    assert.equal(state.state.split, 0.27);
    assert.equal(state.state.playing, false);
    assert.equal(state.state.progress, 0.52);
    await p.evaluate(() => {
      window.qaPlayer ??= document.querySelector(
        '#bhote-koshi-embedded-media-root',
      );
      window.qaEvent.setParams({ split: 0.75 });
    });
    assert.ok(await p.evaluate(()=>Boolean(window.qaPlayer)), 'persistent embedded media root');
    const before = await sample();
    await p.evaluate(() => window.qaEvent.setParams({ split: 0.27 }));
    const after = await sample();
    const diff =
      before.reduce((n, v, i) => n + Math.abs(v - after[i]), 0) / before.length;
    console.log(kind, state.state, 'imagery difference', diff);
    assert.ok(diff > 6, 'divider changes the actual imagery in the viewport');
    assert.equal(
      await p.evaluate(
        () =>
          document.querySelector('#bhote-koshi-embedded-media-root') ===
          window.qaPlayer,
      ),
      true,
    );
  }
  for (const suffix of ['/event.json', '/pre.webp', '/post.webp'])
    assert.equal(
      assets.filter((a) => a.endsWith(suffix)).length,
      1,
      JSON.stringify(assets),
    );
  await p.evaluate(() => window.qaEvent.setParams({ autoPlay: true }));
  await p.waitForFunction(
    () => window.qaEvent.getPlaybackState().progress > 0.53,
  );
  await p.select('#globe-engine', 'cesium');
  await ready('cesium');
  const live = await p.evaluate(() => window.qaEvent.getPlaybackState());
  assert.ok(live.playing && live.progress > 0.53);
  await p.evaluate(() =>
    window.__godsEyeView.dataManager.setEnabled('bhote-koshi-2026', false, {
      origin: 'user',
    }),
  );
  assert.deepEqual(errors, []);
  console.log(
    'PASS event timeline, paused and playing handoff, image pair, divider, player host and single asset acquisition',
  );
} finally {
  await b.close();
}
