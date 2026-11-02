import assert from 'node:assert/strict';
import puppeteer from 'puppeteer';
import { blockPaidQaMaps } from './qa-map-policy.mjs';
import { installTileCache } from './qa/tileCache.mjs';

const base = new URL(process.argv[2]);
if (
  !['localhost', '127.0.0.1'].includes(base.hostname) ||
  ['', '4173', '4185', '4186', '4187', '4188', '4189', '4194'].includes(
    base.port,
  )
) {
  throw new Error('Supply an unreserved local preview URL');
}
base.search = '?welcome=0&look=cinematic';
base.hash =
  'v=2&lat=42.3554&lon=-71.0605&alt=6000&heading=0&pitch=-90&map=osm&l=e';
const browser = await puppeteer.launch({
  headless: true,
  args: ['--use-angle=metal', '--enable-gpu'],
});
try {
  const page = await browser.newPage();
  await blockPaidQaMaps(page);
  await installTileCache(page);
  await page.evaluateOnNewDocument(() => {
    localStorage.setItem('gev:first-run-mission:v1', 'suppressed');
    const fetch = window.fetch.bind(window);
    window.fetch = (url, options) =>
      String(url).startsWith('https://earthquake.usgs.gov/earthquakes/feed/')
        ? Promise.resolve(
            Response.json({ type: 'FeatureCollection', features: [] }),
          )
        : fetch(url, options);
  });
  await page.setViewport({ width: 1280, height: 800 });
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  async function ready(kind) {
    await page.waitForFunction(
      (kind) =>
        window.__godsEyeView?.engine?.kind === kind &&
        document.querySelector('#globe-engine')?.value === kind &&
        !document.querySelector('#globe-engine').disabled &&
        document.getElementById('loading-screen')?.classList.contains('hidden'),
      { timeout: 90000 },
      kind,
    );
    await page.evaluate(async () => {
      await window.__godsEyeView.styleManager.initialRestorePromise;
      if (window.__GOOGLE_MAPS_API_KEY__ || window.__godsEyeView.tileset)
        throw new Error('Keyless preview required');
    });
    assert.equal(await page.$eval('#globe-engine', (el) => el.value), kind);
  }
  const stored = () => page.evaluate(() => localStorage.getItem('gev.engine'));
  async function switchTo(kind) {
    if (
      await page.$eval(
        '#control-panel-toggle',
        (el) => el.getAttribute('aria-expanded') !== 'true',
      )
    ) {
      await page.focus('#control-panel-toggle');
      await page.keyboard.press('Enter');
    }
    await page.waitForSelector('#globe-engine', { visible: true });
    await page.evaluate(() => {
      window.__switchDocument = document;
      window.__renderers ??= new Map();
      window.__renderers.set(
        window.__godsEyeView.engine.kind,
        window.__godsEyeView.engine,
      );
      window.__switchSplash = false;
      window.__switchObserver = new MutationObserver(() => {
        if (!document.querySelector('#loading-screen.hidden'))
          window.__switchSplash = true;
      });
      window.__switchObserver.observe(
        document.querySelector('#loading-screen'),
        { attributes: true },
      );
      window.__outgoingEngine = window.__godsEyeView.engine;
    });
    await page.select('#globe-engine', kind);
    await ready(kind);
    assert.ok(await page.evaluate(() => window.__switchDocument === document));
    assert.ok(
      await page.evaluate(() => {
        window.__switchObserver.disconnect();
        const { engine } = window.__godsEyeView;
        const previous = window.__renderers.get(engine.kind);
        return (
          !window.__switchSplash &&
          (!previous || previous === engine) &&
          !window.__outgoingEngine.isDestroyed() &&
          !window.__outgoingEngine.host.canvas.isConnected &&
          engine.host.canvas.isConnected &&
          window.__godsEyeView.dataManager
            .getEnabledLayerIds()
            .has('earthquakes')
        );
      }),
    );
    await page.waitForFunction(
      () => !document.querySelector('.engine-switch-frame'),
    );
    assert.equal(
      await page.evaluate(async () => {
        const parked = window.__outgoingEngine;
        let frames = 0;
        const remove = parked.frames.postRender.addEventListener(() => {
          frames++;
        });
        parked.render.request('qa-parked');
        await new Promise((resolve) =>
          requestAnimationFrame(() => requestAnimationFrame(resolve)),
        );
        remove();
        return frames;
      }),
      0,
    );
    const url = new URL(page.url());
    assert.equal(url.searchParams.get('engine'), kind);
    assert.equal(url.searchParams.get('look'), 'cinematic');
    const hash = new URLSearchParams(url.hash.slice(1));
    assert.equal(hash.get('map'), 'osm');
    assert.ok(Math.abs(Number(hash.get('lat')) - 42.3554) < 0.01);
    assert.ok(Math.abs(Number(hash.get('lon')) + 71.0605) < 0.01);
    assert.ok(Math.abs(Number(hash.get('alt')) - 6000) < 30);
    const view = await page.evaluate(() => {
      const { engine, mapStackController } = window.__godsEyeView;
      const { latitude, longitude, height } = engine.camera.pose().cartographic;
      return {
        latitude: latitude * (180 / Math.PI),
        longitude: longitude * (180 / Math.PI),
        height,
        map: mapStackController.getActiveId(),
      };
    });
    assert.equal(view.map, 'osm');
    assert.ok(Math.abs(view.latitude - 42.3554) < 0.01);
    assert.ok(Math.abs(view.longitude + 71.0605) < 0.01);
    assert.ok(Math.abs(view.height - 6000) < 30);
  }
  await page.goto(base.href, { waitUntil: 'domcontentloaded' });
  await ready('cesium');
  const sharpen = () =>
    page.evaluate(
      () => window.__godsEyeView.styleManager.getControlState().sharpen,
    );
  await page.evaluate(() => {
    const style = window.__godsEyeView.styleManager;
    style.setStyle('retro');
    style.setStyle('normal');
  });
  assert.deepEqual(await sharpen(), { enabled: true, intensityPct: 49 });
  await switchTo('navara');
  assert.deepEqual(await sharpen(), { enabled: true, intensityPct: 80 });
  assert.ok(
    await page.evaluate(
      () =>
        Math.abs(window.__godsEyeView.engine.render.sharpen().amount - 1.7) <
        1e-6,
    ),
  );
  assert.equal(await stored(), 'navara');
  await page.goBack({ waitUntil: 'domcontentloaded' });
  await ready('cesium');
  assert.equal((await sharpen()).intensityPct, 49);
  await page.goForward();
  await ready('navara');
  assert.equal((await sharpen()).intensityPct, 80);
  await page.evaluate(() =>
    window.__godsEyeView.styleManager.setSharpen({
      enabled: false,
      intensityPct: 49,
    }),
  );
  await switchTo('cesium');
  await switchTo('navara');
  assert.deepEqual(await sharpen(), { enabled: false, intensityPct: 49 });
  await page.goto(base.href, { waitUntil: 'domcontentloaded' });
  await ready('navara');
  await switchTo('cesium');
  assert.equal(await stored(), 'cesium');
  await page.evaluate(() => {
    const write = Storage.prototype.setItem;
    Storage.prototype.setItem = function (key, value) {
      if (key === 'gev.engine')
        throw new DOMException('Blocked', 'SecurityError');
      return write.call(this, key, value);
    };
  });
  await switchTo('navara');
  assert.equal(await stored(), 'cesium');
  // The real Map Source chips move into daylight inspection and back to live lighting.
  await page.$eval('[data-stack-id="sentinel2"]', (el) => el.click());
  await page.waitForFunction(
    () =>
      window.__godsEyeView.mapStackController.getActiveId() === 'sentinel2' &&
      window.__godsEyeView.engine.host.container.hasAttribute(
        'data-terrain-daylight',
      ),
  );
  await page.$eval('[data-stack-id="osm"]', (el) => el.click());
  await page.waitForFunction(
    () =>
      window.__godsEyeView.mapStackController.getActiveId() === 'osm' &&
      !window.__godsEyeView.engine.host.container.hasAttribute(
        'data-terrain-daylight',
      ),
  );
  assert.deepEqual(errors, []);
  console.log(
    'PASS Cesium default, both switches, same document, warm engine identity, parked canvas, no startup splash, share pose/map/layers, Back/Forward, remembered engine, blocked preference storage',
  );
} finally {
  await browser.close();
}
