import assert from 'node:assert/strict';
import { stations, installRadioFixture } from './fixtures/layers/radio.mjs';
import { createStrict, localPreview, openPage, waitForEngine } from './qa-strict-harness.mjs';
const url = localPreview(process.argv[2]);
// The long soak and switch timings live in qa-strict-soak.mjs.
url.search = '?engine=navara&welcome=0';
url.hash = 'v=2&lat=30.27&lon=-97.74&alt=12000&pitch=-90&map=sentinel2&l=';
const strict = createStrict({ origin: url.origin, layers: ['radio'] });
await strict.run({}, async (browser) => {
  const { page: page, errors } = await openPage(browser);
  await page.setViewport({ width: 800, height: 600 });
  await installRadioFixture(page);
  await page.goto(url.href);
  await waitForEngine(page, 'navara');
  await page.evaluate(async (id) => {
    const { dataManager, styleManager } = window.__godsEyeView;
    await styleManager.initialRestorePromise;

    window.qaLayer = dataManager.layers.get('radio').module;
    await dataManager.setEnabled('radio', true, { origin: 'user' });
  }, stations[0].id);
  await page.waitForFunction(() => window.qaLayer?.getStats().count === 750);
  await page.evaluate((id) => {
    window.qaLayer.selectStation(id, {
      autoplay: true,
      focus: false,
      origin: 'user',
    });
    window.qaLayer.setRadioVolume(0.36);
  }, stations[10].id);
  await page.waitForFunction(
    () =>
      window.__qaRadio.plays.length === 1 &&
      window.qaLayer.getUIState().audioState === 'playing',
  );
  const first = await page.evaluate(() => {
    window.qaAudio = window.qaPlayer;
    window.qaSnapshot = window.qaLayer.getAcceptedCatalogSnapshot();
    return window.__qaRadio.reads;
  });
  for (const kind of ['cesium', 'navara']) {
    await strict.switchTo(page, kind);
    const state = await page.evaluate(() => ({
      same:
        window.qaLayer ===
        window.__godsEyeView.dataManager.layers.get('radio').module,
      player: window.qaAudio === window.qaPlayer,
      snapshot:
        window.qaSnapshot === window.qaLayer.getAcceptedCatalogSnapshot(),
      plays: window.__qaRadio.plays.length,
      reads: window.__qaRadio.reads,
      state: window.qaLayer.getUIState(),
      count: window.qaLayer.getStats().count,
    }));
    console.log(
      kind,
      state.count,
      state.state.selected?.id,
      state.state.audioState,
      state.plays,
      state.reads,
    );
    assert.ok(state.same && state.player && state.snapshot);
    assert.equal(state.plays, 1);
    assert.equal(state.reads, first);
    assert.equal(state.count, 750);
    assert.equal(state.state.audioState, 'playing');
    assert.equal(state.state.selected.id, stations[10].id);
    assert.equal(state.state.volume, 0.36);
    // The fixture's HTMLMediaElement.prototype.play counts play() calls: the
    // switch must not start the stream again.
    await strict.passed(
      page,
      'radio',
      'same model, player element and catalog snapshot; 750 stations, one catalog read, no second play(), same station playing at volume 0.36',
    );
  }
  assert.deepEqual(errors, []);
  console.log(
    'PASS one live radio player, one station directory and the same selection',
  );
});
