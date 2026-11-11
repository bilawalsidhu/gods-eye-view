import { whenFramesDrawn, whenTilesLoaded } from './qa/ready.mjs';
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
  'v=2&lat=28.2110&lon=85.3380&alt=9000&heading=0&pitch=-90&roll=0&map=sentinel2&l=';
// The media panel embeds YouTube players with their thumbnails: a plain
// thumbnail and an inert player page stand in for them.
const thumbnail = await sharp({
  create: { width: 480, height: 360, channels: 3, background: '#40506a' },
})
  .jpeg()
  .toBuffer();
const strict = createStrict({
  origin: base.origin,
  layers: ['bhote-koshi-2026'],
  routes: [
    {
      pattern: 'https://i.ytimg.com/*',
      respond: () => ({ contentType: 'image/jpeg', body: thumbnail }),
    },
    {
      // The player API script: an inert stub (the app keeps its own controls).
      pattern: 'https://www.youtube.com/iframe_api*',
      respond: () => ({
        contentType: 'text/javascript',
        body: '/* QA: YouTube iframe API withheld */',
      }),
    },
    {
      pattern: 'https://www.youtube-nocookie.com/*',
      respond: () => ({
        contentType: 'text/html',
        body: '<!doctype html><title>QA player</title><body style="background:#111"></body>',
      }),
    },
    // A Facebook post the playback reaches in a slower run: its SDK and
    // post page, inert as well.
    {
      pattern: 'https://connect.facebook.net/*',
      respond: () => ({
        contentType: 'text/javascript',
        body: '/* QA: Facebook SDK withheld */',
      }),
    },
    {
      pattern: 'https://www.facebook.com/*',
      respond: () => ({
        contentType: 'text/html',
        body: '<!doctype html><title>QA post</title><body style="background:#111"></body>',
      }),
    },
  ],
});
await strict.run({}, async (b) => {
  const { page: p, errors } = await openPage(b, { shaderErrors: true });
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
  await waitForEngine(p, 'navara');
  await p.evaluate(async () => {
    const { tileset, dataManager, sceneDirector } = window.__godsEyeView;
    if (!sceneDirector?.listScenes().length)
      throw Error('No scenes available on Navara');

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
    await whenFramesDrawn(p);
    await whenTilesLoaded(p);
    await whenFramesDrawn(p);
    return sharp(await p.screenshot())
      .extract({ left: 490, top: 370, width: 25, height: 25 })
      .removeAlpha()
      .raw()
      .toBuffer();
  };
  for (const kind of ['navara', 'cesium', 'navara']) {
    if ((await p.evaluate(() => window.__godsEyeView.engine.kind)) !== kind) {
      await strict.switchTo(p, kind);
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
    assert.ok(
      await p.evaluate(() => Boolean(window.qaPlayer)),
      'persistent embedded media root',
    );
    const before = await sample();
    await p.evaluate(() => window.qaEvent.setParams({ split: 0.27 }));
    const after = await sample();
    const diff =
      before.reduce((n, v, i) => n + Math.abs(v - after[i]), 0) / before.length;
    console.log(kind, state.state, 'imagery difference', diff);
    assert.ok(diff > 6, 'divider changes the actual imagery in the viewport');
    await strict.passed(
      p,
      'bhote-koshi-2026',
      'same model and media root; paused at 0.52 with split 0.27; the divider changes the imagery',
      { diff },
    );
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
  await strict.passed(
    p,
    'bhote-koshi-2026',
    'event file and image pair read once over three engine visits',
  );
  await p.evaluate(() => window.qaEvent.setParams({ autoPlay: true }));
  await p.waitForFunction(
    () => window.qaEvent.getPlaybackState().progress > 0.53,
  );
  await strict.switchTo(p, 'cesium');
  const live = await p.evaluate(() => window.qaEvent.getPlaybackState());
  await strict.check(
    p,
    'bhote-koshi-2026',
    'playback keeps playing past 0.53 through the switch',
    live.playing && live.progress > 0.53,
    live,
  );
  await p.evaluate(() =>
    window.__godsEyeView.dataManager.setEnabled('bhote-koshi-2026', false, {
      origin: 'user',
    }),
  );
  assert.deepEqual(errors, []);
  console.log(
    'PASS event timeline, paused and playing handoff, image pair, divider, player host and single asset acquisition',
  );
});
