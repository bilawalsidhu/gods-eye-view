import { waitForEngine } from './qa-strict-harness.mjs';
import { whenSettled } from './qa/ready.mjs';
import { assertKeylessPreview } from './qa-strict-harness.mjs';
import assert from 'node:assert/strict';
import sharp from 'sharp';
import { createStrict, localPreview } from './qa-strict-harness.mjs';

const base = localPreview(process.argv[2]);
base.search = '?welcome=0&look=cinematic';
base.hash =
  'v=2&lat=42.3554&lon=-71.0605&alt=6000&heading=0&pitch=-90&map=osm&l=e';
const strict = createStrict({ origin: base.origin, layers: ['earthquakes'] });
await strict.run({}, async (browser) => {
  const page = await browser.newPage();
  await page.evaluateOnNewDocument(() => {
    localStorage.setItem('gev:first-run-mission:v1', 'suppressed');
    const fetch = window.fetch.bind(window);
    // Two Boston vessels for the Contacts session; empty air and site feeds.
    const fixtures = {
      '/api/vessels': () => ({
        status: 'live',
        rows: ['123456789', '223456789'].map((mmsi, i) => ({
          mmsi,
          name: 'Boston ' + i,
          lat: 42.3554,
          lon: -71.0605 + i * 0.05,
          last_position_epoch: Date.now() / 1000,
        })),
      }),
      '/api/vessels/track': () => ({ samples: [] }),
      '/api/flights': () => ({ time: Date.now() / 1000, states: [] }),
      '/api/military': () => ({ now: Date.now(), ac: [] }),
      '/api/military-installations': () => ({ elements: [], status: 'ok' }),
    };
    window.fetch = (url, options) => {
      if (
        String(url).startsWith('https://earthquake.usgs.gov/earthquakes/feed/')
      )
        return Promise.resolve(
          Response.json({
            type: 'FeatureCollection',
            features: [
              {
                type: 'Feature',
                id: 'qa-boston',
                geometry: {
                  type: 'Point',
                  coordinates: [-71.0605, 42.3554, 8],
                },
                properties: { mag: 4, time: Date.now(), place: 'QA Boston' },
              },
            ],
          }),
        );
      const fixture =
        fixtures[new URL(url.url ?? url, document.baseURI).pathname];
      return fixture
        ? Promise.resolve(Response.json(fixture()))
        : fetch(url, options);
    };
  });
  await page.setViewport({ width: 1280, height: 800 });
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  async function ready(kind) {
    await waitForEngine(page, kind);
    await assertKeylessPreview(page);
    await page.evaluate(async () => {
      await window.__godsEyeView.styleManager.initialRestorePromise;
    });
    assert.equal(await page.$eval('#globe-engine', (el) => el.value), kind);
  }
  async function verifyQuakeSurface(kind) {
    const meanRed = async (enabled) => {
      await page.evaluate(async (enabled) => {
        const a = window.__godsEyeView;
        await a.dataManager.setEnabled('earthquakes', enabled, {
          origin: 'user',
        });
        a.engine.render.request('qa-quake-surface');
      }, enabled);
      if (enabled)
        await page.waitForFunction(
          () =>
            window.__godsEyeView.dataManager.layers
              .get('earthquakes')
              .module.getAnalystRecords().length === 1,
        );
      await whenSettled(page);
      const bytes = await page.screenshot({
        clip: { x: 675, y: 403, width: 20, height: 20 },
      });
      const { channels } = await sharp(bytes).stats();
      return channels[0].mean - channels[1].mean;
    };
    const off = await meanRed(false),
      on = await meanRed(true);
    assert.ok(
      on > off + 8,
      kind +
        ' must draw the shallow red earthquake footprint: ' +
        off +
        ' -> ' +
        on,
    );
    await strict.passed(page, 'earthquakes', 'shallow red footprint drawn', {
      off,
      on,
    });
    console.log(
      'PASS',
      kind,
      'earthquake footprint red minus green:',
      off,
      '->',
      on,
    );
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
      window.__quakeEntry =
        window.__godsEyeView.dataManager.layers.get('earthquakes');
      window.__quakeTimer = window.__quakeEntry.intervalId;
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
    await strict.pick(page, kind);
    await ready(kind);
    assert.ok(await page.evaluate(() => window.__switchDocument === document));
    assert.ok(
      await page.evaluate(() => {
        window.__switchObserver.disconnect();
        const { engine } = window.__godsEyeView;
        const previous = window.__renderers.get(engine.kind);
        return (
          !window.__switchSplash &&
          window.__quakeEntry ===
            window.__godsEyeView.dataManager.layers.get('earthquakes') &&
          window.__quakeTimer === window.__quakeEntry.intervalId &&
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
    await strict.passed(
      page,
      'earthquakes',
      'same layer entry, model and poll timer; no splash; outgoing canvas detached',
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
    await strict.passed(
      page,
      'earthquakes',
      'parked engine draws no frame; pose, map and layers carried over',
    );
  }
  await page.goto(base.href, { waitUntil: 'domcontentloaded' });
  await ready('cesium');
  await verifyQuakeSurface('cesium');
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
  await verifyQuakeSurface('navara');
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
  // The address carries the running layer set once its debounced write lands.
  const settledAddress = () =>
    page.evaluate(() => {
      window.__godsEyeView.styleManager.shareLinkManager.flush();
      return new URLSearchParams(location.hash.slice(1)).get('l');
    });
  const pick = async (kind) => {
    await strict.pick(page, kind);
    await ready(kind);
    await page.waitForFunction(
      () => !document.querySelector('.engine-switch-frame'),
    );
  };
  const visit = async (direction, kind) => {
    await (direction === 'back'
      ? page.goBack({ waitUntil: 'domcontentloaded' })
      : page.goForward());
    await ready(kind);
    await page.waitForFunction(
      () => !document.querySelector('.engine-switch-frame'),
    );
  };
  const quakes = () =>
    page.evaluate(() => {
      const { dataManager } = window.__godsEyeView;
      return {
        model: window.__quakeModel === dataManager.layers.get('earthquakes'),
        enabled: dataManager.getEnabledLayerIds().has('earthquakes'),
      };
    });
  // Like a same-engine Back, each entry brings back its own layer set, on
  // the same layer models.
  await page.evaluate(() => {
    window.__quakeModel =
      window.__godsEyeView.dataManager.layers.get('earthquakes');
  });
  const navaraLayers = await settledAddress();
  await pick('cesium');
  await page.evaluate(() =>
    window.__godsEyeView.dataManager.setEnabled('earthquakes', false, {
      origin: 'user',
    }),
  );
  const cesiumLayers = await settledAddress();
  assert.notEqual(cesiumLayers, navaraLayers);
  await visit('back', 'navara');
  assert.deepEqual(await quakes(), { model: true, enabled: true });
  await strict.passed(
    page,
    'earthquakes',
    'Back restores the enabled layer on the same model',
  );
  assert.equal(await settledAddress(), navaraLayers, 'Back keeps its entry');
  await visit('forward', 'cesium');
  assert.deepEqual(await quakes(), { model: true, enabled: false });
  await strict.passed(
    page,
    'earthquakes',
    'Forward restores the disabled layer on the same model',
  );
  assert.equal(await settledAddress(), cesiumLayers, 'Forward keeps its entry');
  await page.evaluate(() =>
    window.__godsEyeView.dataManager.setEnabled('earthquakes', true, {
      origin: 'user',
    }),
  );
  await pick('navara');
  console.log(
    "PASS Back/Forward restore each entry's layers on the same models",
  );
  // Back/Forward hand the session off like the picker: the Contacts subject
  // and its navigation history, its layers and the Director survive.
  await page.evaluate(async () => {
    const { dataManager, styleManager, sceneDirector } = window.__godsEyeView;
    await dataManager.setEnabled('ais-live-vessels', true, {
      origin: 'user',
    });
    const outcome = await styleManager.setContextMode('contacts');
    if (!outcome.ok) throw Error(JSON.stringify(outcome));
    window.qaSession = {
      director: sceneDirector,
      context: dataManager.layers.get('military-awareness').module,
      vessels: dataManager.layers.get('ais-live-vessels'),
    };
    if (!window.qaSession.vessels.module.selectById('123456789'))
      throw Error('Missing first vessel');
    if (
      !window.qaSession.context.navigateNext({
        targetLayer: 'ais-live-vessels',
      })
    )
      throw Error('Cannot navigate to the second vessel');
  });
  const session = () =>
    page.evaluate(() => {
      const { dataManager, styleManager, sceneDirector } = window.__godsEyeView;
      const { director, context, vessels } = window.qaSession;
      return {
        director: director === sceneDirector && !director._destroyed,
        owners:
          context === dataManager.layers.get('military-awareness').module &&
          vessels === dataManager.layers.get('ais-live-vessels'),
        mode: styleManager.getContextModeState().mode,
        subject: context.getContextSnapshot()?.subject?.id,
        history: context._getAwarenessNavigationStateForTest().historyKeys,
        enabled: [...dataManager.getEnabledLayerIds()].sort(),
      };
    });
  const live = await session();
  assert.equal(live.mode, 'flights');
  assert.equal(live.subject, '223456789');
  assert.ok(live.history.includes('ais-live-vessels:123456789'));
  await settledAddress();
  const historyLength = await page.evaluate(() => history.length);
  await pick('cesium');
  assert.deepEqual(await session(), live, 'a pick keeps the session');
  await settledAddress();
  await visit('back', 'navara');
  assert.deepEqual(await session(), live, 'Back keeps the session');
  await visit('forward', 'cesium');
  assert.deepEqual(await session(), live, 'Forward keeps the session');
  assert.equal(await page.evaluate(() => history.length), historyLength + 1);
  assert.ok(
    await page.evaluate(async () => {
      const { dataManager, styleManager } = window.__godsEyeView;
      const result = await styleManager.setContextMode('off');
      await dataManager.setEnabled('ais-live-vessels', false, {
        origin: 'user',
      });
      return result.ok;
    }),
  );
  await pick('navara');
  console.log(
    'PASS Back/Forward keep Contacts subject, history, layers and Director',
  );
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
  // Zooming out on the satellite map must keep the same inspection sun.
  assert.ok(
    await page.evaluate(async () => {
      const { engine } = window.__godsEyeView;
      engine.camera.zoomOut(2_000_000);
      await new Promise((resolve) => {
        const remove = engine.frames.postRender.addEventListener(() => {
          remove();
          resolve();
        });
        engine.render.request('qa-orbital-daylight');
      });
      return (
        engine.camera.height() > 1_500_000 &&
        engine.host.container.hasAttribute('data-terrain-daylight')
      );
    }),
    'the orbital frame keeps daylight on the inspected globe',
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
});
