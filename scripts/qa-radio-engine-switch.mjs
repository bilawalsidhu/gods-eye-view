import puppeteer from 'puppeteer';
import assert from 'node:assert/strict';
import { stations, installRadioFixture } from './fixtures/w2/radio.mjs';
import { blockPaidQaMaps } from './qa-map-policy.mjs';
import { switchGlobe } from './qa-switch-globe.mjs';
const url = new URL(process.argv[2]);
const soak = process.argv.includes('--soak');
const requested = process.argv.find((arg) => arg.startsWith('--swaps='));
const swaps = requested ? Number(requested.slice(8)) : soak ? 50 : 2;
if (requested && (!soak || !Number.isInteger(swaps) || swaps % 2 || swaps < 4 || swaps > 1000))
  throw Error('Use --soak --swaps=N with an even count from 4 to 1000');

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
  if (soak) await page.evaluateOnNewDocument(() => {
    const fetch = window.fetch.bind(window);
    window.qaQuakeReads = 0;
    window.fetch = (input, init) => {
      const url = new URL(input?.url ?? input, location.href);
      if (url.hostname !== 'earthquake.usgs.gov') return fetch(input, init);
      window.qaQuakeReads++;
      return Promise.resolve(Response.json({
        type: 'FeatureCollection',
        features: [{ type: 'Feature', id: 'qa-austin', properties: { mag: 4.1, time: Date.now(), place: 'Austin' },
          geometry: { type: 'Point', coordinates: [-97.74, 30.27, 8] } }],
      }));
    };
  });
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
  const client = soak ? await page.createCDPSession() : null;
  if (soak) await page.evaluate(async () => {
    const { dataManager, engine } = window.__godsEyeView;
    await dataManager.setEnabled('earthquakes', true, { origin: 'user' });
    window.qaModels = new Map([...dataManager.layers].map(([id, entry]) => [id, entry.module]));
    window.qaEngines = new Map([[engine.kind, engine]]);
  });
  const measurements = [], memory = [];
  let contextListeners;
  for (let i = 1; i <= swaps; i++) {
    const kind = i % 2 ? 'cesium' : 'navara';
    const start = await page.evaluate(() => performance.now());
    await switchGlobe(page, kind);
    const elapsed = await page.evaluate((start) => performance.now() - start, start);
    measurements.push({ kind, ms: Math.round(elapsed) });
    if (soak) {
      assert.ok(await page.evaluate(() => {
        const { dataManager, engine } = window.__godsEyeView;
        const previous = window.qaEngines.get(engine.kind);
        window.qaEngines.set(engine.kind, engine);
        return (!previous || previous === engine) && window.qaEngines.size === 2 &&
          [...window.qaModels].every(([id, model]) => dataManager.layers.get(id)?.module === model) &&
          window.qaModels.size === 33 && window.qaQuakeReads >= 1 &&
          dataManager.getEnabledLayerIds().has('earthquakes');
      }));
      if ([2, 10, 50, 100, 250, swaps].includes(i)) {
        const { result } = await client.send('Runtime.evaluate', {
          includeCommandLineAPI: true,
          returnByValue: true,
          expression: `(() => {
            const events = getEventListeners(window.__godsEyeView.engine.host.canvas);
            return [events.webglcontextlost.length, events.webglcontextrestored.length];
          })()`,
        });
        assert.ok(
          Array.isArray(result.value) && result.value.length === 2 &&
            result.value.every((count) => Number.isInteger(count) && count > 0),
          'the active canvas must expose both WebGL event subscriptions',
        );
        contextListeners ??= result.value;
        assert.deepEqual(result.value, contextListeners, 'warm Navara must release old context listeners');
        await client.send('HeapProfiler.collectGarbage');
        const heap = await client.send('Runtime.getHeapUsage');
        const dom = await client.send('Memory.getDOMCounters');
        memory.push({ swap: i, contextListeners, jsMiB: Math.round(heap.usedSize / 1048576), ...dom });
      }
    }
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
  if (soak) {
    const warm = {};
    for (const kind of ['navara', 'cesium']) {
      const ms = measurements.slice(2).filter(x => x.kind === kind).map(x => x.ms).sort((a, b) => a - b);
      warm[kind] = { p50: ms[Math.ceil(ms.length * 0.50) - 1], p95: ms[Math.ceil(ms.length * 0.95) - 1] };
    }
    console.log('SOAK', JSON.stringify({ swaps, first: measurements.slice(0, 2), warm, memory }));
  }
  assert.deepEqual(errors, []);
  console.log(
    'PASS one live radio player, one station directory and the same selection',
  );
} finally {
  await browser.close();
}
