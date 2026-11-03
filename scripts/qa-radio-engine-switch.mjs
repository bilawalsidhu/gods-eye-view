import puppeteer from 'puppeteer';
import assert from 'node:assert/strict';
import { stations, installRadioFixture } from './fixtures/w2/radio.mjs';
import { blockPaidQaMaps } from './qa-map-policy.mjs';
import { switchGlobe } from './qa-switch-globe.mjs';
const url = new URL(process.argv[2]);
if (
  !['localhost', '127.0.0.1'].includes(url.hostname) ||
  ['', '4173', '4185', '4186', '4187', '4188', '4189', '4194'].includes(
    url.port,
  )
)
  throw Error('Local keyless preview required');
url.search = '?engine=navara&welcome=0';
url.hash = 'v=2&lat=30.27&lon=-97.74&alt=12000&pitch=-90&map=sentinel2&l=';
const browser = await puppeteer.launch({
  headless: true,
  args: ['--use-angle=metal', '--enable-gpu'],
});
try {
  const page = await browser.newPage();
  await blockPaidQaMaps(page);
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await installRadioFixture(page);
  await page.goto(url.href);
  await page.waitForFunction(
    () =>
      window.__godsEyeView?.engine?.kind === 'navara' &&
      document.querySelector('#loading-screen.hidden'),
  );
  await page.evaluate(async (id) => {
    const { dataManager, styleManager, tileset } = window.__godsEyeView;
    await styleManager.initialRestorePromise;
    if (window.__GOOGLE_MAPS_API_KEY__ || tileset)
      throw Error('Expected keyless preview');
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
    await switchGlobe(page, kind);
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
  }
  assert.deepEqual(errors, []);
  console.log(
    'PASS one live radio player, one station directory and the same selection',
  );
} finally {
  await browser.close();
}
